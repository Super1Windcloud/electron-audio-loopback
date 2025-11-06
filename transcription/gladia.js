import { GladiaClient } from "@gladiaio/sdk";

const SUPPORTED_SAMPLE_RATES = [8000, 16000, 32000, 44100, 48000];
const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_LANGUAGE = "zh";
const GLADIA_PCM_ENCODING = "wav/pcm";
const PCM_BIT_DEPTH = 16;
const COMPRESSED_BIT_DEPTH = 8;
const STOP_TIMEOUT_MS = 5000;
const DEFAULT_HTTP_TIMEOUT = 20000;
const DEFAULT_WS_TIMEOUT = 20000;
const MAX_HTTP_ATTEMPTS = 3;
const MAX_WS_ATTEMPTS = 5;

const normalizeSampleRate = (requested) => {
	if (!requested || Number.isNaN(requested)) {
		return DEFAULT_SAMPLE_RATE;
	}

	if (SUPPORTED_SAMPLE_RATES.includes(requested)) {
		return requested;
	}

	return (
		SUPPORTED_SAMPLE_RATES.reduce((closest, option) => {
			const currentDelta = Math.abs(option - requested);
			const bestDelta = Math.abs(closest - requested);
			return currentDelta < bestDelta ? option : closest;
		}, SUPPORTED_SAMPLE_RATES[0]) ?? DEFAULT_SAMPLE_RATE
	);
};

const normalizeEncoding = (encoding) => {
	if (typeof encoding !== "string") {
		return GLADIA_PCM_ENCODING;
	}

	const lowered = encoding.toLowerCase();
	if (lowered.includes("alaw")) return "wav/alaw";
	if (lowered.includes("ulaw") || lowered.includes("mulaw")) return "wav/ulaw";
	return GLADIA_PCM_ENCODING;
};

const resolveBitDepth = (encoding) =>
	encoding === GLADIA_PCM_ENCODING ? PCM_BIT_DEPTH : COMPRESSED_BIT_DEPTH;

const parseTimeoutEnv = (value, fallback) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseRegion = (value) => {
	const normalized = value?.toString?.().trim?.().toLowerCase() ?? "";
	if (normalized === "eu-west" || normalized === "us-west") {
		return normalized;
	}
	return undefined;
};

const buildGladiaClientOptions = (apiKey) => {
	const httpTimeout = parseTimeoutEnv(
		process.env.GLADIA_HTTP_TIMEOUT,
		DEFAULT_HTTP_TIMEOUT,
	);
	const wsTimeout = parseTimeoutEnv(
		process.env.GLADIA_WS_TIMEOUT,
		DEFAULT_WS_TIMEOUT,
	);

	return {
		apiKey,
		region: parseRegion(process.env.GLADIA_REGION),
		httpTimeout,
		wsTimeout,
		httpRetry: {
			maxAttempts: MAX_HTTP_ATTEMPTS,
		},
		wsRetry: {
			maxAttemptsPerConnection: MAX_WS_ATTEMPTS,
		},
	};
};

/**
 * Create a Gladia live transcription session.
 * @param {Object} params
 * @param {string} params.apiKey Gladia API key
 * @param {number} params.sampleRate Audio sample rate
 * @param {number} params.channels Number of audio channels
 * @param {string} params.encoding Audio encoding
 * @param {(status: string) => void} params.onStatus Status callback
 * @param {(payload: {text: string; isFinal: boolean}) => void} params.onTranscript Transcript callback
 * @param {(error: Error) => void} params.onError Error callback
 * @returns {Promise<{sendAudio: (chunk: Buffer | ArrayBuffer | ArrayLike<number>) => void; stop: () => Promise<void>}>}
 */
export async function createGladiaSession({
	apiKey,
	sampleRate,
	channels = 1,
	encoding,
	onStatus,
	onTranscript,
	onError,
}) {
	if (!apiKey) {
		throw new Error("Missing GLADIA_API_KEY.");
	}

	const gladiaClient = new GladiaClient(buildGladiaClientOptions(apiKey));
	const normalizedSampleRate = normalizeSampleRate(Number(sampleRate));
	const normalizedEncoding = normalizeEncoding(encoding);
	const normalizedChannels = Math.max(1, Number.isFinite(channels) ? channels : 1);

	let session;
	try {
		session = await gladiaClient.liveV2().startSession({
			encoding: normalizedEncoding,
			bit_depth: resolveBitDepth(normalizedEncoding),
			sample_rate: normalizedSampleRate,
			channels: normalizedChannels,
			language_config: {
				languages: [DEFAULT_LANGUAGE],
			},
			messages_config: {
				receive_partial_transcripts: true,
				receive_final_transcripts: true,
				receive_errors: true,
				receive_lifecycle_events: true,
			},
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to start Gladia live session: ${reason}`);
	}

	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) return;
		cleanedUp = true;
		session.off("connecting", handleConnecting);
		session.off("connected", handleConnected);
		session.off("ending", handleEnding);
		session.off("ended", handleEnded);
		session.off("message", handleMessage);
		session.off("error", handleError);
	};

	const handleConnecting = () => {
		onStatus?.("connecting");
	};

	const handleConnected = () => {
		onStatus?.("connected");
	};

	const handleEnding = () => {
		onStatus?.("stopped");
	};

	const handleEnded = () => {
		onStatus?.("closed");
		cleanup();
	};

	const handleError = (error) => {
		const normalizedError =
			error instanceof Error ? error : new Error(String(error ?? "Unknown error"));
		onError?.(normalizedError);
		onStatus?.("error");
		cleanup();
	};

	const handleMessage = (message) => {
		if (!message || message.type !== "transcript") {
			return;
		}

		const rawText = message.data?.utterance?.text ?? "";
		const text = typeof rawText === "string" ? rawText.trim() : "";
		if (!text.length) {
			return;
		}

		onTranscript?.({
			text,
			isFinal: Boolean(message.data?.is_final),
		});
	};

	session.on("connecting", handleConnecting);
	session.on("connected", handleConnected);
	session.on("ending", handleEnding);
	session.on("ended", handleEnded);
	session.on("message", handleMessage);
	session.on("error", handleError);

	return {
		sendAudio(chunk) {
			if (!chunk) return;
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

			session.sendAudio(buffer);
		},
		async stop() {
			await new Promise((resolve) => {
				const timeout = setTimeout(() => {
					session.off("ended", onEndedOnce);
					session.off("error", onErrorOnce);
					cleanup();
					resolve();
				}, STOP_TIMEOUT_MS);

				const finalize = () => {
					clearTimeout(timeout);
					session.off("ended", onEndedOnce);
					session.off("error", onErrorOnce);
					cleanup();
					resolve();
				};

				const onEndedOnce = () => {
					finalize();
				};

				const onErrorOnce = () => {
					finalize();
				};

				session.once("ended", onEndedOnce);
				session.once("error", onErrorOnce);

				try {
					session.stopRecording();
				} catch (stopError) {
					clearTimeout(timeout);
					session.off("ended", onEndedOnce);
					session.off("error", onErrorOnce);
					cleanup();
					throw stopError;
				}
			});
		},
	};
}
