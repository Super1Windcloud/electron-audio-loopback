import {
	AudioConfig,
	RevAiApiDeployment,
	RevAiApiDeploymentConfigMap,
	RevAiStreamingClient,
	SessionConfig,
} from "revai-node-sdk";

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 48000;
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_LANGUAGE = "en";
const DEFAULT_LAYOUT = "interleaved";
const DEFAULT_FORMAT = "S16LE";
const STOP_TIMEOUT_MS = 5000;
const REVAI_FINAL_TYPE = "final";
const REVAI_PARTIAL_TYPE = "partial";

const clampSampleRate = (value) => {
	const numeric = Number.isFinite(value) ? value : DEFAULT_SAMPLE_RATE;
	if (numeric < MIN_SAMPLE_RATE) return MIN_SAMPLE_RATE;
	if (numeric > MAX_SAMPLE_RATE) return MAX_SAMPLE_RATE;
	return numeric;
};

const normalizeChannels = (channels) => {
	const numeric = Number.isFinite(channels) ? channels : DEFAULT_CHANNELS;
	return Math.max(DEFAULT_CHANNELS, Math.min(10, numeric));
};

const resolveDeployment = () => {
	const raw =
		process.env.REVAI_REGION ||
		process.env.REVAI_DEPLOYMENT ||
		process.env.REVAI_LOCATION ||
		"";
	const normalized = raw.trim().toLowerCase();
	if (normalized === "eu" || normalized === "eu-west" || normalized === "eu1") {
		return RevAiApiDeployment.EU;
	}
	if (normalized === "us" || normalized === "us-west" || normalized === "us1") {
		return RevAiApiDeployment.US;
	}
	return undefined;
};

const buildSessionConfig = () => {
	const sessionConfig = new SessionConfig();
	sessionConfig.language =
		process.env.REVAI_LANGUAGE?.trim?.() || DEFAULT_LANGUAGE;
	sessionConfig.detailedPartials = true;
	return sessionConfig;
};

const extractTextFromElements = (elements) => {
	if (!Array.isArray(elements)) {
		return "";
	}

	return elements
		.map((element) =>
			element && typeof element.value === "string" ? element.value : "",
		)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
};

/**
 * Create a Rev.ai live transcription session.
 * @param {Object} params
 * @param {string} params.apiKey Rev.ai access token
 * @param {number} params.sampleRate Audio sample rate
 * @param {number} params.channels Number of channels
 * @param {(status: string) => void} params.onStatus Status callback
 * @param {(payload: {text: string; isFinal: boolean}) => void} params.onTranscript Transcript callback
 * @param {(error: Error) => void} params.onError Error callback
 */
export async function createRevaiSession({
	apiKey,
	sampleRate,
	channels = DEFAULT_CHANNELS,
	onStatus,
	onTranscript,
	onError,
}) {
	if (!apiKey) {
		throw new Error("Missing REVAI_ACCESS_TOKEN.");
	}

	const normalizedSampleRate = clampSampleRate(Number(sampleRate));
	const normalizedChannels = normalizeChannels(channels);
	const audioConfig = new AudioConfig(
		"audio/x-raw",
		DEFAULT_LAYOUT,
		normalizedSampleRate,
		DEFAULT_FORMAT,
		normalizedChannels,
	);

	const deployment = resolveDeployment();
	const clientOptions = deployment
		? {
				token: apiKey,
				deploymentConfig: RevAiApiDeploymentConfigMap.get(deployment),
			}
		: apiKey;

	const streamingClient = new RevAiStreamingClient(clientOptions, audioConfig);
	const sessionConfig = buildSessionConfig();

	let stream;
	try {
		stream = streamingClient.start(sessionConfig);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to start Rev.ai streaming session: ${reason}`);
	}

	let streamClosed = false;

	function handleHypothesis(data) {
		if (!data || typeof data !== "object") {
			return;
		}
		const { type, elements } = data;
		if (type !== REVAI_FINAL_TYPE && type !== REVAI_PARTIAL_TYPE) {
			return;
		}

		const text = extractTextFromElements(elements);
		if (!text.length) {
			return;
		}

		onTranscript?.({
			text,
			isFinal: type === REVAI_FINAL_TYPE,
		});
	}

	function handleStreamEnd() {
		streamClosed = true;
		cleanupListeners();
	}

	function handleClientConnect() {
		onStatus?.("connected");
	}

	function handleClientClose() {
		streamClosed = true;
		onStatus?.("closed");
		cleanupListeners();
	}

	function handleClientConnectFailed(error) {
		handleStreamError(error);
	}

	function handleHttpResponse(statusCode) {
		handleStreamError(
			new Error(`Rev.ai streaming HTTP response: ${statusCode}`),
		);
	}

	let listenersCleaned = false;

	function cleanupListeners() {
		if (listenersCleaned) return;
		listenersCleaned = true;
		stream?.removeListener?.("data", handleHypothesis);
		stream?.removeListener?.("error", handleStreamError);
		stream?.removeListener?.("end", handleStreamEnd);
		streamingClient?.removeListener?.("connect", handleClientConnect);
		streamingClient?.removeListener?.("close", handleClientClose);
		streamingClient?.removeListener?.("error", handleStreamError);
		streamingClient?.removeListener?.(
			"connectFailed",
			handleClientConnectFailed,
		);
		streamingClient?.removeListener?.("httpResponse", handleHttpResponse);
	}

	function handleStreamError(error) {
		onError?.(
			error instanceof Error
				? error
				: new Error(String(error ?? "Unknown error")),
		);
		streamClosed = true;
		onStatus?.("error");
		cleanupListeners();
	}

	stream.on("data", handleHypothesis);
	stream.on("error", handleStreamError);
	stream.on("end", handleStreamEnd);

	streamingClient.on("connect", handleClientConnect);
	streamingClient.on("close", handleClientClose);
	streamingClient.on("error", handleStreamError);
	streamingClient.on("connectFailed", handleClientConnectFailed);
	streamingClient.on("httpResponse", handleHttpResponse);

	return {
		sendAudio(chunk) {
			if (!chunk || streamClosed) {
				return;
			}
			const buffer =
				chunk instanceof ArrayBuffer
					? Buffer.from(chunk)
					: Buffer.isBuffer(chunk)
						? chunk
						: ArrayBuffer.isView(chunk)
							? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
							: Buffer.from(chunk);

			if (buffer.length === 0) {
				return;
			}

			if (!stream.writableEnded) {
				stream.write(buffer);
			}
		},
		async stop() {
			if (streamClosed) {
				cleanupListeners();
				return;
			}

			await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					streamClosed = true;
					cleanupListeners();
					resolve();
				}, STOP_TIMEOUT_MS);

				const resolveOnce = () => {
					clearTimeout(timeout);
					streamClosed = true;
					streamingClient.off("error", rejectOnce);
					cleanupListeners();
					resolve();
				};

				const rejectOnce = (error) => {
					clearTimeout(timeout);
					streamingClient.off("close", resolveOnce);
					cleanupListeners();
					reject(
						error instanceof Error
							? error
							: new Error(String(error ?? "Unknown error")),
					);
				};

				streamingClient.once("close", resolveOnce);
				streamingClient.once("error", rejectOnce);

				try {
					streamingClient.end();
				} catch (error) {
					rejectOnce(error);
				}
			});
		},
	};
}
