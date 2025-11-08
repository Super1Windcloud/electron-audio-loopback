import WebSocket from "ws";

const DEFAULT_MODEL = "models/gemini-2.5-flash";
const DEFAULT_LANGUAGE = "zh-CN";
const DEFAULT_PROMPT =
	"你是一个高准确度的实时语音识别助手，请将输入语音逐字转写为对应语言的文字，不要输出解释或额外内容，只返回转写结果。";
const DEFAULT_FLUSH_INTERVAL_MS = 3500;
const MIN_FLUSH_INTERVAL_MS = 750;
const MAX_FLUSH_INTERVAL_MS = 8000;
const BYTES_PER_SAMPLE = 2;
const DEFAULT_GOOGLE_GENAI_API_BASE_URLS = [
	"https://generativelanguage.googleapis.com/v1beta",
	"https://generativelanguage.googleapis.com/v1",
	"https://generativelanguage.googleapis.com/v1alpha",
];
const DEFAULT_LIVE_WS_BASE_URL = "wss://generativelanguage.googleapis.com";
const DEFAULT_LIVE_API_VERSION = "v1alpha";
const LIVE_CONNECT_TIMEOUT_MS = 15000;

let googleGenaiModule = null;
let attemptedGoogleGenaiImport = false;
const listedModelsCache = new Map(); // baseUrl -> { timestamp, models }
const loggedBaseUrls = new Set();

const loadGoogleGenaiModule = async () => {
	if (attemptedGoogleGenaiImport) {
		return googleGenaiModule;
	}
	attemptedGoogleGenaiImport = true;
	try {
		googleGenaiModule = await import("@google/genai");
	} catch {
		googleGenaiModule = null;
	}
	return googleGenaiModule;
};

const clampFlushInterval = (value) => {
	if (!Number.isFinite(value)) {
		return DEFAULT_FLUSH_INTERVAL_MS;
	}
	if (value < MIN_FLUSH_INTERVAL_MS) return MIN_FLUSH_INTERVAL_MS;
	if (value > MAX_FLUSH_INTERVAL_MS) return MAX_FLUSH_INTERVAL_MS;
	return value;
};

const getFlushIntervalMs = () => {
	const raw =
		Number(process.env.GOOGLE_GENAI_FLUSH_INTERVAL_MS) ||
		Number(process.env.GOOGLE_GENAI_CHUNK_INTERVAL_MS);
	return clampFlushInterval(raw);
};

const getModelId = () =>
	process.env.GOOGLE_GENAI_MODEL?.trim?.() || DEFAULT_MODEL;

const getLanguageHint = () =>
	process.env.GOOGLE_GENAI_LANGUAGE?.trim?.() || DEFAULT_LANGUAGE;

const getPrompt = () =>
	process.env.GOOGLE_GENAI_PROMPT?.trim?.() || DEFAULT_PROMPT;

const getLiveWsBaseUrl = () =>
	process.env.GOOGLE_GENAI_LIVE_WS_BASE_URL?.trim?.() ||
	DEFAULT_LIVE_WS_BASE_URL;

const getLiveApiVersion = () =>
	process.env.GOOGLE_GENAI_LIVE_API_VERSION?.trim?.() ||
	DEFAULT_LIVE_API_VERSION;

const toMimeType = (encoding = "linear16", sampleRate = 16000) => {
	const normalized = encoding?.toString?.().toLowerCase?.() ?? "linear16";
	if (
		normalized === "linear16" ||
		normalized === "pcm16" ||
		normalized === "pcm_s16le"
	) {
		return `audio/raw;encoding=pcm16;rate=${sampleRate}`;
	}
	if (normalized === "flac") {
		return "audio/flac";
	}
	if (normalized === "mulaw" || normalized === "ulaw") {
		return `audio/ulaw;rate=${sampleRate}`;
	}
	return `audio/raw;rate=${sampleRate}`;
};

const collectTextFromParts = (parts) => {
	if (!Array.isArray(parts)) return "";
	return parts
		.map((part) => {
			if (typeof part === "string") return part;
			if (typeof part?.text === "string") return part.text;
			if (typeof part?.formattedText === "string") return part.formattedText;
			if (Array.isArray(part?.segments)) {
				return part.segments
					.map((segment) =>
						typeof segment?.text === "string" ? segment.text : "",
					)
					.filter(Boolean)
					.join(" ");
			}
			return "";
		})
		.filter(Boolean)
		.join(" ")
		.trim();
};

