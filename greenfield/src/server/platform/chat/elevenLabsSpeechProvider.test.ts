import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";

import { Redacted } from "effect";

import { chatSpeechLimits } from "../../../contracts/chatSpeech.ts";
import type { ValidatedChatSpeechRecording } from "./chatSpeechRecording.ts";
import {
    ChatSpeechProviderFailure,
    createElevenLabsSpeechProvider,
} from "./elevenLabsSpeechProvider.ts";

const recording = Object.freeze({
    bytes: Uint8Array.of(1, 2, 3),
    contentType: "audio/webm;codecs=opus",
    durationMs: 1000,
    fileName: "recording.webm",
} satisfies ValidatedChatSpeechRecording);

function fetchMock(
    implementation: (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
    ) => Promise<Response> | Response
): typeof fetch {
    const fetchImplementation = (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
    ): Promise<Response> => Promise.resolve(implementation(input, init));
    return Object.assign(fetchImplementation, {
        preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch),
    });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

describe("ElevenLabs speech provider", () => {
    test("uses exact production STT/TTS methods without exposing its credential", async () => {
        const secret = "elevenlabs-provider-secret";
        const requests: { init: RequestInit; url: string }[] = [];
        const provider = createElevenLabsSpeechProvider({
            apiKey: Redacted.make(secret),
            fetch: fetchMock((input, init = {}) => {
                const url = requestUrl(input);
                requests.push({ init, url });
                if (url.endsWith("/speech-to-text")) {
                    return Response.json(
                        { language_code: "nb", text: " Hei fra lyd " },
                        { headers: { "content-type": "application/json" } }
                    );
                }
                return new Response(Uint8Array.of(255, 251, 144), {
                    headers: { "content-type": "audio/mpeg" },
                    status: 200,
                });
            }),
        });
        const signal = new AbortController().signal;

        expect(await provider.transcribe(recording, signal)).toBe("Hei fra lyd");
        expect(await provider.synthesize("Les dette", signal)).toEqual(
            Uint8Array.of(255, 251, 144)
        );

        expect(requests).toHaveLength(2);
        expect(requests[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
        expect(requests[0]!.init).toMatchObject({ method: "POST", redirect: "manual" });
        expect(new Headers(requests[0]!.init.headers).get("xi-api-key")).toBe(secret);
        const form = requests[0]!.init.body as FormData;
        expect(form.get("model_id")).toBe("scribe_v2");
        expect(form.get("tag_audio_events")).toBe("false");
        expect(form.get("diarize")).toBe("false");
        expect(form.get("file")).toBeInstanceOf(File);

        expect(requests[1]!.url).toBe(
            "https://api.elevenlabs.io/v1/text-to-speech/q7O4dHCU5KzDbUYNsckR?output_format=mp3_44100_128"
        );
        expect(JSON.parse(requests[1]!.init.body as string)).toEqual({
            model_id: "eleven_turbo_v2_5",
            text: "Les dette",
            voice_settings: { similarity_boost: 0.75, stability: 0.5 },
        });
        expect(JSON.stringify(provider)).not.toContain(secret);
        expect(inspect(provider)).not.toContain(secret);
    });

    test("rejects redirects, provider diagnostics, malformed text, MIME, and oversized audio", async () => {
        const sentinel = "raw-upstream-provider-diagnostic";
        const cases: readonly Response[] = [
            new Response(sentinel, { status: 307 }),
            new Response(sentinel, {
                headers: { "content-type": "text/html" },
                status: 200,
            }),
            Response.json(
                { text: "" },
                { headers: { "content-type": "application/json" } }
            ),
            new Response(Uint8Array.of(1), {
                headers: { "content-type": "application/octet-stream" },
                status: 200,
            }),
            new Response(Uint8Array.of(1), {
                headers: {
                    "content-length": String(
                        chatSpeechLimits.maximumGeneratedAudioBytes + 1
                    ),
                    "content-type": "audio/mpeg",
                },
                status: 200,
            }),
        ];

        for (const [index, response] of cases.entries()) {
            const provider = createElevenLabsSpeechProvider({
                apiKey: Redacted.make("secret"),
                fetch: fetchMock(() => response),
            });
            let failure: unknown;
            try {
                await (index <= 2
                    ? provider.transcribe(recording, new AbortController().signal)
                    : provider.synthesize("Les", new AbortController().signal));
            } catch (error: unknown) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(ChatSpeechProviderFailure);
            expect(String(failure)).not.toContain(sentinel);
            expect(inspect(failure)).not.toContain(sentinel);
        }
    });

    test("maps only its own deadline to timeout and preserves caller cancellation", async () => {
        const fetchUntilAborted = fetchMock(
            (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener(
                        "abort",
                        () => {
                            const reason: unknown = init.signal?.reason;
                            reject(
                                reason instanceof Error ? reason : new Error("aborted")
                            );
                        },
                        { once: true }
                    );
                })
        );
        const provider = createElevenLabsSpeechProvider({
            apiKey: Redacted.make("secret"),
            fetch: fetchUntilAborted,
            timeoutMs: 1,
        });

        let timeoutFailure: unknown;
        try {
            await provider.synthesize("Les", new AbortController().signal);
        } catch (error: unknown) {
            timeoutFailure = error;
        }
        expect(timeoutFailure).toMatchObject({ reason: "timeout" });

        const cancellation = new Error("caller-cancelled");
        const controller = new AbortController();
        const pending = provider.transcribe(recording, controller.signal);
        controller.abort(cancellation);
        let cancellationFailure: unknown;
        try {
            await pending;
        } catch (error: unknown) {
            cancellationFailure = error;
        }
        expect(cancellationFailure).toBe(cancellation);
    });
});
