import RecallAiSdk from "@recallai/desktop-sdk";

let recallRecordingActive = false;
let recallWindowId = null;
let realtimeHandlers = null;

const RECALL_REALTIME_EVENT = "transcript.data";

const providerMap = {
	assembly: "assembly_ai_v3_streaming",
	deepgram: "deepgram_streaming",
};

function emitRealtimeStatus(status) {
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
}

function normalizeRealtimeTranscript(payload) {
	if (!payload || payload.event !== RECALL_REALTIME_EVENT) return null;
	const data = payload.data ?? {};

	const textCandidates = [
		data.transcript?.text,
		data.transcript,
		data.text,
		data.transcript_text,
		data.message,
		data.alternatives?.[0]?.transcript,
		data.sentences?.[0]?.text,
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
	];

	return {
		text: text.trim(),
		isFinal: finalFlags.some(Boolean),
		raw: data,
	};
}

RecallAiSdk.addEventListener("realtime-event", (payload) => {
	const normalized = normalizeRealtimeTranscript(payload);
	if (!normalized) return;
	realtimeHandlers?.onTranscript?.(normalized);
});

RecallAiSdk.addEventListener("recording-started", () => {
	emitRealtimeStatus("connected");
});

RecallAiSdk.addEventListener("recording-ended", () => {
	emitRealtimeStatus("closed");
});

RecallAiSdk.addEventListener("error", (event) => {
	const message = event?.message ?? "Recall SDK error";
	emitRealtimeError(new Error(message));
});

export function setRecallRealtimeHandlers(handlers) {
	realtimeHandlers = handlers;
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
		body: JSON.stringify({ recording_config: recordingConfig }),
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
		body: JSON.stringify({ transcriptionProvider }),
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
	} = options;

	const providerKey =
		providerMap[transcriptionProvider] ?? providerMap.deepgram;

	try {
		let uploadToken;
		if (clientToken || backendUrl) {
			uploadToken = await requestUploadTokenFromBackend({
				clientToken,
				backendUrl,
				transcriptionProvider,
			});
		} else {
			uploadToken = await requestUploadTokenViaRecallApi({
				apiKey: recallApiKey,
				region: recallRegion,
				providerKey,
				providerOptions,
				recordingConfigOverrides,
			});
		}

		recallWindowId = await RecallAiSdk.prepareDesktopAudioRecording();
		await RecallAiSdk.startRecording({
			windowId: recallWindowId,
			uploadToken,
		});

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
