import { createSpeechmaticsJWT } from "@speechmatics/auth";
import { RealtimeClient } from "@speechmatics/real-time-client";

const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 48000;
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_LANGUAGE = "en";
const DEFAULT_OPERATING_POINT = "enhanced";
const DEFAULT_JWT_TTL = 60;
const STOP_TIMEOUT_MS = 5000;
const RAW_ENCODING = "pcm_s16le";

const clampSampleRate = (value) => {
	const numeric = Number.isFinite(value) ? value : DEFAULT_SAMPLE_RATE;
	if (numeric < MIN_SAMPLE_RATE) return MIN_SAMPLE_RATE;
	if (numeric > MAX_SAMPLE_RATE) return MAX_SAMPLE_RATE;
	return numeric;
};

const getLanguage = () =>
	process.env.SPEECHMATICS_LANGUAGE?.trim?.() || DEFAULT_LANGUAGE;

const getOperatingPoint = () =>
	process.env.SPEECHMATICS_OPERATING_POINT?.trim?.() ||
	DEFAULT_OPERATING_POINT;

const getJwtTtl = () => {
	const numeric = Number(process.env.SPEECHMATICS_JWT_TTL);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_JWT_TTL;
};

const getRegion = () =>
	process.env.SPEECHMATICS_REGION?.trim?.().toLowerCase() || undefined;

const getRealtimeUrl = () =>
	process.env.SPEECHMATICS_REALTIME_URL?.trim?.() || undefined;

const resultsToText = (results = []) => {
	let buffer = "";
	for (const result of results) {
		const content = result?.alternatives?.[0]?.content ?? "";
		if (!content.length) continue;
		if (result?.type === "word" && buffer.length && !buffer.endsWith(" ")) {
			buffer += " ";
		}
		buffer += content;
	}
	return buffer.trim();
};

const isResultFinal = (message, data) => {
	if (message === "AddTranscript") return true;
	if (message === "AddPartialTranscript") return false;
	if (typeof data?.metadata?.transcript === "string") {
		return data.metadata.transcript === "final";
	}
	if (typeof data?.metadata?.is_final === "boolean") {
		return data.metadata.is_final;
	}
	return Boolean(data?.results?.some((result) => result?.is_eos || result?.is_final));
};

/**
 * Create a Speechmatics real-time transcription session.
 * @param {Object} params
 * @param {string} params.apiKey Speechmatics API key
 * @param {number} params.sampleRate Audio sample rate
 * @param {number} params.channels Channel count
 * @param {(status: string) => void} params.onStatus Status callback
 * @param {(payload: {text: string; isFinal: boolean}) => void} params.onTranscript Transcript callback
 * @param {(error: Error) => void} params.onError Error callback
 */
export async function createSpeechmaticsSession({
	apiKey,
	sampleRate,
	channels = 1,
	onStatus,
	onTranscript,
	onError,
}) {
	if (!apiKey) {
		throw new Error("Missing SPEECHMATICS_API_KEY.");
	}

	const normalizedSampleRate = clampSampleRate(Number(sampleRate));
	const normalizedChannels = Math.max(1, Number.isFinite(channels) ? channels : 1);

	const jwt = await createSpeechmaticsJWT({
		type: "rt",
		apiKey,
		ttl: getJwtTtl(),
		region: getRegion(),
	});

	const realtimeUrl = getRealtimeUrl();
	const client = new RealtimeClient(
		realtimeUrl
			? {
					url: realtimeUrl,
			  }
			: undefined,
	);

	let closed = false;
	let listenersBound = false;

	const handleError = (error) => {
		const normalizedError =
			error instanceof Error ? error : new Error(String(error ?? "Unknown error"));
		onError?.(normalizedError);
		onStatus?.("error");
		closed = true;
		cleanup();
	};

	const handleSocketStateChange = (event) => {
		switch (event?.socketState) {
			case "open":
				onStatus?.("connected");
				break;
			case "closing":
			case "closed":
				if (!closed) {
					closed = true;
					onStatus?.("closed");
					cleanup();
				}
				break;
			default:
				break;
		}
	};

	const handleReceiveMessage = ({ data }) => {
		if (!data?.message) {
			return;
		}

		switch (data.message) {
			case "AddPartialTranscript":
			case "AddTranscript": {
				const text = resultsToText(data.results);
				if (!text.length) return;
				onTranscript?.({
					text,
					isFinal: isResultFinal(data.message, data),
				});
				break;
			}
			case "EndOfTranscript":
				onStatus?.("closed");
				closed = true;
				cleanup();
				break;
			case "Error":
				handleError(
					new Error(
						data?.reason
							? `Speechmatics error: ${data.reason}`
							: "Speechmatics error",
					),
				);
				break;
			default:
				break;
		}
	};

	const cleanup = () => {
		if (!listenersBound) return;
		listenersBound = false;
		client.removeEventListener?.("receiveMessage", handleReceiveMessage);
		client.removeEventListener?.("socketStateChange", handleSocketStateChange);
	};

	client.addEventListener("receiveMessage", handleReceiveMessage);
	client.addEventListener("socketStateChange", handleSocketStateChange);
	listenersBound = true;

	try {
		onStatus?.("connecting");
		await client.start(jwt, {
			audio_format: {
				type: "raw",
				encoding: RAW_ENCODING,
				sample_rate: normalizedSampleRate,
			},
			transcription_config: {
				language: getLanguage(),
				operating_point: getOperatingPoint(),
				max_delay: 1.0,
				enable_partials: true,
				transcript_filtering_config: {
					remove_disfluencies: true,
				},
				conversation_config:
					normalizedChannels > 1
						? {
								end_of_utterance_silence_trigger: 0.3,
						  }
						: undefined,
			},
		});
	} catch (error) {
		cleanup();
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to start Speechmatics session: ${reason}`);
	}

	return {
		sendAudio(chunk) {
			if (!chunk || closed) {
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

			try {
				client.sendAudio(buffer);
			} catch (error) {
				handleError(error);
			}
		},
		async stop() {
			if (closed) {
				return;
			}

			await new Promise((resolve) => {
				const timeout = setTimeout(() => {
					closed = true;
					cleanup();
					resolve();
				}, STOP_TIMEOUT_MS);

				const finalize = () => {
					clearTimeout(timeout);
					closed = true;
					cleanup();
					resolve();
				};

				client
					.stopRecognition({ noTimeout: true })
					.then(finalize)
					.catch(() => finalize());
			});
		},
	};
}
