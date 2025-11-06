import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";

/**
 * Create a Deepgram live transcription session.
 * @param {Object} params
 * @param {string} params.apiKey Deepgram API key
 * @param {number} params.sampleRate Audio sample rate
 * @param {number} params.channels Number of channels
 * @param {string} params.encoding Audio encoding
 * @param {(status: string) => void} params.onStatus Status callback
 * @param {(payload: {text: string; isFinal: boolean}) => void} params.onTranscript Transcript callback
 * @param {(error: Error) => void} params.onError Error callback
 */
export function createDeepgramSession({
	apiKey,
	sampleRate,
	channels,
	encoding,
	onStatus,
	onTranscript,
	onError,
}) {
	if (!apiKey) {
		throw new Error("Missing DEEPGRAM_API_KEY.");
	}

	const client = createClient(apiKey);
	let connection;

	try {
		connection = client.listen.live({
			model: "nova-2",
			encoding,
			sample_rate: sampleRate,
			channels,
            language: "zh",
            interim_results: true,
            smart_format: true,
        });
	} catch (error) {
		throw new Error(`Failed to create Deepgram live session: ${error.message}`);
	}

	const cleanup = () => {
		connection?.removeAllListeners?.();
	};

	connection.on(LiveTranscriptionEvents.Open, () => {
		onStatus?.("connected");
	});

	connection.on(LiveTranscriptionEvents.Transcript, (data) => {
		const alternative = data?.channel?.alternatives?.[0];
		const text = alternative?.transcript?.trim() ?? "";
		if (!text.length) return;

		const isFinal = Boolean(
			data?.is_final || data?.speech_final || data?.from_finalize,
		);
		onTranscript?.({ text, isFinal });
	});

	connection.on(LiveTranscriptionEvents.Error, (error) => {
		onError?.(error);
		onStatus?.("error");
	});

	connection.on(LiveTranscriptionEvents.Close, () => {
		onStatus?.("closed");
		cleanup();
	});

	return {
		sendAudio(chunk) {
			if (!chunk || !chunk.length) return;
			connection?.send(chunk);
		},
		async stop() {
			try {
				connection?.finalize();
				connection?.disconnect();
			} finally {
				cleanup();
			}
		},
	};
}
