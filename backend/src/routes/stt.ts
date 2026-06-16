import type express from "express";

import { stringFallback } from "../lib/values.js";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const ELEVENLABS_TIMEOUT_MS = 60_000;
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v2";
const ELEVENLABS_STT_LANGUAGE = process.env.ELEVENLABS_STT_LANGUAGE || "nor";

let activeTranscription = false;

/** Performs audio extension. */
function audioExtension(contentType?: string): string {
    if (!contentType) {
        return ".webm";
    }
    const normalizedContentType = contentType.toLowerCase();

    if (normalizedContentType.includes("mp4") || normalizedContentType.includes("m4a")) {
        return ".m4a";
    }
    if (normalizedContentType.includes("mpeg") || normalizedContentType.includes("mp3")) {
        return ".mp3";
    }
    if (normalizedContentType.includes("ogg")) {
        return ".ogg";
    }

    if (normalizedContentType.includes("wav")) {
        return ".wav";
    }
    return ".webm";
}

/** Performs transcript text from eleven labs. */
function transcriptTextFromElevenLabs(result?: unknown): string {
    if (!result || typeof result !== "object") {
        return "";
    }

    const record = result as { text?: unknown; words?: unknown };
    if (typeof record.text === "string" && record.text.trim()) {
        return record.text.trim();
    }
    if (!Array.isArray(record.words)) {
        return "";
    }

    return record.words
        .map((word) => {
            if (!word || typeof word !== "object") {
                return "";
            }

            const text = (word as { text?: unknown }).text;
            return typeof text === "string" ? text.trim() : "";
        })
        .filter(Boolean)
        .join(" ")
        .trim();
}

/** Performs transcribe with eleven labs. */
async function transcribeWithElevenLabs(
    audioBuffer: Buffer,
    contentType: string | string[] | undefined
): Promise<string> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        throw new Error("ELEVENLABS_API_KEY is not configured");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
    const formData = new FormData();
    const rawContentType = Array.isArray(contentType) ? contentType[0] : contentType;
    const safeContentType = rawContentType?.trim() || undefined;
    const fileName = `recording${audioExtension(safeContentType)}`;
    const audioBytes = Uint8Array.from(audioBuffer);
    const audioBlob = new Blob([audioBytes], {
        type: stringFallback(safeContentType, "application/octet-stream"),
    });

    formData.append("file", audioBlob, fileName);
    formData.append("model_id", ELEVENLABS_STT_MODEL);
    formData.append("tag_audio_events", "false");
    formData.append("diarize", "false");

    if (ELEVENLABS_STT_LANGUAGE && ELEVENLABS_STT_LANGUAGE !== "auto") {
        formData.append("language_code", ELEVENLABS_STT_LANGUAGE);
    }

    try {
        const response = await fetch(ELEVENLABS_API_URL, {
            method: "POST",
            headers: { "xi-api-key": apiKey },
            body: formData,
            signal: controller.signal,
        });

        if (!response.ok) {
            const errorText = await readResponseTextFallback(response);
            throw new Error(
                `ElevenLabs STT failed (${response.status}): ${errorText || response.statusText}`
            );
        }

        return transcriptTextFromElevenLabs(await response.json());
    } finally {
        clearTimeout(timer);
    }
}

async function readResponseTextFallback(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch {
        return "";
    }
}

/** Registers stt API routes. */
export default function sttRoutes(app: express.Express, expressModule: typeof express) {
    app.post(
        "/api/stt/transcribe",
        expressModule.raw({
            type: ["audio/*", "application/octet-stream"],
            limit: MAX_AUDIO_BYTES,
        }),
        (async (request, response) => {
            if (activeTranscription) {
                response
                    .status(429)
                    .json({ error: "Another transcription is already running" });
                return;
            }
            const audioBuffer = Buffer.isBuffer(request.body) ? request.body : null;
            if (!audioBuffer || audioBuffer.length === 0) {
                response.status(400).json({ error: "Missing audio payload" });
                return;
            }

            activeTranscription = true;

            try {
                const text = await transcribeWithElevenLabs(
                    audioBuffer,
                    request.headers["content-type"]
                );
                response.json({ provider: "elevenlabs", text });
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : typeof error === "string"
                          ? error
                          : undefined;
                response.status(500).json({
                    error: stringFallback(message, "Failed to transcribe audio"),
                });
            } finally {
                activeTranscription = false;
            }
        }) as express.RequestHandler
    );
}

export const __testing = {
    audioExtension,
    readResponseTextFallback,
    transcribeWithElevenLabs,
    transcriptTextFromElevenLabs,
};
