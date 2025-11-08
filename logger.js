import fs from "node:fs";
import path from "node:path";

const LOG_FILE_NAME = "log.txt";

const resolveLogFilePath = () => {
	const resourcesPath =
		typeof process?.resourcesPath === "string" && process.resourcesPath.length
			? process.resourcesPath
			: process.cwd();
	return path.join(resourcesPath, LOG_FILE_NAME);
};

const logFilePath = resolveLogFilePath();

const serializePayload = (value) => {
	if (value instanceof Error) {
		return value.stack || `${value.name}: ${value.message}`;
	}

	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return "[Unserializable Object]";
		}
	}

	return typeof value === "string" ? value : String(value);
};

const appendToLogFile = (line) => {
	try {
		const directory = path.dirname(logFilePath);
		if (!fs.existsSync(directory)) {
			fs.mkdirSync(directory, { recursive: true });
		}
		fs.appendFileSync(logFilePath, `${line}\n`, "utf8");
	} catch (writeError) {
		// eslint-disable-next-line no-console
		console.warn("Failed to write log file:", writeError);
	}
};

export const logError = (...payload) => {
	const timestamp = new Date().toISOString();
	const message = payload.map(serializePayload).join(" ");
	appendToLogFile(`[${timestamp}] ${message}`);
};

export const setupProcessErrorLogging = () => {
	const originalConsoleError = console.error.bind(console);
	console.error = (...args) => {
		logError(...args);
		originalConsoleError(...args);
	};
};