const shouldUseLiveApi = (modelId) => {
	const flag =
		process.env.GOOGLE_GENAI_USE_LIVE?.trim?.().toLowerCase?.() ?? "";
	if (flag === "1" || flag === "true" || flag === "yes") {
		return true;
	}
	if (flag === "0" || flag === "false" || flag === "no") {
		return false;
	}
	const normalized = modelId?.toLowerCase?.() ?? "";
	if (!normalized.length) return false;
	return (
		normalized.includes("live") ||
		normalized.includes("native-audio") ||
		normalized.includes("realtime")
	);
};

const buildLiveWebsocketUrl = (apiKey) => {
	const baseUrl = getLiveWsBaseUrl().replace(/\/+$/, "");
	const apiVersion = getLiveApiVersion();
	const isEphemeral = apiKey?.startsWith?.("auth_tokens/");
	const method = isEphemeral
		? "BidiGenerateContentConstrained"
		: "BidiGenerateContent";
	const keyName = isEphemeral ? "access_token" : "key";
	return `${baseUrl}/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.${method}?${keyName}=${encodeURIComponent(
		apiKey,
	)}`;
};

const buildLiveSetupMessage = ({
	modelId,
	prompt,
	languageHint,
	responseModalities = ["TEXT"],
}) => {
	const generationConfig = {
		responseModalities,
		temperature: 0,
		topK: 32,
		topP: 0.9,
	};

	const setup = {
		model: modelId,
		generationConfig,
		inputAudioTranscription: {},
		outputAudioTranscription: {},
	};

	const trimmedPrompt = prompt?.trim?.();
	if (trimmedPrompt) {
		const instruction = languageHint
			? `${trimmedPrompt}\n语言: ${languageHint}`.trim()
			: trimmedPrompt;
		setup.systemInstruction = {
			role: "system",
			parts: [{ text: instruction }],
		};
	}

	return { setup };
};

const createLiveRealtimeChunkMessage = (buffer, mimeType) => ({
	realtimeInput: {
		mediaChunks: [
			{
				data: buffer.toString("base64"),
				mimeType,
			},
		],
	},
});

const createLiveStreamEndMessage = () => ({
	realtimeInput: {
		audioStreamEnd: true,
	},
});

const extractTextFromResponse = (result) => {
	if (!result) return "";
	if (typeof result.text === "function") {
		const text = result.text();
		if (text) return text.trim();
	}

	const response = result.response ?? result;
	if (!response) return "";

	if (typeof response.text === "function") {
		const text = response.text();
		if (text) return text.trim();
	}

	const candidatesText = collectTextFromParts(
		response.candidates
			?.flatMap((candidate) => candidate?.content?.parts ?? candidate?.parts)
			?.filter(Boolean),
	);
	if (candidatesText) return candidatesText;

	const outputText = collectTextFromParts(
		response.output
			?.flatMap((item) => item?.content ?? item?.parts ?? [])
			?.filter(Boolean),
	);
	if (outputText) return outputText;

	const contentText = collectTextFromParts(
		response.contents?.flatMap((content) => content?.parts ?? []) ?? [],
	);
	if (contentText) return contentText;

	return "";
};

const toModelPath = (modelId) => {
	if (typeof modelId !== "string" || !modelId.length) {
		return DEFAULT_MODEL;
	}
	return modelId.startsWith("models/") ? modelId : `models/${modelId}`;
};

const getGoogleGenaiBaseUrls = () => {
	const override = process.env.GOOGLE_GENAI_API_BASE_URL?.trim?.();
	if (override) {
		return [override];
	}
	return DEFAULT_GOOGLE_GENAI_API_BASE_URLS;
};

const resolveBaseUrlsForModel = (modelId) => {
	const urls = getGoogleGenaiBaseUrls();
	if (typeof modelId === "string" && /preview/i.test(modelId)) {
		const preferred = urls.filter((url) => /\/v1(beta|alpha)/.test(url));
		if (preferred.length > 0) {
			return preferred;
		}
	}
	return urls;
};

