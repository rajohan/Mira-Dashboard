import { json } from "../http.ts";
import { stringFallback } from "../lib/values.ts";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const ELEVENLABS_TIMEOUT_MS = 60_000;
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v2";
const ELEVENLABS_STT_LANGUAGE = process.env.ELEVENLABS_STT_LANGUAGE || "nor";

const sttRouteState = { isActiveTranscription: false };

function audioExtension(contentType?: string): string {
    if (!contentType) return ".webm";
    const normalizedContentType = contentType.toLowerCase();
    if (normalizedContentType.includes("mp4") || normalizedContentType.includes("m4a")) {
        return ".m4a";
    }
    if (normalizedContentType.includes("mpeg") || normalizedContentType.includes("mp3")) {
        return ".mp3";
    }
    if (normalizedContentType.includes("ogg")) return ".ogg";
    if (normalizedContentType.includes("wav")) return ".wav";
    return ".webm";
}

function transcriptTextFromElevenLabs(result?: unknown): string {
    if (!result || typeof result !== "object") return "";

    const record = result as { text?: unknown; words?: unknown };
    if (typeof record.text === "string" && record.text.trim()) {
        return record.text.trim();
    }
    if (!Array.isArray(record.words)) return "";

    return record.words
        .map((word) => {
            if (!word || typeof word !== "object") return "";
            const text = (word as { text?: unknown }).text;
            return typeof text === "string" ? text.trim() : "";
        })
        .filter(Boolean)
        .join(" ")
        .trim();
}

async function readResponseTextFallback(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch {
        return "";
    }
}

async function transcribeWithElevenLabs(
    audioBuffer: Buffer,
    contentType: string | undefined
): Promise<string> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        throw new Error("ELEVENLABS_API_KEY is not configured");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);
    const formData = new FormData();
    const safeContentType = contentType?.trim() || undefined;
    const fileName = `recording${audioExtension(safeContentType)}`;
    const audioBlob = new Blob([Uint8Array.from(audioBuffer)], {
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
            body: formData,
            headers: { "xi-api-key": apiKey },
            method: "POST",
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

export const sttRoutes = {
    "/api/stt/transcribe": {
        POST: async (request: Request) => {
            if (sttRouteState.isActiveTranscription) {
                return json(
                    { error: "Another transcription is already running" },
                    { status: 429 }
                );
            }

            const contentLength = Number(request.headers.get("content-length") || 0);
            if (contentLength > MAX_AUDIO_BYTES) {
                return json({ error: "request entity too large" }, { status: 413 });
            }

            const audioBuffer = Buffer.from(await request.arrayBuffer());
            if (audioBuffer.length === 0) {
                return json({ error: "Missing audio payload" }, { status: 400 });
            }
            if (audioBuffer.length > MAX_AUDIO_BYTES) {
                return json({ error: "request entity too large" }, { status: 413 });
            }

            sttRouteState.isActiveTranscription = true;
            try {
                const text = await transcribeWithElevenLabs(
                    audioBuffer,
                    request.headers.get("content-type") || undefined
                );
                return json({ provider: "elevenlabs", text });
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : typeof error === "string"
                          ? error
                          : undefined;
                return json(
                    { error: stringFallback(message, "Failed to transcribe audio") },
                    { status: 500 }
                );
            } finally {
                sttRouteState.isActiveTranscription = false;
            }
        },
    },
} as const;
