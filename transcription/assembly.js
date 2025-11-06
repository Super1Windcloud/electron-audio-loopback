import {StreamingTranscriber} from "assemblyai";

/**
 * Create an AssemblyAI streaming session for Electron audio capture.
 * @param {Object} params
 * @param {string} params.apiKey AssemblyAI API key
 * @param {number} params.sampleRate Audio sample rate
 * @param {string} params.encoding Audio encoding
 * @param {(status: string) => void} params.onStatus Status callback
 * @param {(payload: {text: string; isFinal: boolean}) => void} params.onTranscript Transcript callback
 * @param {(error: Error) => void} params.onError Error callback
 */
export async function createAssemblyStreamingSession({
                                                         apiKey,
                                                         sampleRate,
                                                         encoding = "pcm_s16le",
                                                         onStatus,
                                                         onTranscript,
                                                         onError,
                                                     }) {
    if (!apiKey) {
        throw new Error("Missing ASSEMBLYAI_API_KEY.");
    }

    const transcriber = new StreamingTranscriber({
        apiKey,
        sampleRate,
        encoding,
        languageCode: "zh",
        speechModel: "universal-streaming-multilingual",
        formatTurns: false,
    });

    transcriber.on("open", () => {
        onStatus?.("connected");
    });

    transcriber.on("turn", (event) => {
        const rawTranscript =
            typeof event?.transcript === "string"
                ? event.transcript
                : (event?.transcript?.text ?? event?.transcript?.display_text ?? "");
        const text = rawTranscript?.toString?.().trim?.() ?? "";
        if (!text.length) return;
        onTranscript?.({text, isFinal: Boolean(event.end_of_turn)});
    });

    transcriber.on("error", (error) => {
        onError?.(error);
        onStatus?.("error");
    });

    transcriber.on("close", () => {
        onStatus?.("closed");
    });

    await transcriber.connect();

    return {
        sendAudio(chunk) {
            if (!chunk || !chunk.length) return;
            transcriber.sendAudio(chunk);
        },
        async stop() {
            await transcriber.close(true);
        },
    };
}
