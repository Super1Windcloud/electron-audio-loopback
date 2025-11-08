import fs from "fs";
import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const model = "gemini-2.5-flash-native-audio-preview-09-2025";

const config = {
    responseModalities: [Modality.AUDIO],
    outputAudioTranscription: {}, // 告诉模型返回音频的文字转录
};

async function live() {
    const responseQueue = [];

    // 处理模型实时返回的消息
    async function waitMessage() {
        let message;
        while (!message) {
            message = responseQueue.shift();
            if (!message) await new Promise((r) => setTimeout(r, 100));
        }
        return message;
    }

    async function handleTurn() {
        const turns = [];
        let done = false;
        while (!done) {
            const message = await waitMessage();
            turns.push(message);
            if (message.serverContent && message.serverContent.turnComplete) {
                done = true;
            }
        }
        return turns;
    }

    const session = await ai.live.connect({
        model,
        config,
        callbacks: {
            onopen: () => console.debug("✅ Opened connection"),
            onmessage: (message) => responseQueue.push(message),
            onerror: (e) => console.error("⚠️ Error:", e.message),
            onclose: (e) => console.debug("❌ Closed:", e.reason),
        },
    });

    const wavFilePath = "record.wav";
    const wavBytes = fs.readFileSync(wavFilePath);

    session.sendClientContent({
        data: wavBytes,               // 二进制音频数据
        mimeType: "audio/wav",        // 告诉模型格式
        instructions: "Transcribe this audio to English text.", // 提示词
    });

    const turns = await handleTurn();

    for (const turn of turns) {
        if (turn.serverContent?.outputTranscription) {
            console.debug(
                "🎙️ Transcription:",
                turn.serverContent.outputTranscription.text
            );
        }
    }

    session.close();
}

async function main() {
    try {
        await live();
    } catch (e) {
        console.error("❌ got error:", e);
    }
}

main();
