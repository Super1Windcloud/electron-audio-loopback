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
	logError: (...entries) => ipcRenderer.invoke("log-error", entries),
});
