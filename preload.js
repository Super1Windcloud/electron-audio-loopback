// preload.js
const { contextBridge, ipcRenderer } = require("electron");

console.log("✅ preload loaded");

contextBridge.exposeInMainWorld("electronAPI", {
	startTranscription: (options) =>
		ipcRenderer.send("start-transcription", options ?? {}),
	stopTranscription: () => ipcRenderer.send("stop-transcription"),
	onTranscript: (callback) =>
		ipcRenderer.on("transcript", (_, payload) => callback(payload)),
	onFinalTranscript: (callback) =>
		ipcRenderer.on("transcript-final", (_, text) => callback(text)),
	onStatus: (callback) =>
		ipcRenderer.on("status-update", (_, status) => callback(status)),
	enableLoopbackAudio: () => ipcRenderer.invoke("enable-loopback-audio"),
	disableLoopbackAudio: () => ipcRenderer.invoke("disable-loopback-audio"),
	sendAudioChunk: (chunk) => ipcRenderer.send("audio-chunk", chunk),
	// Recall AI functionality
	startRecallRecording: (options) =>
		ipcRenderer.invoke("start-recall-recording", options),
	stopRecallRecording: () => ipcRenderer.invoke("stop-recall-recording"),
	getRecallStatus: () => ipcRenderer.invoke("get-recall-status"),
	sendRecallAudio: (audioData) =>
		ipcRenderer.send("send-recall-audio", audioData),
	logError: (...entries) => ipcRenderer.invoke("log-error", entries),
});
