const originalConsoleError = console.error.bind(console);

const forwardRendererErrorLog = (...args) => {
	try {
		const api = window?.electronAPI;
		if (api?.logError) {
			void api.logError(...args);
		}
	} catch (forwardError) {
		originalConsoleError("Failed to forward renderer error log:", forwardError);
	}
};

console.error = (...args) => {
	forwardRendererErrorLog(...args);
	originalConsoleError(...args);
};

const statusEl = document.getElementById("status");
const partialEl = document.getElementById("partialTranscript");
const finalEl = document.getElementById("finalTranscript");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const transcriptionTypeSelect =
	document.getElementById("transcriptionType") || null;

const DEFAULT_SAMPLE_RATE = 16000;
let rollingTranscript = "";
const NON_ACCUMULATING_TRANSCRIPT_PROVIDERS = new Set([
	"assembly",
	"googleGenai",
]);
// Store last transcript received from each provider to help with deduplication
const lastReceivedTranscripts = new Map();

const normalizeTranscriptPayload = (payload) => {
	if (
		typeof payload === "string" ||
		typeof payload === "number" ||
		typeof payload === "boolean"
	) {
		return {
			text: payload.toString().trim(),
			isFinal: false,
			provider: null,
		};
	}

	if (payload && typeof payload === "object") {
		const rawText =
			typeof payload.text === "string"
				? payload.text
				: typeof payload.transcript === "string"
					? payload.transcript
					: typeof payload.message === "string"
						? payload.message
						: "";
		const text =
			typeof rawText === "string"
				? rawText.trim()
				: (rawText?.toString?.().trim?.() ?? "");

		return {
			text,
			isFinal: Boolean(payload.isFinal),
			provider:
				typeof payload.provider === "string" && payload.provider.length
					? payload.provider
					: null,
		};
	}

	return { text: "", isFinal: false, provider: null };
};

const shouldReplaceRollingTranscript = (provider) =>
	typeof provider === "string" &&
	NON_ACCUMULATING_TRANSCRIPT_PROVIDERS.has(provider);

const PROVIDERS = [
	{
		value: "deepgram",
		label: "Deepgram (Online)",
	},
	{
		value: "assembly",
		label: "AssemblyAI (仅英语,不支持中文)",
	},
	{
		value: "gladia",
		label: "Gladia (Electron only)",
	},
	{
		value: "revai",
		label: "Rev.ai (Electron only)",
	},
	{
		value: "speechmatics",
		label: "Speechmatics (Electron only)",
	},
	{
		value: "googleGenai",
		label: "Google Gemini (Electron only)",
	},
];

const refreshProviderOptions = () => {
	if (!transcriptionTypeSelect) {
		return;
	}

	const currentValue = transcriptionTypeSelect.value;

	transcriptionTypeSelect.innerHTML = "";
	PROVIDERS.forEach((provider) => {
		const option = document.createElement("option");
		option.value = provider.value;
		option.textContent = provider.label;
		transcriptionTypeSelect.append(option);
	});

	const stillValid = PROVIDERS.some(
		(provider) => provider.value === currentValue,
	);

	transcriptionTypeSelect.value = stillValid
		? currentValue
		: (PROVIDERS[0]?.value ?? "");
};

refreshProviderOptions();

startBtn.onclick = () => {
	if (!window.electronAPI) {
		alert("缺少预加载桥接：window.electronAPI 不存在");
		return;
	}

	startBtn.disabled = true;
	stopBtn.disabled = false;
	statusEl.textContent = "连接中...";
	statusEl.className = "status connecting";
	rollingTranscript = "";
	partialEl.textContent = "建立连接中...";
	finalEl.textContent = "—";

	try {
		let selectedTranscriptionType = transcriptionTypeSelect
			? transcriptionTypeSelect.value
			: "deepgram";

		if (
			PROVIDERS.length > 0 &&
			!PROVIDERS.some(
				(provider) => provider.value === selectedTranscriptionType,
			)
		) {
			selectedTranscriptionType = PROVIDERS[0].value;
			if (transcriptionTypeSelect) {
				transcriptionTypeSelect.value = selectedTranscriptionType;
			}
		}

		const options = {
			sampleRate: DEFAULT_SAMPLE_RATE,
			channels: 1,
			encoding: "linear16",
			transcriptionType: selectedTranscriptionType,
		};

		window.electronAPI.startTranscription(options);
	} catch (error) {
		console.error("启动监听失败", error);
		statusEl.textContent = "启动失败";
		statusEl.className = "status disconnected";
		rollingTranscript = "";
		partialEl.textContent = error.message || "请检查录音权限后重试";
		startBtn.disabled = false;
		stopBtn.disabled = true;
	}
};

stopBtn.onclick = () => {
	if (!window.electronAPI) {
		alert("缺少预加载桥接：window.electronAPI 不存在");
		return;
	}

	window.electronAPI.stopTranscription();
	rollingTranscript = "";
	partialEl.textContent = "—";

	statusEl.textContent = "已停止";
	statusEl.className = "status disconnected";
	startBtn.disabled = false;
	stopBtn.disabled = true;
};

window.electronAPI.onTranscript((payload) => {
	const { text, provider } = normalizeTranscriptPayload(payload);
	if (!text.length) {
		if (!rollingTranscript.length) {
			partialEl.textContent = "…";
		}
		return;
	}

	// Update last received transcript for deduplication
	lastReceivedTranscripts.set(provider, text);

	if (shouldReplaceRollingTranscript(provider)) {
		rollingTranscript = text;
	} else {
		if (provider === "speechmatics") {
			// For Speechmatics, treat partial results as the most current version
			// to avoid duplication issues, but still allow for text accumulation
			// over time as speech progresses
			rollingTranscript = text;
		} else {
			// For other providers, use normal accumulation
			rollingTranscript = rollingTranscript.length
				? `${rollingTranscript} ${text}`
				: text;
		}
	}
	partialEl.textContent = rollingTranscript;
});

window.electronAPI.onFinalTranscript((text) => {
	const normalized =
		typeof text === "string"
			? text.trim()
			: (text?.toString?.().trim?.() ?? "");

	if (!normalized.length) {
		finalEl.textContent = "—";
		return;
	}

	rollingTranscript = normalized;
	finalEl.textContent = normalized;
});

window.electronAPI.onStatus((status) => {
	switch (status) {
		case "connected":
			statusEl.textContent = "已连接 ✅";
			statusEl.className = "status connected";
			partialEl.textContent = "请开始播放或讲话…";
			break;
		case "no-audio":
			statusEl.textContent = "未检测到系统音频 ⛔️";
			statusEl.className = "status disconnected";
			startBtn.disabled = true;
			stopBtn.disabled = false;
			partialEl.textContent =
				"AudioTee 捕获为静音。请在 macOS 设置 → 隐私与安全 → 屏幕与系统音频录制 → 系统音频录制 中为 Electron/终端授予权限。权限生效后可继续播放，或点击停止后重新开始。";
			break;
		case "error":
			statusEl.textContent = "连接错误 ❌";
			statusEl.className = "status disconnected";
			stopBtn.disabled = true;
			startBtn.disabled = false;
			break;
		case "stopped":
		case "closed":
			statusEl.textContent = "已停止";
			statusEl.className = "status disconnected";
			startBtn.disabled = false;
			stopBtn.disabled = true;
			break;
	}
});
