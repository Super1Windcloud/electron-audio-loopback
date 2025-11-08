const statusEl = document.getElementById("status");
const partialEl = document.getElementById("partialTranscript");
const finalEl = document.getElementById("finalTranscript");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const transcriptionTypeSelect =
	document.getElementById("transcriptionType") || null;
const audioCaptureTypeSelect =
	document.getElementById("audioCaptureType") || null;

let audioStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silentNode = null;
let streamingEnabled = false;
let recallRecordingStarted = false;
let currentSampleRate = 44100;
let currentAudioCaptureType = "electron"; // default to electron
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
		captureTypes: ["electron", "recall"],
	},
	{
		value: "assembly",
		label: "AssemblyAI (仅英语,不支持中文)",
		captureTypes: ["electron", "recall"],
	},
	{
		value: "gladia",
		label: "Gladia (Electron only)",
		captureTypes: ["electron"],
	},
	{
		value: "revai",
		label: "Rev.ai (Electron only)",
		captureTypes: ["electron"],
	},
	{
		value: "speechmatics",
		label: "Speechmatics (Electron only)",
		captureTypes: ["electron"],
	},
	{
		value: "googleGenai",
		label: "Google Gemini (Electron only)",
		captureTypes: ["electron"],
	},
];

const getProvidersForCapture = (captureType) =>
	PROVIDERS.filter((provider) => provider.captureTypes.includes(captureType));

const refreshProviderOptions = () => {
	if (!transcriptionTypeSelect) {
		return;
	}

	const allowedProviders = getProvidersForCapture(currentAudioCaptureType);
	const currentValue = transcriptionTypeSelect.value;

	transcriptionTypeSelect.innerHTML = "";
	allowedProviders.forEach((provider) => {
		const option = document.createElement("option");
		option.value = provider.value;
		option.textContent = provider.label;
		transcriptionTypeSelect.append(option);
	});

	const stillValid = allowedProviders.some(
		(provider) => provider.value === currentValue,
	);

	transcriptionTypeSelect.value = stillValid
		? currentValue
		: (allowedProviders[0]?.value ?? "");
};

// Set up audio capture type selection
if (audioCaptureTypeSelect) {
	currentAudioCaptureType = audioCaptureTypeSelect.value;
	refreshProviderOptions();

	audioCaptureTypeSelect.addEventListener("change", function () {
		currentAudioCaptureType = this.value;
		refreshProviderOptions();
	});
} else if (transcriptionTypeSelect) {
	refreshProviderOptions();
}

const mixDownToMono = (channels) => {
	if (!channels || channels.length === 0) {
		return new Float32Array(0);
	}

	if (channels.length === 1) {
		return channels[0];
	}

	const length = channels[0]?.length ?? 0;
	const mono = new Float32Array(length);

	for (let i = 0; i < length; i += 1) {
		let sum = 0;
		for (
			let channelIndex = 0;
			channelIndex < channels.length;
			channelIndex += 1
		) {
			sum += channels[channelIndex]?.[i] ?? 0;
		}
		mono[i] = sum / channels.length;
	}

	return mono;
};

const floatTo16BitPCM = (float32Array) => {
	const buffer = new ArrayBuffer(float32Array.length * 2);
	const view = new DataView(buffer);

	for (let i = 0; i < float32Array.length; i += 1) {
		let sample = float32Array[i];
		sample = Math.max(-1, Math.min(1, sample));
		view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
	}

	return new Int16Array(buffer);
};

const stopCapture = async () => {
	streamingEnabled = false;

	if (processorNode) {
		processorNode.disconnect();
		processorNode.onaudioprocess = null;
		processorNode = null;
	}

	if (sourceNode) {
		sourceNode.disconnect();
		sourceNode = null;
	}

	if (silentNode) {
		silentNode.disconnect();
		silentNode = null;
	}

	if (audioContext) {
		try {
			await audioContext.close();
		} catch (error) {
			console.warn("关闭 AudioContext 失败", error);
		}
		audioContext = null;
	}

	if (audioStream) {
		audioStream.getTracks().forEach((track) => {
			track.stop();
		});
		audioStream = null;
	}
};

// Audio capture methods
const startElectronCapture = async () => {
	const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextCtor) {
		throw new Error("当前环境不支持 Web Audio API，请升级浏览器内核");
	}

	await window.electronAPI.enableLoopbackAudio();
	let displayStream;

	try {
		displayStream = await navigator.mediaDevices.getDisplayMedia({
			audio: true,
			video: true,
		});
	} catch (error) {
		await window.electronAPI.disableLoopbackAudio();
		throw error;
	}

	await window.electronAPI.disableLoopbackAudio();

	try {
		const videoTracks = displayStream.getVideoTracks();
		videoTracks.forEach((track) => {
			track.stop();
			displayStream.removeTrack(track);
		});

		const audioTracks = displayStream.getAudioTracks();
		if (audioTracks.length === 0) {
			displayStream.getTracks().forEach((track) => {
				track.stop();
			});
			throw new Error("未检测到系统音频轨道");
		}

		audioStream = new MediaStream(audioTracks);

		audioContext = new AudioContextCtor({ sampleRate: 16000 });
		await audioContext.resume();
		currentSampleRate = audioContext.sampleRate;

		sourceNode = audioContext.createMediaStreamSource(audioStream);
		const inputChannels =
			sourceNode.channelCount ||
			audioTracks[0]?.getSettings()?.channelCount ||
			2;
		const bufferSize = 4096;
		processorNode = audioContext.createScriptProcessor(
			bufferSize,
			inputChannels,
			1,
		);
		silentNode = audioContext.createGain();
		silentNode.gain.value = 0;

		processorNode.onaudioprocess = (event) => {
			if (!streamingEnabled) {
				return;
			}

			const channels = [];
			for (let i = 0; i < event.inputBuffer.numberOfChannels; i += 1) {
				channels.push(event.inputBuffer.getChannelData(i));
			}

			const mono = mixDownToMono(channels);
			if (mono.length === 0) {
				return;
			}

			const pcm16 = floatTo16BitPCM(mono);
			if (pcm16.length > 0) {
				window.electronAPI.sendAudioChunk(pcm16);
			}
		};

		sourceNode.connect(processorNode);
		processorNode.connect(silentNode);
		silentNode.connect(audioContext.destination);

		return { sampleRate: currentSampleRate };
	} catch (error) {
		await stopCapture();
		throw error;
	}
};

