import { describe, expect, test } from "bun:test";

import {
    chatSpeechCapabilitiesPath,
    chatSpeechLimits,
    chatSpeechSynthesisPath,
    chatSpeechTranscriptionPath,
} from "../../contracts/chatSpeech.ts";
import type { AuthenticatedPrincipal } from "../../contracts/security.ts";
import type { ChatSpeechProvider } from "../platform/chat/elevenLabsSpeechProvider.ts";
import { dashboardSessionCookieName } from "./authenticationCredentials.ts";
import { createChatSpeechRawHttpHandler, chatSpeechRateLimits } from "./chatSpeech.ts";

const origin = "https://dashboard.example.test";
const sessionToken = `${"0".repeat(32)}.${"1".repeat(64)}`;

function join(...parts: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}

function littleEndian(value: number | bigint, length: number): Uint8Array {
    let remaining = BigInt(value);
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
        result[index] = Number(remaining & 255n);
        remaining >>= 8n;
    }
    return result;
}

function oggPage(
    payload: Uint8Array,
    flags: number,
    granule: bigint,
    sequence: number
): Uint8Array {
    return join(
        new TextEncoder().encode("OggS"),
        Uint8Array.of(0, flags),
        littleEndian(granule, 8),
        littleEndian(7, 4),
        littleEndian(sequence, 4),
        new Uint8Array(4),
        Uint8Array.of(1, payload.byteLength),
        payload
    );
}

function validRecording(): Uint8Array {
    const head = join(
        new TextEncoder().encode("OpusHead"),
        Uint8Array.of(1, 1),
        littleEndian(312, 2),
        littleEndian(48_000, 4),
        new Uint8Array(3)
    );
    const pages = [
        oggPage(head, 0x02, 0n, 0),
        oggPage(new TextEncoder().encode("OpusTags"), 0, 0n, 1),
    ];
    for (let index = 0; index < 50; index += 1) {
        const isFinal = index === 49;
        pages.push(
            oggPage(
                Uint8Array.of(0x08),
                isFinal ? 0x04 : 0,
                312n + BigInt(index + 1) * 960n,
                index + 2
            )
        );
    }
    return join(...pages);
}

function principal(
    capabilities: AuthenticatedPrincipal["capabilities"],
    id = "019fe633-9133-7ba0-8b80-809dd80dfb40"
): AuthenticatedPrincipal {
    return {
        authorizationVersion: 1,
        authenticatorId: "0".repeat(32),
        capabilities,
        id,
        kind: "session",
    } as unknown as AuthenticatedPrincipal;
}

function indexedPrincipalId(index: number): string {
    return `019fe633-9133-7ba0-8b80-${index.toString(16).padStart(12, "0")}`;
}

function authentication(principalValue?: AuthenticatedPrincipal) {
    return () =>
        principalValue === undefined
            ? { authentication: { kind: "anonymous" as const } }
            : {
                  authentication: {
                      kind: "authenticated" as const,
                      principal: principalValue,
                  },
                  lease: {
                      expiresAtMs: 4_000_000_000_000_000,
                      revalidate: () => Promise.resolve(),
                  },
              };
}

function request(path: string, init: RequestInit = {}, requestOrigin = origin): Request {
    const headers = new Headers(init.headers);
    headers.set("cookie", `${dashboardSessionCookieName}=${sessionToken}`);
    headers.set("origin", requestOrigin);
    headers.set("sec-fetch-site", "same-origin");
    return new Request(`${origin}${path}`, { ...init, headers });
}

function transcriptionRequest(bytes = validRecording()): Request {
    return request(chatSpeechTranscriptionPath, {
        body: bytes,
        headers: {
            "content-length": String(bytes.byteLength),
            "content-type": "audio/ogg;codecs=opus",
        },
        method: "POST",
    });
}

function synthesisRequest(text = "Les dette"): Request {
    const body = JSON.stringify({ text });
    return request(chatSpeechSynthesisPath, {
        body,
        headers: {
            "content-length": String(Buffer.byteLength(body)),
            "content-type": "application/json",
        },
        method: "POST",
    });
}

