import RecallAiSdk from "@recallai/desktop-sdk";

let recallRecordingActive = false;
let recallWindowId = null;
let realtimeHandlers = null;
let recallSdkInitialized = false;

const RECALL_REALTIME_EVENT = "transcript.data";
const SHOULD_DEBUG_RECALL = process.env.DEBUG_RECALL === "1";

const providerMap = {
    assembly: "assembly_ai_v3_streaming",
    deepgram: "deepgram_streaming",
};

const providerDefaults = {
    assembly_ai_v3_streaming: {
        language_code: "zh",
        speech_model: "universal-streaming-multilingual",
    },
    deepgram_streaming: {
        language: "zh",
    },
};

const debugRecall = (...args) => {
    if (SHOULD_DEBUG_RECALL) {
        console.warn("[Recall]", ...args);
    }
};

function emitRealtimeStatus(status) {
    debugRecall("status", status);
    realtimeHandlers?.onStatus?.(status);
}

function emitRealtimeError(error) {
    if (!(error instanceof Error)) {
        // eslint-disable-next-line unicorn/error-message
        error = new Error(
            typeof error === "string" ? error : "Unknown Recall error",
        );
    }
    realtimeHandlers?.onError?.(error);
    debugRecall("error", error);
}

function normalizeRealtimeTranscript(payload) {
    if (!payload) {
        return null;
    }

    const eventType =
        payload.event ??
        payload.type ??
        payload.event_type ??
        payload.data?.event ??
        payload.data?.type ??
        null;

    if (eventType !== RECALL_REALTIME_EVENT) {
        debugRecall("ignored realtime event", payload);
        return null;
    }

    const data =
        payload.data && typeof payload.data === "object" ? payload.data : payload;

    const nestedData =
        data.data && typeof data.data === "object" ? data.data : undefined;

    const extractWords = (words) => {
        if (!Array.isArray(words)) return "";
        const parts = words
            .map((word) => {
                if (typeof word === "string") return word;
                if (!word || typeof word !== "object") return "";
                return (
                    word.text ||
                    word.word ||
                    word.transcript ||
                    word.display_text ||
                    ""
                ).trim();
            })
            .filter((value) => value.length > 0);
        return parts.join(" ").trim();
    };

    const textCandidates = [
        data.transcript?.text,
        data.transcript,
        data.text,
        data.transcript_text,
        data.message,
        data.alternatives?.[0]?.transcript,
        data.sentences?.[0]?.text,
        nestedData?.text,
        nestedData?.transcript,
        nestedData?.message,
        extractWords(nestedData?.words),
    ];

    const text = textCandidates.find(
        (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
    );

    if (!text) return null;

    const finalFlags = [
        data.is_final,
        data.final,
        data.type === "transcript.final",
        data.status === "final",
        data.transcript_type === "final",
        data.completed === true,
        nestedData?.is_final,
        nestedData?.final,
        nestedData?.transcript_type === "final",
        nestedData?.status === "final",
        Array.isArray(nestedData?.words) &&
        nestedData.words.length > 0 &&
        nestedData.words.every((word) =>
            typeof word?.word_is_final === "boolean"
                ? word.word_is_final
                : word?.is_final === true,
        ),
    ];

    return {
        text: text.trim(),
        isFinal: finalFlags.some(Boolean),
        raw: data,
    };
}

RecallAiSdk.addEventListener("realtime-event", (payload) => {
    debugRecall("realtime-event", payload);
    const normalized = normalizeRealtimeTranscript(payload);
    if (!normalized) return;
    realtimeHandlers?.onTranscript?.(normalized);
});

RecallAiSdk.addEventListener("recording-started", () => {
    debugRecall("recording-started");
    emitRealtimeStatus("connected");
});

RecallAiSdk.addEventListener("recording-ended", () => {
    debugRecall("recording-ended");
    emitRealtimeStatus("closed");
});

RecallAiSdk.addEventListener("error", (event) => {
    const message = event?.message ?? "Recall SDK error";
    emitRealtimeError(new Error(message));
});

export function setRecallRealtimeHandlers(handlers) {
    realtimeHandlers = handlers;
}

async function ensureRecallSdkInitialized(options = {}) {
    if (recallSdkInitialized) {
        return;
    }
    await RecallAiSdk.init(options);
    recallSdkInitialized = true;
}

async function requestUploadTokenViaRecallApi({
                                                  apiKey,
                                                  region,
                                                  providerKey,
                                                  providerOptions = {},
                                                  recordingConfigOverrides = {},
                                              }) {
    if (!apiKey || !region) {
        throw new Error(
            "Missing Recall API key or region. Set RECALL_API_KEY and RECALL_REGION.",
        );
    }

    const url = `https://${region}.recall.ai/api/v1/sdk_upload/`;
    const recordingConfig = {
        transcript: {
            provider: {
                [providerKey]: providerOptions,
            },
        },
        realtime_endpoints: [
            {
                type: "desktop_sdk_callback",
                events: [RECALL_REALTIME_EVENT],
            },
        ],
        ...recordingConfigOverrides,
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            Authorization: apiKey,
        },
        body: JSON.stringify({recording_config: recordingConfig}),
    });

    if (!response.ok) {
        const errorPayload = await response.text();
        throw new Error(
            `Failed to create Recall SDK upload. ${response.status} ${response.statusText} - ${errorPayload}`,
        );
    }

    const payload = await response.json();
    if (!payload?.upload_token) {
        throw new Error("Recall SDK upload response missing upload_token.");
    }

    return payload.upload_token;
}