const startRecallCapture = async () => {
	// For Recall AI, the audio capture is handled by the Recall SDK
	// In this implementation, we'll just set up the sample rate
	// The actual audio processing is managed by the Recall SDK in the background
	currentSampleRate = 44100; // Default sample rate for Recall

	// In a real implementation, you might set up event listeners
	// to handle audio data from Recall if available
	// For now, we'll just return the sample rate

	return { sampleRate: currentSampleRate };
};

const startCapture = async () => {
	if (currentAudioCaptureType === "electron") {
		return await startElectronCapture();
	} else if (currentAudioCaptureType === "recall") {
		return await startRecallCapture();
	} else {
		throw new Error(
			`Unsupported audio capture type: ${currentAudioCaptureType}`,
		);
	}
};

startBtn.onclick = async () => {
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
		const allowedProviders = getProvidersForCapture(currentAudioCaptureType);
		let selectedTranscriptionType = transcriptionTypeSelect
			? transcriptionTypeSelect.value
			: "deepgram";

		if (
			allowedProviders.length > 0 &&
			!allowedProviders.some(
				(provider) => provider.value === selectedTranscriptionType,
			)
		) {
			selectedTranscriptionType = allowedProviders[0].value;
			if (transcriptionTypeSelect) {
				transcriptionTypeSelect.value = selectedTranscriptionType;
			}
		}

		if (currentAudioCaptureType === "recall" && !recallRecordingStarted) {
			partialEl.textContent = "启动 Recall 录音中...";
			const recallResult = await window.electronAPI.startRecallRecording({
				transcriptionProvider: selectedTranscriptionType,
			});

			if (!recallResult.success) {
				throw new Error(recallResult.message || "无法启动 Recall 录音");
			}
			recallRecordingStarted = true;
			partialEl.textContent = "建立连接中...";
		}

		// Capture audio based on selected method
		let captureConfig;
		if (currentAudioCaptureType === "electron") {
			captureConfig = await startCapture(); // Uses electron capture
		} else if (currentAudioCaptureType === "recall") {
			// For Recall capture, we still set up the transcription but audio capture is handled differently
			captureConfig = await startCapture(); // Will call startRecallCapture which sets up the sample rate
		}

		const options = {
			sampleRate: captureConfig.sampleRate,
			channels: 1,
			encoding: "linear16",
		};

		// Add transcription type if the UI element exists
		options.transcriptionType = selectedTranscriptionType;

		// Add audio capture type to options
		options.audioCaptureType = currentAudioCaptureType;

		window.electronAPI.startTranscription(options);
		streamingEnabled = true;
	} catch (error) {
		console.error("启动监听失败", error);
		statusEl.textContent = "启动失败";
		statusEl.className = "status disconnected";
		rollingTranscript = "";
		partialEl.textContent = error.message || "请检查录音权限后重试";
		startBtn.disabled = false;
		stopBtn.disabled = true;
		await stopCapture();

		// If we tried to start Recall recording but failed, clean up the state
		if (recallRecordingStarted) {
			try {
				await window.electronAPI.stopRecallRecording();
				recallRecordingStarted = false;
			} catch (recallError) {
				console.error(
					"Failed to stop Recall recording after error:",
					recallError,
				);
			}
		}
	}
};

stopBtn.onclick = async () => {
	if (!window.electronAPI) {
		alert("缺少预加载桥接：window.electronAPI 不存在");
		return;
	}

	window.electronAPI.stopTranscription();
	streamingEnabled = false;
	rollingTranscript = "";
	partialEl.textContent = "—";

	// Stop audio capture based on the selected method
	if (currentAudioCaptureType === "electron") {
		await stopCapture();
	}
	// For 'recall' method, audio capture is handled by the Recall SDK

	if (currentAudioCaptureType === "recall") {
		recallRecordingStarted = false;
	}

	statusEl.textContent = "已停止";
	statusEl.className = "status disconnected";
	startBtn.disabled = false;
	stopBtn.disabled = true;
	console.warn("already stop audio capture");
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
			streamingEnabled = true;
			partialEl.textContent = "请开始播放或讲话…";
			break;
		case "error":
			statusEl.textContent = "连接错误 ❌";
			statusEl.className = "status disconnected";
			streamingEnabled = false;
			void stopCapture();
			stopBtn.disabled = true;
			startBtn.disabled = false;
			break;
		case "stopped":
		case "closed":
			statusEl.textContent = "已停止";
			statusEl.className = "status disconnected";
			streamingEnabled = false;
			void stopCapture();
			startBtn.disabled = false;
			stopBtn.disabled = true;
			break;
	}
});
