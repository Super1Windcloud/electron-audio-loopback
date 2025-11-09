import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AudioTee } from "audiotee";
import dotenv from "dotenv";
import { app, BrowserWindow, ipcMain } from "electron";
import { logError, setupProcessErrorLogging } from "./logger.js";
import { createAssemblyStreamingSession } from "./transcription/assembly.js";
import { createDeepgramSession } from "./transcription/deepgram.js";
import { createGladiaSession } from "./transcription/gladia.js";
import { createGoogleGenaiSession } from "./transcription/googleGenai.js";
import { createRevaiSession } from "./transcription/revai.js";
import { createSpeechmaticsSession } from "./transcription/speechmatics.js";
import { convertToSimpleChinese } from "./utils.js";
import { WavWriter } from "./wavWriter.js";

const envPath = app.isPackaged
	? path.join(process.resourcesPath, ".env")
	: path.resolve(".env");
dotenv.config({ path: envPath });
setupProcessErrorLogging();

const toPositiveNumber = (value) => {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const DEFAULT_SAMPLE_RATE =
	toPositiveNumber(process.env.LOOPBACK_SAMPLE_RATE) ?? 16000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_ENCODING = "linear16";
const SIMPLIFIED_TRANSCRIPT_PROVIDERS = new Set(["assembly"]); // 仅针对台湾会议
const REPLACING_FINAL_TRANSCRIPT_PROVIDERS = new Set([
	"googleGenai",
	"deepgram",
]);
const SHOULD_SAVE_WAV = process.env.SAVE_LOOPBACK_WAV === "1";
const AUDIO_TEE_SAMPLE_RATE = toPositiveNumber(
	process.env.AUDIO_TEE_SAMPLE_RATE,
);
const AUDIO_TEE_CHUNK_DURATION_MS =
	toPositiveNumber(process.env.AUDIO_TEE_CHUNK_MS) ?? 200;
const AUDIO_TEE_MUTE =
	process.env.AUDIO_TEE_MUTE === "1" ||
	process.env.AUDIO_TEE_MUTE?.toLowerCase() === "true";
const AUDIO_DEBUG_INTERVAL_MS = 2000;
const PCM16_BYTES_PER_SAMPLE = 2;
const SILENT_CHUNK_WINDOW_MS = 5000;
const SILENT_CHUNK_THRESHOLD = Math.max(
	1,
	Math.round(SILENT_CHUNK_WINDOW_MS / AUDIO_TEE_CHUNK_DURATION_MS),
);
const logMainAudioChunk = (() => {
	let lastLogTime = 0;
	return (payload) => {
		const now = Date.now();
		if (now - lastLogTime < AUDIO_DEBUG_INTERVAL_MS) {
			return;
		}
		lastLogTime = now;
		console.log("[LoopbackDebug][main]", payload);
	};
})();

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
let wavRecorder = null;
let audioCapture = null;
let consecutiveSilentChunks = 0;
let silentWarningEmitted = false;

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
		if (REPLACING_FINAL_TRANSCRIPT_PROVIDERS.has(currentTranscriptionType)) {
			finalTranscript = normalized;
		} else {
			finalTranscript = `${finalTranscript} ${normalized}`.trim();
		}
		mainWindow?.webContents.send("transcript-final", finalTranscript);
	}
};

const getWavFilePath = () => {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const baseDir = app.getPath("desktop");
	return path.join(baseDir, `loopback-${timestamp}.wav`);
};

const resetTranscriptionState = () => {
	finalTranscript = "";
};

const resolveSampleRate = (requestedSampleRate) => {
	if (AUDIO_TEE_SAMPLE_RATE) {
		return AUDIO_TEE_SAMPLE_RATE;
	}
	const numericRequested = Number(requestedSampleRate);
	if (Number.isFinite(numericRequested) && numericRequested > 0) {
		return numericRequested;
	}
	return DEFAULT_SAMPLE_RATE;
};

const getPcm16Peak = (buffer) => {
	if (!buffer || buffer.length < PCM16_BYTES_PER_SAMPLE) {
		return 0;
	}

	let peak = 0;
	for (
		let offset = 0;
		offset + 1 < buffer.length;
		offset += PCM16_BYTES_PER_SAMPLE
	) {
		const sample = Math.abs(buffer.readInt16LE(offset));
		if (sample > peak) {
			peak = sample;
			if (peak >= 0x7fff) {
				break;
			}
		}
	}
	return peak;
};

const handleSilentAudioDetection = (peak) => {
	if (peak > 0) {
		consecutiveSilentChunks = 0;
		if (silentWarningEmitted && transcriptionSession) {
			silentWarningEmitted = false;
			sendStatus("connected");
		} else {
			silentWarningEmitted = false;
		}
		return;
	}

	consecutiveSilentChunks += 1;
	if (
		!silentWarningEmitted &&
		consecutiveSilentChunks >= SILENT_CHUNK_THRESHOLD
	) {
		silentWarningEmitted = true;
		console.warn(
			"AudioTee 捕获连续静音，macOS 可能尚未授予 Electron 的系统音频录制权限（设置 > 隐私与安全 > 屏幕与系统音频录制 > 系统音频录制 仅限）。",
		);
		sendStatus("no-audio");
	}
};