const fetchModelList = async ({ apiKey, baseUrl }) => {
	const cacheEntry = listedModelsCache.get(baseUrl);
	if (cacheEntry && Date.now() - cacheEntry.timestamp < 5 * 60 * 1000) {
		return cacheEntry.models;
	}

	const endpoint = `${baseUrl.replace(/\/+$/, "")}/models`;
	const url = new URL(endpoint);
	url.searchParams.set("key", apiKey);

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Listing models failed with status ${response.status} (${await response.text()})`,
		);
	}

	const data = await response.json();
	const models = Array.isArray(data?.models) ? data.models : [];
	listedModelsCache.set(baseUrl, { timestamp: Date.now(), models });
	return models;
};

const ensureModelAvailability = async ({ apiKey, modelId, baseUrls }) => {
	const normalizedModel = toModelPath(modelId);
	const availableNames = new Set();
	let found = false;

	for (const baseUrl of baseUrls) {
		try {
			const models = await fetchModelList({ apiKey, baseUrl });
			const modelNames = models
				.map(
					(model) =>
						model?.name ||
						model?.displayName ||
						model?.id ||
						model?.model ||
						"",
				)
				.filter(Boolean);

			modelNames.forEach((name) => availableNames.add(name));

			if (!loggedBaseUrls.has(baseUrl) && modelNames.length > 0) {
				console.info(
					`[Google GenAI] Models visible via ${baseUrl}: ${modelNames.join(", ")}`,
				);
				loggedBaseUrls.add(baseUrl);
			}

			if (modelNames.includes(normalizedModel)) {
				found = true;
				break;
			}
		} catch (error) {
			console.warn(
				`[Google GenAI] Unable to list models from ${baseUrl}: ${
					error instanceof Error
						? error.message
						: String(error ?? "Unknown error")
				}`,
			);
		}
	}

	if (found || availableNames.size === 0) {
		return;
	}

	throw new Error(
		`Model "${normalizedModel}" is not available for the current API key. Visible models: ${[
			...availableNames,
		].join(", ")}`,
	);
};

const createHttpFallbackModel = ({
	apiKey,
	modelId,
	generationConfig,
	baseUrls,
}) => {
	const normalizedModel = toModelPath(modelId);
	const urls =
		Array.isArray(baseUrls) && baseUrls.length > 0
			? baseUrls
			: getGoogleGenaiBaseUrls();
	if (urls.length === 0) {
		throw new Error("No valid Google GenAI API base URLs configured.");
	}

	return {
		async generateContent(request = {}) {
			const payload = { ...request };
			const mergedGenerationConfig = {
				...(generationConfig ?? {}),
				...(request?.generationConfig ?? {}),
			};
			if (Object.keys(mergedGenerationConfig).length > 0) {
				payload.generationConfig = mergedGenerationConfig;
			}
			if (!Array.isArray(payload.contents)) {
				payload.contents = [];
			}

			let lastError;
			for (const baseUrl of urls) {
				const endpoint = `${baseUrl.replace(/\/+$/, "")}/${normalizedModel}:generateContent`;
				const url = new URL(endpoint);
				url.searchParams.set("key", apiKey);

				let response;
				try {
					response = await fetch(url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify(payload),
					});
				} catch (networkError) {
					lastError = new Error(
						`Failed to reach Google GenAI: ${
							networkError instanceof Error
								? networkError.message
								: String(networkError ?? "Unknown network error")
						}`,
					);
					continue;
				}

				if (!response.ok) {
					let errorBody;
					try {
						errorBody = await response.json();
					} catch {
						// Ignore parse errors; we'll surface status text instead.
					}

					const baseMessage = `Google GenAI request failed with status ${response.status}`;
					const detailedMessage =
						typeof errorBody?.error?.message === "string"
							? `${baseMessage}: ${errorBody.error.message}`
							: baseMessage;

					const error = new Error(detailedMessage);
					if (typeof errorBody?.error?.code !== "undefined") {
						error.code = errorBody.error.code;
					}
					if (typeof errorBody?.error?.status === "string") {
						error.status = errorBody.error.status;
					}

					const hasAlpha = urls.some((candidate) =>
						candidate.includes("/v1alpha"),
					);
					const hasPlainV1 = urls.some((candidate) => {
						const trimmed = candidate.replace(/\/+$/, "");
						return trimmed.endsWith("/v1");
					});
					const shouldRetry404 =
						response.status === 404 &&
						((baseUrl.includes("/v1beta") && (hasPlainV1 || hasAlpha)) ||
							(baseUrl.includes("/v1alpha") && hasPlainV1));

					if (shouldRetry404) {
						lastError = error;
						continue;
					}

					throw error;
				}

				try {
					return await response.json();
				} catch {
					lastError = new Error(
						"Failed to parse Google GenAI response payload.",
					);
				}
			}

			throw lastError ?? new Error("Google GenAI request failed.");
		},
	};
};

const instantiateModel = async ({ apiKey, modelId, generationConfig }) => {
	const baseUrls = resolveBaseUrlsForModel(modelId);
	await ensureModelAvailability({ apiKey, modelId, baseUrls });

	const GoogleGenAI = await loadGoogleGenaiModule();
	const { GoogleAI, GoogleGenerativeAI } = GoogleGenAI ?? {};
	if (typeof GoogleAI === "function") {
		try {
			const client =
				GoogleAI.length > 1 ? new GoogleAI({ apiKey }) : new GoogleAI(apiKey);
			if (typeof client.getGenerativeModel === "function") {
				return client.getGenerativeModel({ model: modelId, generationConfig });
			}
			if (client.responses?.generate) {
				return {
					async generateContent(request) {
						return client.responses.generate({
							model: modelId,
							generationConfig,
							...request,
						});
					},
				};
			}
		} catch {
			// Fall back to HTTP client below.
		}
	}

	if (typeof GoogleGenerativeAI === "function") {
		try {
			const client = new GoogleGenerativeAI(apiKey);
			if (typeof client.getGenerativeModel === "function") {
				return client.getGenerativeModel({ model: modelId, generationConfig });
			}
		} catch {
			// Fall back to HTTP client below.
		}
	}

	return createHttpFallbackModel({
		apiKey,
		modelId,
		generationConfig,
		baseUrls,
	});
};

const createLiveWebsocketSession = async ({
	apiKey,
	modelId,
	sampleRate,
	encoding,
	languageHint,
	prompt,
	onStatus,
	onTranscript,
	onError,
}) => {
	const url = buildLiveWebsocketUrl(apiKey);
	const mimeType = toMimeType(encoding, sampleRate);
	let ws;
	let closed = false;
	let connected = false;
	let lastInputTranscript = "";
	let lastModelTranscript = "";

	let setupResolved = false;
	let resolveSetup;
	let rejectSetup;
	const setupPromise = new Promise((resolve, reject) => {
		resolveSetup = resolve;
		rejectSetup = reject;
	});

	const settleSetup = (callback, value) => {
		if (setupResolved) {
			return;
		}
		setupResolved = true;
		callback(value);
	};

	const handleError = (error) => {
		const normalizedError =
			error instanceof Error ? error : new Error(String(error ?? "Unknown"));
		if (!setupResolved) {
			settleSetup(rejectSetup, normalizedError);
		}
		onError?.(normalizedError);
		if (!closed) {
			onStatus?.("error");
		}
	};

	const handleServerContent = (content) => {
		if (!content) return;
		const transcript = content.inputTranscription?.text?.trim?.() ?? "";
		const finished = Boolean(content.inputTranscription?.finished);
		if (transcript.length && transcript !== lastInputTranscript) {
			lastInputTranscript = transcript;
			onTranscript?.({
				text: transcript,
				isFinal: finished,
			});
			return;
		}

		const modelTurnText = collectTextFromParts(content.modelTurn?.parts ?? []);
		if (modelTurnText.length && modelTurnText !== lastModelTranscript) {
			lastModelTranscript = modelTurnText;
			onTranscript?.({
				text: modelTurnText,
				isFinal: Boolean(
					content.generationComplete ??
						content.turnComplete ??
						content.waitingForInput,
				),
			});
		}
	};

	const handleMessage = (raw) => {
		let payload;
		try {
			if (raw instanceof Buffer) {
				payload = JSON.parse(raw.toString("utf8"));
			} else if (typeof raw === "string") {
				payload = JSON.parse(raw);
			} else if (raw?.data) {
				payload = JSON.parse(raw.data);
			} else {
				payload = JSON.parse(Buffer.from(raw).toString("utf8"));
			}
		} catch (error) {
			handleError(
				new Error(
					`Failed to parse Google GenAI live response: ${
						error instanceof Error ? error.message : String(error)
					}`,
				),
			);
			return;
		}

		if (!connected && payload?.setupComplete) {
			connected = true;
			if (!setupResolved) {
				settleSetup(resolveSetup, undefined);
			}
			onStatus?.("connected");
		}

		if (payload?.serverContent) {
			handleServerContent(payload.serverContent);
		}

		if (payload?.usageMetadata) {
			lastModelTranscript = "";
		}
	};

	const connectPromise = new Promise((resolve, reject) => {
		try {
			ws = new WebSocket(url, {
				handshakeTimeout: LIVE_CONNECT_TIMEOUT_MS,
			});
		} catch (error) {
			reject(error);
			return;
		}

		ws.on("message", handleMessage);
		ws.on("error", handleError);
		ws.on("close", () => {
			if (!setupResolved) {
				settleSetup(
					rejectSetup,
					new Error("Live session closed before setup completed."),
				);
			}
			if (!closed) {
				closed = true;
				onStatus?.("closed");
			}
		});

		ws.once("open", () => {
			try {
				const setupMessage = buildLiveSetupMessage({
					modelId,
					prompt,
					languageHint,
					responseModalities: ["TEXT"],
				});
				ws.send(JSON.stringify(setupMessage));
				resolve(undefined);
			} catch (error) {
				reject(error);
			}
		});

		ws.once("error", (error) => {
			reject(error);
		});
	});

	try {
		await connectPromise;
	} catch (error) {
		await setupPromise.catch(() => {});
		throw error;
	}

	await setupPromise;

	return {
		sendAudio(chunk) {
			if (closed || !connected || ws.readyState !== WebSocket.OPEN) {
				return;
			}
			const buffer = normalizeChunk(chunk);
			if (!buffer.length) {
				return;
			}
			const message = createLiveRealtimeChunkMessage(buffer, mimeType);
			try {
				ws.send(JSON.stringify(message));
			} catch (error) {
				handleError(error);
			}
		},
		async stop() {
			if (closed) {
				return;
			}
			closed = true;
			if (ws.readyState === WebSocket.OPEN) {
				try {
					ws.send(JSON.stringify(createLiveStreamEndMessage()));
				} catch (error) {
					handleError(error);
				}
			}
			await new Promise((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) {
					resolve();
					return;
				}
				ws.once("close", resolve);
				setTimeout(resolve, 250);
				try {
					ws.close();
				} catch {}
			});
			onStatus?.("closed");
		},
	};
};

const normalizeChunk = (chunk) => {
	if (!chunk) return Buffer.alloc(0);
	if (chunk instanceof ArrayBuffer) {
		return Buffer.from(chunk);
	}
	if (Buffer.isBuffer(chunk)) {
		return chunk;
	}
	if (ArrayBuffer.isView(chunk)) {
		return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	}
	return Buffer.from(chunk);
};

export async function createGoogleGenaiSession({
	apiKey,
	sampleRate,
	channels = 1,
	encoding = "linear16",
	onStatus,
	onTranscript,
	onError,
}) {
	if (!apiKey) {
		throw new Error("Missing GOOGLE_GENAI_API_KEY.");
	}

	const normalizedSampleRate = Number.isFinite(sampleRate) ? sampleRate : 16000;
	const normalizedChannels =
		Number.isFinite(channels) && channels > 0 ? channels : 1;
	const modelId = getModelId();
	const languageHint = getLanguageHint();
	const prompt = getPrompt();

	if (shouldUseLiveApi(modelId)) {
		return await createLiveWebsocketSession({
			apiKey,
			modelId,
			sampleRate: normalizedSampleRate,
			encoding,
			languageHint,
			prompt,
			onStatus,
			onTranscript,
			onError,
		});
	}

	const flushIntervalMs = getFlushIntervalMs();
	const bytesPerSecond =
		normalizedSampleRate * normalizedChannels * BYTES_PER_SAMPLE;
	const minBytesPerFlush = Math.max(
		Math.round((flushIntervalMs / 1000) * bytesPerSecond),
		4096,
	);
	const mimeType = toMimeType(encoding, normalizedSampleRate);

	let audioBuffer = Buffer.alloc(0);
	let flushTimer = null;
	let closed = false;
	let stopping = false;
	let connected = false;
	let requestInFlight = false;
	let flushRequestedWhileBusy = false;
	let pendingRequest = null;
	let lastTranscript = "";

	let model;
	try {
		model = await instantiateModel({
			apiKey,
			modelId,
			generationConfig: {
				temperature: 0,
				topK: 32,
				topP: 0.9,
			},
		});
		if (typeof model?.generateContent !== "function") {
			throw new Error(
				"Current @google/genai client is missing generateContent().",
			);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to initialize Google GenAI client: ${reason}`);
	}

	const handleError = (error) => {
		const normalizedError =
			error instanceof Error
				? error
				: new Error(String(error ?? "Unknown Google GenAI error"));
		onError?.(normalizedError);
		onStatus?.("error");
	};

	const ensureConnected = () => {
		if (!connected) {
			connected = true;
			onStatus?.("connected");
		}
	};

	const scheduleFlush = () => {
		if (closed || stopping || flushTimer || audioBuffer.length === 0) {
			return;
		}
		flushTimer = setTimeout(() => {
			flushTimer = null;
			void flushBuffer();
		}, flushIntervalMs);
	};

	const flushBuffer = async ({ force = false, ignoreClosed = false } = {}) => {
		if ((closed || stopping) && !ignoreClosed && !force) {
			return;
		}

		if (requestInFlight) {
			flushRequestedWhileBusy =
				flushRequestedWhileBusy ||
				force ||
				audioBuffer.length >= minBytesPerFlush;
			if (pendingRequest) {
				try {
					await pendingRequest;
				} catch {
					// Error is already surfaced through handleError.
				}
			}
			return;
		}

		if (audioBuffer.length === 0) {
			return;
		}

		if (!force && audioBuffer.length < minBytesPerFlush) {
			scheduleFlush();
			return;
		}

		const chunk = audioBuffer;
		audioBuffer = Buffer.alloc(0);
		requestInFlight = true;

		const request = {
			contents: [
				{
					role: "user",
					parts: [
						{
							text: `${prompt}\n语言: ${languageHint}`,
						},
						{
							inlineData: {
								mimeType,
								data: chunk.toString("base64"),
							},
						},
					],
				},
			],
		};

		try {
			pendingRequest = model.generateContent(request);
			const result = await pendingRequest;
			ensureConnected();
			const text = extractTextFromResponse(result);
			if (text && text !== lastTranscript) {
				lastTranscript = text;
				onTranscript?.({
					text,
					isFinal: true,
				});
			}
		} catch (error) {
			handleError(error);
		} finally {
			pendingRequest = null;
			requestInFlight = false;
			if (!stopping && !closed) {
				if (flushRequestedWhileBusy || audioBuffer.length >= minBytesPerFlush) {
					flushRequestedWhileBusy = false;
					void flushBuffer({ force: true });
				} else {
					scheduleFlush();
				}
			}
		}
	};

	return {
		sendAudio(chunk) {
			if (closed) {
				return;
			}
			const buffer = normalizeChunk(chunk);
			if (!buffer.length) {
				return;
			}
			audioBuffer = Buffer.concat([audioBuffer, buffer]);
			if (audioBuffer.length >= minBytesPerFlush) {
				void flushBuffer();
			} else {
				scheduleFlush();
			}
		},
		async stop() {
			if (closed) {
				return;
			}

			stopping = true;
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}

			await flushBuffer({ force: true, ignoreClosed: true });

			if (pendingRequest) {
				try {
					await pendingRequest;
				} catch {
					// Error already reported.
				}
			}

			closed = true;
			if (connected) {
				onStatus?.("closed");
			}
		},
	};
}
