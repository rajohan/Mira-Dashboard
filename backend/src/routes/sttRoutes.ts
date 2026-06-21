import { HttpError, json, readRequestBytes, readResponseTextFallback } from "../http.ts";
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
    const audioBlob = new Blob([audioBuffer], {
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
        let response: Response;
        try {
            response = await fetch(ELEVENLABS_API_URL, {
                body: formData,
                headers: { "xi-api-key": apiKey },
                method: "POST",
                signal: controller.signal,
            });
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new HttpError("STT request timed out", 504);
            }
            throw error;
        }
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

            try {
                const audioBuffer = await readRequestBytes(request, MAX_AUDIO_BYTES);
                if (audioBuffer.length === 0) {
                    return json({ error: "Missing audio payload" }, { status: 400 });
                }

                sttRouteState.isActiveTranscription = true;
                const text = await transcribeWithElevenLabs(
                    audioBuffer,
                    request.headers.get("content-type") || undefined
                );
                return json({ provider: "elevenlabs", text });
            } catch (error) {
                if (error instanceof HttpError) {
                    return json({ error: error.message }, { status: error.statusCode });
                }
                console.error(
                    "[STT] Transcription failed:",
                    error instanceof Error ? error.message : String(error)
                );
                return json({ error: "Failed to transcribe audio" }, { status: 500 });
            } finally {
                if (sttRouteState.isActiveTranscription) {
                    sttRouteState.isActiveTranscription = false;
                }
            }
        },
    },
} as const;
