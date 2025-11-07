import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { app, BrowserWindow, ipcMain } from "electron";
import { initMain } from "electron-audio-loopback";
import {
	isRecallRecordingActive,
	setRecallRealtimeHandlers,
	startRecallRecording,
	stopRecallRecording,
} from "./recallai.js";
import { createAssemblyStreamingSession } from "./transcription/assembly.js";
import { createDeepgramSession } from "./transcription/deepgram.js";
import { createGladiaSession } from "./transcription/gladia.js";
import { createRevaiSession } from "./transcription/revai.js";
import { createSpeechmaticsSession } from "./transcription/speechmatics.js";
import { convertToSimpleChinese } from "./utils.js";

dotenv.config({ path: "./.env" });
initMain();

const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CHANNELS = 1;
const DEFAULT_ENCODING = "linear16";
const RECALL_SUPPORTED_PROVIDERS = new Set(["deepgram", "assembly"]);
const SIMPLIFIED_TRANSCRIPT_PROVIDERS = new Set(["assembly"]); // 仅针对台湾会议

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const preload = path.join(__dirname, "preload.js");
if (!fs.existsSync(preload)) {
	console.error("Preload file not found.");
	process.exit(1);
}

let mainWindow = null;
let transcriptionSession = null;
let finalTranscript = "";
let currentTranscriptionType = null;
let currentAudioCaptureType = null;

const toAssemblyEncoding = (encoding) => {
	if (!encoding) return "pcm_s16le";
	if (encoding.toLowerCase() === "linear16") return "pcm_s16le";
	return encoding;
};

const sendStatus = (status) => {
	mainWindow?.webContents.send("status-update", status);
};

const extractTranscriptText = (payload) => {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";

	if (typeof payload.text === "string") return payload.text;
	if (typeof payload.transcript === "string") return payload.transcript;
	if (typeof payload.transcript_text === "string")
		return payload.transcript_text;

	if (Array.isArray(payload.alternatives)) {
		const altText = payload.alternatives
			.map((alt) => (typeof alt?.transcript === "string" ? alt.transcript : ""))
			.find((value) => value?.length);
		if (altText) return altText;
	}

	if (typeof payload.message === "string") return payload.message;

	return payload.toString?.() ?? "";
};

const simplifyTranscriptIfNeeded = (text) => {
	if (!text.length) return text;
	if (!SIMPLIFIED_TRANSCRIPT_PROVIDERS.has(currentTranscriptionType)) {
		return text;
	}

	try {
		return convertToSimpleChinese(text);
	} catch (error) {
		console.error("Failed to convert transcript to simplified Chinese:", error);
		return text;
	}
};

const emitTranscript = (text, isFinal = false) => {
	const normalized = simplifyTranscriptIfNeeded(
		extractTranscriptText(text).trim(),
	);
	if (!normalized.length) return;
	const payload = {
		text: normalized,
		isFinal: Boolean(isFinal),
		provider: currentTranscriptionType,
	};
	mainWindow?.webContents.send("transcript", payload);
	if (isFinal) {
		finalTranscript = `${finalTranscript} ${normalized}`.trim();
		mainWindow?.webContents.send("transcript-final", finalTranscript);
	}
};

const resetTranscriptionState = () => {
	finalTranscript = "";
};

setRecallRealtimeHandlers({
	onTranscript: ({ text, isFinal }) => {
		if (currentAudioCaptureType !== "recall") return;
		emitTranscript(text, isFinal);
	},
	onStatus: (status) => {
		if (currentAudioCaptureType !== "recall") return;
		if (status) sendStatus(status);
	},
	onError: (error) => {
		if (currentAudioCaptureType !== "recall") return;
		console.error("Recall realtime error:", error);
		sendStatus("error");
	},
});

app.whenReady().then(() => {
	mainWindow = new BrowserWindow({
		width: 800,
		height: 600,
		title: "Transcription",
		center: true,
		autoHideMenuBar: true,
		alwaysOnTop: false,
		webPreferences: {
			preload,
			devTools: true,
			nodeIntegration: false,
			contextIsolation: true,
			webgl: true,
			webSecurity: true,
			disableBlinkFeatures: "Autofill",
		},
	});

	if (!app.isPackaged) {
		mainWindow.webContents.openDevTools({ mode: "detach" });
	}

	mainWindow.loadFile("index.html");
});

const createElectronTranscriptionSession = async ({
	transcriptionType,
	sampleRate,
	channels,
	encoding,
}) => {
	const baseCallbacks = {
		onStatus: sendStatus,
		onTranscript: emitTranscript,
		onError: (error) => {
			console.error(`${transcriptionType} transcription error:`, error);
			sendStatus("error");
		},
	};

	if (transcriptionType === "assembly") {
		return await createAssemblyStreamingSession({
			apiKey: process.env.ASSEMBLY_API_KEY,
			sampleRate,
			encoding: toAssemblyEncoding(encoding),
			...baseCallbacks,
		});
	}

	if (transcriptionType === "deepgram") {
		return createDeepgramSession({
			apiKey: process.env.DEEPGRAM_API_KEY,
			sampleRate,
			channels,
			encoding,
			...baseCallbacks,
		});
	}

	if (transcriptionType === "gladia") {
		return await createGladiaSession({
			apiKey: process.env.GLADIA_API_KEY,
			sampleRate,
			channels,
			encoding,
			...baseCallbacks,
		});
	}

	if (transcriptionType === "revai") {
		return await createRevaiSession({
			apiKey: process.env.REVAI_ACCESS_TOKEN,
			sampleRate,
			channels,
			...baseCallbacks,
		});
	}

	if (transcriptionType === "speechmatics") {
		return await createSpeechmaticsSession({
			apiKey: process.env.SPEECHMATICS_API_KEY,
			sampleRate,
			channels,
			...baseCallbacks,
		});
	}

	throw new Error(
		`Electron Loopback 暂未实现 "${transcriptionType}" 转写，请先选择 Deepgram、AssemblyAI、Gladia、Rev.ai 或 Speechmatics。`,
	);
};