const successfulProvider: ChatSpeechProvider = {
    synthesize: () => Promise.resolve(Uint8Array.of(255, 251, 144)),
    transcribe: () => Promise.resolve("Hei fra opptaket"),
};

describe("chat speech raw HTTP boundary", () => {
    test("reports caller-scoped capability without exposing provider identity", async () => {
        for (const [provider, capabilities, expected] of [
            [successfulProvider, ["chat:write"], true],
            [successfulProvider, ["chat:read"], false],
            [undefined, ["chat:write"], false],
        ] as const) {
            const handler = createChatSpeechRawHttpHandler({
                authenticateCredential: authentication(principal(capabilities)),
                browserOrigin: origin,
                ...(provider === undefined ? {} : { provider }),
            });
            const response = await handler(
                request(chatSpeechCapabilitiesPath),
                new URL(`${origin}${chatSpeechCapabilitiesPath}`)
            );
            expect(response?.status).toBe(200);
            expect(await response!.json()).toEqual({
                speechToText: expected,
                textToSpeech: expected,
            });
            expect(response?.headers.get("cache-control")).toBe("private, no-store");
        }
    });

    test("transcribes one exact bounded recording and returns only sanitized text", async () => {
        const observed: unknown[] = [];
        const handler = createChatSpeechRawHttpHandler({
            authenticateCredential: authentication(principal(["chat:write"])),
            browserOrigin: origin,
            provider: {
                ...successfulProvider,
                transcribe(recording, signal) {
                    observed.push({ recording, signal });
                    return Promise.resolve("Hei fra opptaket");
                },
            },
        });
        const incoming = transcriptionRequest();
        const response = await handler(incoming, new URL(incoming.url));

        expect(response?.status).toBe(200);
        const responseBody = await response!.text();
        expect(JSON.parse(responseBody)).toEqual({ transcript: "Hei fra opptaket" });
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({
            recording: {
                contentType: "audio/ogg;codecs=opus",
                durationMs: 1000,
                fileName: "recording.ogg",
            },
        });
        expect(response?.headers.get("content-type")).toBe(
            "application/json; charset=utf-8"
        );
        expect(responseBody).not.toContain("elevenlabs");
    });

    test("synthesizes bounded no-store MPEG audio under chat:write", async () => {
        const texts: string[] = [];
        const handler = createChatSpeechRawHttpHandler({
            authenticateCredential: authentication(principal(["chat:write"])),
            browserOrigin: origin,
            provider: {
                ...successfulProvider,
                synthesize(text) {
                    texts.push(text);
                    return Promise.resolve(Uint8Array.of(255, 251, 144));
                },
            },
        });
        const incoming = synthesisRequest("  Les dette  ");
        const response = await handler(incoming, new URL(incoming.url));

        expect(response?.status).toBe(200);
        expect(texts).toEqual(["Les dette"]);
        expect(response?.headers.get("content-type")).toBe("audio/mpeg");
        expect(response?.headers.get("content-length")).toBe("3");
        expect(response?.headers.get("cache-control")).toBe("private, no-store");
        expect(new Uint8Array(await response!.arrayBuffer())).toEqual(
            Uint8Array.of(255, 251, 144)
        );
    });

    test("fails closed for source, authentication, capability, configuration, MIME, and budget defects", async () => {
        const configured = createChatSpeechRawHttpHandler({
            authenticateCredential: authentication(principal(["chat:write"])),
            browserOrigin: origin,
            provider: successfulProvider,
        });
        const readOnly = createChatSpeechRawHttpHandler({
            authenticateCredential: authentication(principal(["chat:read"])),
            browserOrigin: origin,
            provider: successfulProvider,
        });
        const unconfigured = createChatSpeechRawHttpHandler({
            authenticateCredential: authentication(principal(["chat:write"])),
            browserOrigin: origin,
        });
        const unauthenticated = createChatSpeechRawHttpHandler({
            authenticateCredential: authentication(),
            browserOrigin: origin,
            provider: successfulProvider,
        });
        const cases: readonly [
            ReturnType<typeof createChatSpeechRawHttpHandler>,
            Request,
            number,
        ][] = [
            [
                configured,
                request(chatSpeechCapabilitiesPath, {}, "https://attacker.example.test"),
                403,
            ],
            [unauthenticated, request(chatSpeechCapabilitiesPath), 401],
            [readOnly, transcriptionRequest(), 403],
            [unconfigured, transcriptionRequest(), 503],
            [
                configured,
                request(chatSpeechTranscriptionPath, {
                    body: Uint8Array.of(1),
                    headers: { "content-length": "1", "content-type": "audio/mpeg" },
                    method: "POST",
                }),
                415,
            ],
            [
                configured,
                request(chatSpeechTranscriptionPath, {
                    body: Uint8Array.of(1),
                    headers: {
                        "content-length": String(
                            chatSpeechLimits.maximumRecordingBytes + 1
                        ),
                        "content-type": "audio/ogg;codecs=opus",
                    },
                    method: "POST",
                }),
                413,
            ],
            [configured, request(`${chatSpeechCapabilitiesPath}?provider=1`), 404],
            [configured, request(chatSpeechSynthesisPath, { method: "GET" }), 405],
        ];
        for (const [handler, incoming, status] of cases) {
            const response = await handler(incoming, new URL(incoming.url));
            expect(response?.status).toBe(status);
        }
    });

    test("bounds concurrency, releases capacity, and hides arbitrary provider failures", async () => {
        const first = Promise.withResolvers<string>();
        let calls = 0;
        const handler = createChatSpeechRawHttpHandler({
            authenticateCredential: authentication(principal(["chat:write"])),
            browserOrigin: origin,
            provider: {
                ...successfulProvider,
                transcribe() {
                    calls += 1;
                    return calls === 1
                        ? first.promise
                        : Promise.reject(new Error("raw provider secret"));
                },
            },
        });

        const firstRequest = transcriptionRequest();
        const pending = handler(firstRequest, new URL(firstRequest.url));
        for (let index = 0; index < 32 && calls === 0; index += 1) {
            await Promise.resolve();
        }
        expect(calls).toBe(1);
        const secondRequest = transcriptionRequest();
        const capacity = await handler(secondRequest, new URL(secondRequest.url));
        expect(capacity?.status).toBe(429);

        first.resolve("done");
        const completed = await pending;
        expect(completed?.status).toBe(200);
        const thirdRequest = transcriptionRequest();
        const failure = await handler(thirdRequest, new URL(thirdRequest.url));
        expect(failure?.status).toBe(502);
        const failureBody = await failure!.text();
        expect(failureBody).toBe("Speech provider unavailable");
        expect(failureBody).not.toContain("raw provider secret");
    });

    test("rate-budgets paid speech work per principal in separate rolling lanes", async () => {
        let nowMs = 1000;
        let activePrincipal = principal(
            ["chat:write"],
            "019fe633-9133-7ba0-8b80-809dd80dfb41"
        );
        let transcriptionCalls = 0;
        let synthesisCalls = 0;
        const handler = createChatSpeechRawHttpHandler({
            authenticateCredential: () => authentication(activePrincipal)(),
            browserOrigin: origin,
            nowMs: () => nowMs,
            provider: {
                synthesize: () => {
                    synthesisCalls += 1;
                    return Promise.resolve(Uint8Array.of(255));
                },
                transcribe: () => {
                    transcriptionCalls += 1;
                    return Promise.resolve("transcript");
                },
            },
        });
        const run = async (incoming: Request): Promise<Response> => {
            const response = await handler(incoming, new URL(incoming.url));
            if (response === undefined) throw new Error("Speech route was not handled");
            return response;
        };

        for (
            let index = 0;
            index < chatSpeechRateLimits.transcription.maximumRequests;
            index += 1
        ) {
            const response = await run(transcriptionRequest());
            expect(response.status).toBe(200);
        }
        const blockedTranscription = await run(transcriptionRequest());
        expect(blockedTranscription.status).toBe(429);
        expect(transcriptionCalls).toBe(
            chatSpeechRateLimits.transcription.maximumRequests
        );

        activePrincipal = principal(
            ["chat:write"],
            "019fe633-9133-7ba0-8b80-809dd80dfb42"
        );
        const otherPrincipalTranscription = await run(transcriptionRequest());
        expect(otherPrincipalTranscription.status).toBe(200);
        nowMs += chatSpeechRateLimits.windowMs + 1;
        activePrincipal = principal(
            ["chat:write"],
            "019fe633-9133-7ba0-8b80-809dd80dfb41"
        );
        const nextWindowTranscription = await run(transcriptionRequest());
        expect(nextWindowTranscription.status).toBe(200);

        activePrincipal = principal(
            ["chat:write"],
            "019fe633-9133-7ba0-8b80-809dd80dfb43"
        );
        const fullChunk = "x".repeat(chatSpeechLimits.maximumSynthesisTextCharacters);
        const admittedFullChunks =
            chatSpeechRateLimits.synthesis.maximumCharacters /
            chatSpeechLimits.maximumSynthesisTextCharacters;
        for (let index = 0; index < admittedFullChunks; index += 1) {
            const response = await run(synthesisRequest(fullChunk));
            expect(response.status).toBe(200);
        }
        const blockedSynthesisByCharacters = await run(synthesisRequest("x"));
        expect(blockedSynthesisByCharacters.status).toBe(429);

        activePrincipal = principal(
            ["chat:write"],
            "019fe633-9133-7ba0-8b80-809dd80dfb44"
        );
        for (
            let index = 0;
            index < chatSpeechRateLimits.synthesis.maximumRequests;
            index += 1
        ) {
            const response = await run(synthesisRequest("x"));
            expect(response.status).toBe(200);
        }
        const blockedSynthesisByRequests = await run(synthesisRequest("x"));
        expect(blockedSynthesisByRequests.status).toBe(429);
        expect(synthesisCalls).toBe(
            admittedFullChunks + chatSpeechRateLimits.synthesis.maximumRequests
        );
    });

    test("fails closed when the rate identity registry or admission clock is invalid", async () => {
        let activePrincipal = principal(["chat:write"], indexedPrincipalId(0));
        let providerCalls = 0;
        const boundedHandler = createChatSpeechRawHttpHandler({
            authenticateCredential: () => authentication(activePrincipal)(),
            browserOrigin: origin,
            nowMs: () => 1000,
            provider: {
                ...successfulProvider,
                synthesize: () => {
                    providerCalls += 1;
                    return Promise.resolve(Uint8Array.of(255));
                },
            },
        });
        for (
            let index = 0;
            index < chatSpeechRateLimits.maximumTrackedPrincipals;
            index += 1
        ) {
            activePrincipal = principal(["chat:write"], indexedPrincipalId(index));
            const incoming = synthesisRequest();
            const response = await boundedHandler(incoming, new URL(incoming.url));
            expect(response?.status).toBe(200);
        }
        activePrincipal = principal(
            ["chat:write"],
            indexedPrincipalId(chatSpeechRateLimits.maximumTrackedPrincipals)
        );
        const overflowRequest = synthesisRequest();
        const overflowResponse = await boundedHandler(
            overflowRequest,
            new URL(overflowRequest.url)
        );
        expect(overflowResponse?.status).toBe(429);
        expect(providerCalls).toBe(chatSpeechRateLimits.maximumTrackedPrincipals);

        const invalidClockHandler = createChatSpeechRawHttpHandler({
            authenticateCredential: authentication(principal(["chat:write"])),
            browserOrigin: origin,
            nowMs: () => Number.NaN,
            provider: {
                ...successfulProvider,
                synthesize: () => {
                    providerCalls += 1;
                    return Promise.resolve(Uint8Array.of(255));
                },
            },
        });
        const invalidClockRequest = synthesisRequest();
        const invalidClockResponse = await invalidClockHandler(
            invalidClockRequest,
            new URL(invalidClockRequest.url)
        );
        expect(invalidClockResponse?.status).toBe(429);
        expect(providerCalls).toBe(chatSpeechRateLimits.maximumTrackedPrincipals);
    });
});