async function requestUploadTokenFromBackend({
                                                 clientToken,
                                                 backendUrl,
                                                 transcriptionProvider,
                                                 providerOptions,
                                             }) {
    if (!clientToken) {
        throw new Error(
            "Recall client token is required when using a custom backend.",
        );
    }

    const response = await fetch(`${backendUrl || "/api"}/create_sdk_recording`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${clientToken}`,
        },
        body: JSON.stringify({transcriptionProvider, providerOptions}),
    });

    if (!response.ok) {
        throw new Error(
            `Failed to create recording: ${response.status} ${response.statusText}`,
        );
    }

    const payload = await response.json();
    if (!payload?.upload_token) {
        throw new Error("Backend response missing upload_token.");
    }

    return payload.upload_token;
}

export async function startRecallRecording(options = {}) {
    const {
        clientToken,
        backendUrl = null,
        transcriptionProvider = "deepgram",
        providerOptions = {},
        recordingConfigOverrides = {},
        recallRegion = process.env.RECALL_REGION,
        recallApiKey = process.env.RECALL_API_KEY,
        recallInitOptions,
    } = options;

    const providerKey =
        providerMap[transcriptionProvider] ?? providerMap.deepgram;
    const mergedProviderOptions = {
        ...(providerDefaults[providerKey] ?? {}),
        ...providerOptions,
    };

    try {
        const initOptions =
            typeof recallInitOptions === "object" && recallInitOptions !== null
                ? recallInitOptions
                : recallRegion
                    ? {apiUrl: `https://${recallRegion}.recall.ai`}
                    : {};

        await ensureRecallSdkInitialized(initOptions);

        let uploadToken;
        if (clientToken || backendUrl) {
            uploadToken = await requestUploadTokenFromBackend({
                clientToken,
                backendUrl,
                transcriptionProvider,
                providerOptions: mergedProviderOptions,
            });
        } else {
            uploadToken = await requestUploadTokenViaRecallApi({
                apiKey: recallApiKey,
                region: recallRegion,
                providerKey,
                providerOptions: mergedProviderOptions,
                recordingConfigOverrides,
            });
        }

        recallWindowId = await RecallAiSdk.prepareDesktopAudioRecording();
        debugRecall("prepared window", recallWindowId);
        await RecallAiSdk.startRecording({
            windowId: recallWindowId,
            uploadToken,
        });

        debugRecall("startRecording invoked");
        recallRecordingActive = true;
        return true;
    } catch (error) {
        recallRecordingActive = false;
        recallWindowId = null;
        throw error;
    }
}

export async function stopRecallRecording() {
    if (!recallRecordingActive || !recallWindowId) {
        return false;
    }

    try {
        await RecallAiSdk.stopRecording({
            windowId: recallWindowId,
        });

        recallRecordingActive = false;
        recallWindowId = null;
        return true;
    } catch (error) {
        recallRecordingActive = false;
        recallWindowId = null;
        throw error;
    }
}

export function isRecallRecordingActive() {
    return recallRecordingActive;
}

export function getRecallRecordingStatus() {
    return {
        active: recallRecordingActive,
        windowId: recallWindowId,
    };
}
