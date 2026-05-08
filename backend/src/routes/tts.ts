import type express from "express";

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

export default function ttsRoutes(app: express.Express, expressModule: typeof express) {
    app.post("/api/tts/speak", expressModule.json({ limit: "64kb" }), (async (
        request,
        response
    ) => {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            response.status(500).json({ error: "ELEVENLABS_API_KEY is not configured" });
            return;
        }

        const text = normalizeTtsText((request.body as TtsRequestBody | undefined)?.text);
        if (!text) {
            response.status(400).json({ error: "Missing text" });
            return;
        }

        if (text.length > MAX_TTS_TEXT_LENGTH) {
            response.status(400).json({
                error: `Text is too long. Max is ${MAX_TTS_TEXT_LENGTH} characters.`,
            });
            return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ELEVENLABS_TTS_TIMEOUT_MS);

        try {
            const elevenLabsResponse = await fetch(
                `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_TTS_VOICE_ID}`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "xi-api-key": apiKey,
                    },
                    body: JSON.stringify({
                        text,
                        model_id: ELEVENLABS_TTS_MODEL,
                        voice_settings: {
                            stability: 0.5,
                            similarity_boost: 0.75,
                        },
                    }),
                    signal: controller.signal,
                }
            );

            if (!elevenLabsResponse.ok) {
                const errorText = await elevenLabsResponse.text().catch(() => "");
                response.status(elevenLabsResponse.status).json({
                    error:
                        errorText ||
                        `ElevenLabs TTS failed (${elevenLabsResponse.status})`,
                });
                return;
            }

            const audioBuffer = Buffer.from(await elevenLabsResponse.arrayBuffer());
            response.setHeader("Content-Type", "audio/mpeg");
            response.setHeader("Cache-Control", "no-store");
            response.send(audioBuffer);
        } catch (error) {
            response.status(500).json({
                error: (error as Error).message || "Failed to generate speech",
            });
        } finally {
            clearTimeout(timer);
        }
    }) as express.RequestHandler);
}
