import fs from "node:fs";
import path from "node:path";

const WAV_HEADER_SIZE = 44;

export class WavWriter {
	constructor({
		filePath,
		channels = 1,
		sampleRate = 16000,
		bitDepth = 16,
	} = {}) {
		if (!filePath) {
			throw new Error("WavWriter 需要提供 filePath");
		}
		this.filePath = path.resolve(filePath);
		this.channels = channels;
		this.sampleRate = sampleRate;
		this.bitDepth = bitDepth;
		this.bytesPerSample = bitDepth / 8;
		this.fd = null;
		this.dataLength = 0;
	}

	async start() {
		if (this.fd) return;
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
		this.fd = await fs.promises.open(this.filePath, "w");
		const header = Buffer.alloc(WAV_HEADER_SIZE);
		writeWavHeader(header, this.channels, this.sampleRate, this.bitDepth, 0);
		await this.fd.write(header, 0, WAV_HEADER_SIZE, 0);
		this.dataLength = 0;
	}

	async write(buffer) {
		if (!this.fd || !buffer?.length) return;
		const { bytesWritten } = await this.fd.write(buffer);
		this.dataLength += bytesWritten;
	}

	async stop() {
		if (!this.fd) return;
		const header = Buffer.alloc(WAV_HEADER_SIZE);
		writeWavHeader(
			header,
			this.channels,
			this.sampleRate,
			this.bitDepth,
			this.dataLength,
		);
		await this.fd.write(header, 0, WAV_HEADER_SIZE, 0);
		await this.fd.close();
		this.fd = null;
	}
}

function writeWavHeader(buffer, channels, sampleRate, bitDepth, dataLength) {
	const bytesPerSample = bitDepth / 8;
	const blockAlign = channels * bytesPerSample;
	const byteRate = sampleRate * blockAlign;
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataLength, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16); // PCM
	buffer.writeUInt16LE(1, 20); // audio format PCM
	buffer.writeUInt16LE(channels, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(byteRate, 28);
	buffer.writeUInt16LE(blockAlign, 32);
	buffer.writeUInt16LE(bitDepth, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataLength, 40);
}
