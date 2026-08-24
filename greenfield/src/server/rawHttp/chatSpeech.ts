import * as v from "valibot";

import {
    chatSpeechCapabilitiesOutputSchema,
    chatSpeechCapabilitiesPath,
    chatSpeechLimits,
    chatSpeechRecordingContentTypes,
    chatSpeechSynthesisInputSchema,
    chatSpeechSynthesisPath,
    chatSpeechTranscriptionOutputSchema,
    chatSpeechTranscriptionPath,
} from "../../contracts/chatSpeech.ts";
import type { AuthenticatedPrincipal } from "../../contracts/security.ts";
import { parseAuthenticationResolution } from "../domains/security/authenticationResolution.ts";
import {
    ChatSpeechRecordingValidationError,
    validateChatSpeechRecording,
} from "../platform/chat/chatSpeechRecording.ts";
import {
    type ChatSpeechProvider,
    ChatSpeechProviderFailure,
} from "../platform/chat/elevenLabsSpeechProvider.ts";
import type { AuthenticateCredential } from "../trpc/context.ts";
import { readAuthenticationHttpCredentials } from "./authenticationCredentials.ts";
import { isAllowedRequestSource } from "./requestSecurity.ts";

export const chatSpeechBodyReadTimeoutMs = 15_000;
export const chatSpeechRateLimits = Object.freeze({
    maximumTrackedPrincipals: 128,
    synthesis: Object.freeze({
        maximumCharacters: 16_000,
        maximumRequests: 12,
    }),
    transcription: Object.freeze({
        maximumDurationMs: 240_000,
        maximumRequests: 6,
    }),
    windowMs: 60_000,
});
const chatSpeechRecordingContentTypeSet: ReadonlySet<string> = new Set(
    chatSpeechRecordingContentTypes
);

export interface ChatSpeechRawHttpHandlerOptions {
    readonly authenticateCredential: AuthenticateCredential;
    readonly browserOrigin?: string;
    readonly nowMs?: () => number;
    readonly provider?: ChatSpeechProvider;
}

export type ChatSpeechRawHttpHandler = (
    request: Request,
    requestUrl: URL
) => Promise<Response | undefined>;

function noStoreResponse(
    body: string | Uint8Array | null,
    status: number,
    headers: Readonly<Record<string, string>> = {}
): Response {
    return new Response(body, {
        headers: {
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            ...headers,
        },
        status,
    });
}

function jsonResponse(value: unknown): Response {
    return noStoreResponse(JSON.stringify(value), 200, {
        "content-type": "application/json; charset=utf-8",
    });
}

function methodNotAllowed(allow: string): Response {
    return noStoreResponse(null, 405, { allow });
}

function hasCapability(
    principal: AuthenticatedPrincipal,
    capability: "chat:write"
): boolean {
    return principal.capabilities.includes(capability);
}

async function authenticate(
    request: Request,
    options: ChatSpeechRawHttpHandlerOptions
): Promise<
    { readonly principal: AuthenticatedPrincipal } | { readonly response: Response }
> {
    if (!isAllowedRequestSource(request, options.browserOrigin)) {
        return { response: noStoreResponse("Forbidden", 403) };
    }
    const credentials = readAuthenticationHttpCredentials(request);
    if (credentials.isAmbiguous) {
        return {
            response: noStoreResponse("Ambiguous authentication credentials", 400),
        };
    }
    const resolution = parseAuthenticationResolution(
        await options.authenticateCredential(credentials.authentication)
    );
    if (resolution.authentication.kind !== "authenticated") {
        return { response: noStoreResponse("Unauthorized", 401) };
    }
    return { principal: resolution.authentication.principal };
}