const startTranscriptionSession = async ({
	sampleRate = DEFAULT_SAMPLE_RATE,
	channels = DEFAULT_CHANNELS,
	encoding = DEFAULT_ENCODING,
	transcriptionType = "deepgram",
	audioCaptureType = "electron",
}) => {
	resetTranscriptionState();
	currentTranscriptionType = transcriptionType;
	currentAudioCaptureType = audioCaptureType;

	if (audioCaptureType === "recall") {
		if (!RECALL_SUPPORTED_PROVIDERS.has(transcriptionType)) {
			throw new Error(
				"使用 Recall 录音时只能选择 AssemblyAI 或 Deepgram 作为实时转写提供商。",
			);
		}
		if (!isRecallRecordingActive()) {
			throw new Error(
				"Recall capture is not active. Start Recall recording before transcription.",
			);
		}
		sendStatus("connected");
		transcriptionSession = {
			audioCaptureType,
			provider: transcriptionType,
			sendAudio() {},
			async stop() {
				await stopRecallRecording();
			},
		};
		return;
	}

	const session = await createElectronTranscriptionSession({
		transcriptionType,
		sampleRate,
		channels,
		encoding,
	});

	transcriptionSession = {
		audioCaptureType,
		provider: transcriptionType,
		sendAudio(chunk) {
			session.sendAudio(chunk);
		},
		async stop() {
			await session.stop();
		},
	};
};

const stopTranscriptionSession = async () => {
	if (!transcriptionSession) return;
	try {
		await transcriptionSession.stop?.();
	} catch (error) {
		console.error("Failed to stop transcription session:", error);
	} finally {
		transcriptionSession = null;
		currentAudioCaptureType = null;
		currentTranscriptionType = null;
	}
};

ipcMain.on("start-transcription", async (_, options = {}) => {
	if (transcriptionSession) {
		console.warn("Transcription already in progress.");
		return;
	}

	try {
		sendStatus("connecting");
		await startTranscriptionSession({
			sampleRate:
				Number(options.sampleRate) > 0
					? Number(options.sampleRate)
					: DEFAULT_SAMPLE_RATE,
			channels:
				Number(options.channels) > 0
					? Number(options.channels)
					: DEFAULT_CHANNELS,
			encoding:
				typeof options.encoding === "string"
					? options.encoding
					: DEFAULT_ENCODING,
			transcriptionType: options.transcriptionType || "deepgram",
			audioCaptureType: options.audioCaptureType || "electron",
		});
	} catch (error) {
		console.error("Failed to start transcription session:", error);
		sendStatus("error");
		mainWindow?.webContents.send("transcript", {
			text: "",
			isFinal: false,
			provider: currentTranscriptionType,
		});
	}
});

ipcMain.on("audio-chunk", (_, buffer) => {
	if (
		!transcriptionSession ||
		currentAudioCaptureType !== "electron" ||
		!buffer
	) {
		return;
	}

	try {
		let chunk;
		if (buffer instanceof ArrayBuffer) {
			chunk = Buffer.from(buffer);
		} else if (ArrayBuffer.isView(buffer)) {
			chunk = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		} else {
			chunk = Buffer.from(buffer);
		}

		if (chunk.length > 0) {
			transcriptionSession.sendAudio(chunk);
		}
	} catch (error) {
		console.error("Failed to forward audio chunk:", error);
	}
});

ipcMain.on("stop-transcription", async () => {
	await stopTranscriptionSession();
	sendStatus("stopped");
	if (finalTranscript) {
		mainWindow?.webContents.send("transcript-final", finalTranscript);
	}
});

ipcMain.handle("start-recall-recording", async (_, options = {}) => {
	try {
		await startRecallRecording(options);
		return { success: true, message: "Recall recording started successfully" };
	} catch (error) {
		console.error("Failed to start recall recording:", error);
		return { success: false, message: error.message };
	}
});

ipcMain.handle("stop-recall-recording", async () => {
	try {
		await stopRecallRecording();
		return { success: true, message: "Recall recording stopped successfully" };
	} catch (error) {
		console.error("Failed to stop recall recording:", error);
		return { success: false, message: error.message };
	}
});

ipcMain.handle("get-recall-status", async () => {
	return { active: isRecallRecordingActive() };
});

ipcMain.on("send-recall-audio", () => {
	// Recall handles audio internally; this channel is kept for compatibility.
});