const stopAudioCapture = async () => {
	if (!audioCapture) {
		return;
	}

	const capture = audioCapture;
	audioCapture = null;
	try {
		capture.removeAllListeners();
		await capture.stop();
	} catch (error) {
		console.error("停止 AudioTee 录音失败：", error);
	}
	consecutiveSilentChunks = 0;
	silentWarningEmitted = false;
};

const startAudioCapture = async ({ sampleRate }) => {
	await stopAudioCapture();
	const targetSampleRate = resolveSampleRate(sampleRate);

	const capture = new AudioTee({
		sampleRate: targetSampleRate,
		chunkDurationMs: AUDIO_TEE_CHUNK_DURATION_MS,
		mute: AUDIO_TEE_MUTE,
	});

	capture.on("data", ({ data }) => {
		if (!transcriptionSession) {
			return;
		}

		const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
		if (!chunk.length) {
			return;
		}

		try {
			transcriptionSession.sendAudio(chunk);
			const peak = getPcm16Peak(chunk);
			logMainAudioChunk({
				bytes: chunk.length,
				sampleRate: targetSampleRate,
				peak,
			});
			handleSilentAudioDetection(peak);
			if (wavRecorder) {
				void wavRecorder.write(chunk).catch((error) => {
					console.error("写入 WAV 录音失败：", error);
				});
			}
		} catch (error) {
			console.error("Failed to forward audio chunk:", error);
		}
	});

	capture.on("error", (error) => {
		console.error("AudioTee 捕获错误：", error);
		sendStatus("error");
		void stopTranscriptionSession();
	});

	capture.on("log", (level, message) => {
		console.log(`[AudioTee][${level}]`, message);
	});

	audioCapture = capture;
	await capture.start();
};

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

	if (transcriptionType === "googleGenai") {
		return await createGoogleGenaiSession({
			apiKey: process.env.GOOGLE_GENAI_API_KEY,
			sampleRate,
			channels,
			encoding,
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
		`Electron Loopback 暂未实现 "${transcriptionType}" 转写，请先选择 Deepgram、AssemblyAI、Gladia、Rev.ai、Speechmatics 或 Google GenAI。`,
	);
};

const startTranscriptionSession = async ({
	sampleRate: requestedSampleRate = DEFAULT_SAMPLE_RATE,
	channels = DEFAULT_CHANNELS,
	encoding = DEFAULT_ENCODING,
	transcriptionType = "deepgram",
}) => {
	resetTranscriptionState();
	currentTranscriptionType = transcriptionType;
	const resolvedSampleRate = resolveSampleRate(requestedSampleRate);

	const session = await createElectronTranscriptionSession({
		transcriptionType,
		sampleRate: resolvedSampleRate,
		channels,
		encoding,
	});

	transcriptionSession = {
		provider: transcriptionType,
		sendAudio(chunk) {
			session.sendAudio(chunk);
		},
		async stop() {
			await session.stop();
		},
	};

	if (SHOULD_SAVE_WAV) {
		try {
			const filePath = getWavFilePath();
			wavRecorder = new WavWriter({
				filePath,
				channels,
				sampleRate: resolvedSampleRate,
			});
			await wavRecorder.start();
			console.log("[LoopbackDebug][main]", "WAV 录音输出：", filePath);
		} catch (error) {
			console.error("初始化 WAV 录音失败：", error);
			wavRecorder = null;
		}
	}

	try {
		await startAudioCapture({ sampleRate: resolvedSampleRate });
	} catch (error) {
		await stopTranscriptionSession();
		throw error;
	}
};

const stopTranscriptionSession = async () => {
	await stopAudioCapture();

	if (transcriptionSession) {
		try {
			await transcriptionSession.stop?.();
		} catch (error) {
			console.error("Failed to stop transcription session:", error);
		} finally {
			transcriptionSession = null;
		}
	}

	currentTranscriptionType = null;

	if (wavRecorder) {
		try {
			await wavRecorder.stop();
		} catch (error) {
			console.error("关闭 WAV 录音失败：", error);
		} finally {
			wavRecorder = null;
		}
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

ipcMain.on("stop-transcription", async () => {
	await stopTranscriptionSession();
	sendStatus("stopped");
	if (finalTranscript) {
		mainWindow?.webContents.send("transcript-final", finalTranscript);
	}
});

ipcMain.handle("log-error", async (_event, entries = []) => {
	try {
		if (Array.isArray(entries)) {
			logError(...entries);
		} else {
			logError(entries);
		}
		return { success: true };
	} catch (error) {
		console.error("Failed to persist renderer log entry:", error);
		return { success: false, message: error.message };
	}
});
