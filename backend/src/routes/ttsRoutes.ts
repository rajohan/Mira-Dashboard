import { json, readJson, readResponseTextFallback } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";

const ELEVENLABS_TTS_TIMEOUT_MS = 60_000;
const ELEVENLABS_TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || "eleven_turbo_v2_5";
const ELEVENLABS_TTS_VOICE_ID =
    process.env.ELEVENLABS_TTS_VOICE_ID ||
    process.env.ELEVENLABS_VOICE_ID ||
    "q7O4dHCU5KzDbUYNsckR";
const MAX_TTS_TEXT_LENGTH = 4_000;

interface TtsRequestBody {
    text?: unknown;
}

function normalizeTtsText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export const ttsRoutes = {
    "/api/tts/speak": {
        POST: async (request: Request) => {
            const apiKey = process.env.ELEVENLABS_API_KEY;
            if (!apiKey) {
                return json(
                    { error: "ELEVENLABS_API_KEY is not configured" },
                    { status: 500 }
                );
            }

            let body: TtsRequestBody | undefined;
            try {
                body = await readJson<TtsRequestBody | undefined>(request);
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Invalid JSON") },
                    { status: httpStatusCode(error) }
                );
            }
            const text = normalizeTtsText(body?.text);
            if (!text) {
                return json({ error: "Missing text" }, { status: 400 });
            }
            if (text.length > MAX_TTS_TEXT_LENGTH) {
                return json(
                    {
                        error: `Text is too long. Max is ${MAX_TTS_TEXT_LENGTH} characters.`,
                    },
                    { status: 400 }
                );
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), ELEVENLABS_TTS_TIMEOUT_MS);
            try {
                const elevenLabsResponse = await fetch(
                    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_TTS_VOICE_ID}`,
                    {
                        body: JSON.stringify({
                            model_id: ELEVENLABS_TTS_MODEL,
                            text,
                            voice_settings: {
                                similarity_boost: 0.75,
                                stability: 0.5,
                            },
                        }),
                        headers: {
                            "Content-Type": "application/json",
                            "xi-api-key": apiKey,
                        },
                        method: "POST",
                        signal: controller.signal,
                    }
                );

                if (!elevenLabsResponse.ok) {
                    const errorText = await readResponseTextFallback(elevenLabsResponse);
                    return json(
                        {
                            error:
                                errorText ||
                                `ElevenLabs TTS failed (${elevenLabsResponse.status})`,
                        },
                        { status: elevenLabsResponse.status }
                    );
                }

                return new Response(await elevenLabsResponse.arrayBuffer(), {
                    headers: {
                        "Cache-Control": "no-store",
                        "Content-Type": "audio/mpeg",
                    },
                });
            } catch (error) {
                return json(
                    {
                        error:
                            error instanceof Error && error.message
                                ? error.message
                                : "Failed to generate speech",
                    },
                    { status: 500 }
                );
            } finally {
                clearTimeout(timer);
            }
        },
    },
} as const;