function declaredContentLength(request: Request): number | undefined {
    const raw = request.headers.get("content-length")?.trim();
    if (raw === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
}

class ChatSpeechBodyAbortedError extends Error {
    constructor() {
        super("Chat speech request body was aborted");
        this.name = "ChatSpeechBodyAbortedError";
    }
}

async function readExactBody(
    request: Request,
    declaredBytes: number,
    maximumBytes: number,
    signal: AbortSignal
): Promise<Uint8Array | undefined> {
    if (request.body === null) return undefined;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let pendingRead: ReturnType<typeof reader.read> | undefined;
    const aborted = Promise.withResolvers<never>();
    const abortRead = () => {
        aborted.reject(new ChatSpeechBodyAbortedError());
        void reader.cancel("Chat speech request body was aborted").catch(() => {});
    };
    signal.addEventListener("abort", abortRead, { once: true });
    if (signal.aborted) abortRead();
    try {
        while (true) {
            pendingRead = reader.read();
            const result = await Promise.race([pendingRead, aborted.promise]);
            pendingRead = undefined;
            if (result.done) break;
            const chunk = result.value as Uint8Array;
            totalBytes += chunk.byteLength;
            if (totalBytes > declaredBytes || totalBytes > maximumBytes) {
                await reader
                    .cancel("Chat speech request exceeded its budget")
                    .catch(() => {});
                return undefined;
            }
            chunks.push(chunk);
        }
    } finally {
        signal.removeEventListener("abort", abortRead);
        if (pendingRead === undefined) {
            reader.releaseLock();
        } else {
            void pendingRead
                .catch(() => {})
                .finally(() => {
                    try {
                        reader.releaseLock();
                    } catch {
                        // The cancelled request stream owns remaining cleanup.
                    }
                });
        }
    }
    if (totalBytes !== declaredBytes || totalBytes < 1) return undefined;
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

interface WorkLease {
    readonly release: () => void;
}

interface RollingAdmission {
    readonly admittedAtMs: number;
    readonly units: number;
}

interface RollingAdmissionPolicy {
    readonly maximumRequests: number;
    readonly maximumUnits: number;
}

function principalRateKey(principal: AuthenticatedPrincipal): string {
    return JSON.stringify([principal.kind, principal.id]);
}

function unicodeCodePointLength(value: string): number {
    let length = 0;
    for (const _character of value) length += 1;
    return length;
}

function createRollingAdmission(
    policy: RollingAdmissionPolicy,
    nowMs: () => number
): (principal: AuthenticatedPrincipal, units: number) => boolean {
    const admissions = new Map<string, RollingAdmission[]>();
    let lastObservedAtMs = 0;
    return (principal, units) => {
        let sampledAtMs: number;
        try {
            sampledAtMs = nowMs();
        } catch {
            return false;
        }
        if (
            !Number.isSafeInteger(sampledAtMs) ||
            sampledAtMs < 0 ||
            !Number.isSafeInteger(units) ||
            units < 1 ||
            units > policy.maximumUnits
        ) {
            return false;
        }
        const admittedAtMs = Math.max(lastObservedAtMs, sampledAtMs);
        lastObservedAtMs = admittedAtMs;
        const cutoff = admittedAtMs - chatSpeechRateLimits.windowMs;
        for (const [key, entries] of admissions) {
            const active = entries.filter((entry) => entry.admittedAtMs > cutoff);
            if (active.length === 0) admissions.delete(key);
            else if (active.length !== entries.length) admissions.set(key, active);
        }
        const key = principalRateKey(principal);
        const current = admissions.get(key) ?? [];
        if (
            (current.length === 0 &&
                admissions.size >= chatSpeechRateLimits.maximumTrackedPrincipals) ||
            current.length >= policy.maximumRequests
        ) {
            return false;
        }
        let admittedUnits = units;
        for (const entry of current) admittedUnits += entry.units;
        if (admittedUnits > policy.maximumUnits) return false;
        current.push({ admittedAtMs, units });
        admissions.set(key, current);
        return true;
    };
}

function createAdmission(maximumConcurrent: number): () => WorkLease | undefined {
    let active = 0;
    return () => {
        if (active >= maximumConcurrent) return;
        active += 1;
        let released = false;
        return Object.freeze({
            release() {
                if (released) return;
                released = true;
                active -= 1;
            },
        });
    };
}

function providerFailureResponse(error: unknown): Response {
    if (error instanceof ChatSpeechProviderFailure && error.reason === "timeout") {
        return noStoreResponse("Speech provider timed out", 504);
    }
    return noStoreResponse("Speech provider unavailable", 502);
}

function hasUnexpectedQuery(requestUrl: URL): boolean {
    return requestUrl.search !== "";
}

/**
 * Builds the same-origin, capability-scoped ephemeral speech router.
 * @param options Authentication and optional server-only provider port.
 * @returns Raw speech handler, or undefined for paths outside its namespace.
 */
export function createChatSpeechRawHttpHandler(
    options: ChatSpeechRawHttpHandlerOptions
): ChatSpeechRawHttpHandler {
    const acquireTranscription = createAdmission(1);
    const acquireSynthesis = createAdmission(2);
    const nowMs = options.nowMs ?? Date.now;
    const admitTranscription = createRollingAdmission(
        {
            maximumRequests: chatSpeechRateLimits.transcription.maximumRequests,
            maximumUnits: chatSpeechRateLimits.transcription.maximumDurationMs,
        },
        nowMs
    );
    const admitSynthesis = createRollingAdmission(
        {
            maximumRequests: chatSpeechRateLimits.synthesis.maximumRequests,
            maximumUnits: chatSpeechRateLimits.synthesis.maximumCharacters,
        },
        nowMs
    );
    return async (request, requestUrl) => {
        const path = requestUrl.pathname;
        if (!path.startsWith("/api/chat/speech/")) return;
        if (
            path !== chatSpeechCapabilitiesPath &&
            path !== chatSpeechTranscriptionPath &&
            path !== chatSpeechSynthesisPath
        ) {
            return noStoreResponse("Not found", 404);
        }
        const expectedMethod = path === chatSpeechCapabilitiesPath ? "GET" : "POST";
        if (request.method !== expectedMethod) {
            await request.body
                ?.cancel("Chat speech method is not allowed")
                .catch(() => {});
            return methodNotAllowed(expectedMethod);
        }
        if (hasUnexpectedQuery(requestUrl)) {
            await request.body
                ?.cancel("Chat speech query is not allowed")
                .catch(() => {});
            return noStoreResponse("Not found", 404);
        }
        const authentication = await authenticate(request, options);
        if ("response" in authentication) return authentication.response;
        const canWrite = hasCapability(authentication.principal, "chat:write");
        const available = options.provider !== undefined && canWrite;

        if (path === chatSpeechCapabilitiesPath) {
            if (request.body !== null) {
                await request.body
                    .cancel("Chat speech capability body is not allowed")
                    .catch(() => {});
                return noStoreResponse("Invalid request", 400);
            }
            return jsonResponse(
                v.parse(chatSpeechCapabilitiesOutputSchema, {
                    speechToText: available,
                    textToSpeech: available,
                })
            );
        }
        if (!canWrite) {
            await request.body
                ?.cancel("Chat speech capability is forbidden")
                .catch(() => {});
            return noStoreResponse("Forbidden", 403);
        }
        if (options.provider === undefined) {
            await request.body
                ?.cancel("Chat speech provider is unavailable")
                .catch(() => {});
            return noStoreResponse("Speech is not configured", 503);
        }

        const maximumBodyBytes =
            path === chatSpeechTranscriptionPath
                ? chatSpeechLimits.maximumRecordingBytes
                : chatSpeechLimits.maximumSynthesisRequestBytes;
        const length = declaredContentLength(request);
        if (length === undefined || length < 1) {
            await request.body
                ?.cancel("Chat speech body declaration is invalid")
                .catch(() => {});
            return noStoreResponse("Invalid request", 400);
        }
        if (length > maximumBodyBytes) {
            await request.body
                ?.cancel("Chat speech body exceeds its budget")
                .catch(() => {});
            return noStoreResponse("Request body is too large", 413);
        }
        const contentType = request.headers.get("content-type")?.trim() ?? "";
        if (
            (path === chatSpeechSynthesisPath && contentType !== "application/json") ||
            (path === chatSpeechTranscriptionPath &&
                !chatSpeechRecordingContentTypeSet.has(contentType))
        ) {
            await request.body
                ?.cancel("Chat speech media type is unsupported")
                .catch(() => {});
            return noStoreResponse("Unsupported Media Type", 415);
        }
        const acquire =
            path === chatSpeechTranscriptionPath
                ? acquireTranscription
                : acquireSynthesis;
        const lease = acquire();
        if (lease === undefined) {
            await request.body
                ?.cancel("Chat speech capacity is exhausted")
                .catch(() => {});
            return noStoreResponse("Speech capacity exceeded", 429);
        }
        const readTimeout = AbortSignal.timeout(chatSpeechBodyReadTimeoutMs);
        const readSignal = AbortSignal.any([request.signal, readTimeout]);
        try {
            let bytes: Uint8Array | undefined;
            try {
                bytes = await readExactBody(
                    request,
                    length,
                    maximumBodyBytes,
                    readSignal
                );
            } catch (error: unknown) {
                if (request.signal.aborted) throw error;
                if (readTimeout.aborted)
                    return noStoreResponse("Request body timed out", 408);
                return noStoreResponse("Invalid request", 400);
            }
            if (bytes === undefined) return noStoreResponse("Invalid request", 400);

            if (path === chatSpeechTranscriptionPath) {
                let recording;
                try {
                    recording = validateChatSpeechRecording(bytes, contentType);
                } catch (error: unknown) {
                    if (error instanceof ChatSpeechRecordingValidationError) {
                        return noStoreResponse(
                            error.reason === "duration"
                                ? "Recording is too long"
                                : "Invalid recording",
                            error.reason === "mime" ? 415 : 400
                        );
                    }
                    return noStoreResponse("Invalid recording", 400);
                }
                if (!admitTranscription(authentication.principal, recording.durationMs)) {
                    return noStoreResponse("Speech rate limit exceeded", 429);
                }
                try {
                    const transcript = await options.provider.transcribe(
                        recording,
                        request.signal
                    );
                    return jsonResponse(
                        v.parse(chatSpeechTranscriptionOutputSchema, { transcript })
                    );
                } catch (error: unknown) {
                    if (request.signal.aborted) throw error;
                    return providerFailureResponse(error);
                }
            }

            let input: v.InferOutput<typeof chatSpeechSynthesisInputSchema>;
            try {
                input = v.parse(
                    chatSpeechSynthesisInputSchema,
                    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
                );
            } catch {
                return noStoreResponse("Invalid speech synthesis request", 400);
            }
            if (
                !admitSynthesis(
                    authentication.principal,
                    unicodeCodePointLength(input.text)
                )
            ) {
                return noStoreResponse("Speech rate limit exceeded", 429);
            }
            try {
                const audio = await options.provider.synthesize(
                    input.text,
                    request.signal
                );
                if (
                    audio.byteLength < 1 ||
                    audio.byteLength > chatSpeechLimits.maximumGeneratedAudioBytes
                ) {
                    return noStoreResponse("Speech provider unavailable", 502);
                }
                return noStoreResponse(audio, 200, {
                    "content-length": String(audio.byteLength),
                    "content-type": "audio/mpeg",
                });
            } catch (error: unknown) {
                if (request.signal.aborted) throw error;
                return providerFailureResponse(error);
            }
        } finally {
            lease.release();
        }
    };
}
