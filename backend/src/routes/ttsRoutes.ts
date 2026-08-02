import { parseTextToSpeechRequest } from "../../../contracts/tts.ts";
import { readResponseTextFallback } from "../http/core.ts";
import { readApiJsonOrError, routeFailureResponse } from "../http/routeSupport.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";

const ELEVENLABS_TTS_TIMEOUT_MS = 60_000;
const ELEVENLABS_TTS_MODEL = "eleven_turbo_v2_5";
const ELEVENLABS_TTS_VOICE_ID = "q7O4dHCU5KzDbUYNsckR";
const logger = createStructuredLogger("text-to-speech");

export const ttsRoutes = {
    "/api/tts/speak": {
        POST: async (request: Request) => {
            const apiKey = process.env.ELEVENLABS_API_KEY;
            if (!apiKey) {
                return routeFailureResponse({
                    context: "tts",
                    message: "ELEVENLABS_API_KEY is not configured",
                    status: 500,
                });
            }

            const body = await readApiJsonOrError(request, parseTextToSpeechRequest, {
                code: "invalid_tts_request",
                context: "tts.request",
                message: "Invalid TTS request",
            });
            if (body instanceof Response) return body;
            const { text } = body;

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
                    logger.error("tts.upstream_request_failed", {
                        body: errorText,
                        status: elevenLabsResponse.status,
                    });
                    return routeFailureResponse({
                        context: "tts",
                        message: "TTS service temporarily unavailable",
                        status: elevenLabsResponse.status,
                    });
                }

                return new Response(elevenLabsResponse.body, {
                    headers: {
                        "Cache-Control": "no-store",
                        "Content-Type": "audio/mpeg",
                    },
                });
            } catch (error) {
                if (controller.signal.aborted) {
                    return routeFailureResponse({
                        context: "tts",
                        message: "TTS request timed out",
                        status: 504,
                    });
                }
                logger.error("tts.generation_failed", { error });
                return routeFailureResponse({
                    context: "tts",
                    message: "Failed to generate speech",
                    status: 500,
                });
            } finally {
                clearTimeout(timer);
            }
        },
    },
} as const;
