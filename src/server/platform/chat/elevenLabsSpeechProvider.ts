import { Redacted } from "effect";
import * as v from "valibot";

import {
    chatSpeechLimits,
    chatSpeechSynthesisInputSchema,
    chatSpeechTranscriptionOutputSchema,
} from "../../../contracts/chatSpeech.ts";
import type { ValidatedChatSpeechRecording } from "./chatSpeechRecording.ts";

const elevenLabsSpeechToTextUrl = "https://api.elevenlabs.io/v1/speech-to-text";
const elevenLabsTextToSpeechUrl =
    "https://api.elevenlabs.io/v1/text-to-speech/q7O4dHCU5KzDbUYNsckR?output_format=mp3_44100_128";
const elevenLabsSpeechToTextModel = "scribe_v2";
const elevenLabsTextToSpeechModel = "eleven_turbo_v2_5";
const elevenLabsResponseMetadataMaximumBytes = 128 * 1024;
export const elevenLabsSpeechRequestTimeoutMs = 60_000;

export interface ChatSpeechProvider {
    readonly synthesize: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
    readonly transcribe: (
        recording: ValidatedChatSpeechRecording,
        signal: AbortSignal
    ) => Promise<string>;
}

export class ChatSpeechProviderFailure extends Error {
    readonly reason: "invalid-response" | "timeout" | "unavailable";

    constructor(reason: ChatSpeechProviderFailure["reason"]) {
        super("Chat speech provider failed");
        this.name = "ChatSpeechProviderFailure";
        this.reason = reason;
    }
}

export interface ElevenLabsSpeechProviderOptions {
    readonly apiKey: Redacted.Redacted<string>;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
}

async function cancelResponse(response: Response, reason: string): Promise<void> {
    try {
        await response.body?.cancel(reason);
    } catch {
        // Rejected upstream bodies are intentionally discarded without diagnostics.
    }
}

async function boundedResponseBody(
    response: Response,
    maximumBytes: number
): Promise<Uint8Array> {
    const declared = response.headers.get("content-length")?.trim();
    if (
        declared !== undefined &&
        (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximumBytes)
    ) {
        await cancelResponse(response, "Speech provider response exceeded its budget");
        throw new ChatSpeechProviderFailure("invalid-response");
    }
    if (response.body === null) throw new ChatSpeechProviderFailure("invalid-response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            const chunk = result.value as Uint8Array;
            totalBytes += chunk.byteLength;
            if (totalBytes > maximumBytes) {
                await reader
                    .cancel("Speech provider response exceeded its budget")
                    .catch(() => {});
                throw new ChatSpeechProviderFailure("invalid-response");
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    if (totalBytes < 1 || (declared !== undefined && Number(declared) !== totalBytes)) {
        throw new ChatSpeechProviderFailure("invalid-response");
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

function responseBaseMimeType(response: Response): string {
    return (
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
    );
}

function providerSignal(
    requestSignal: AbortSignal,
    timeoutMs: number
): { readonly signal: AbortSignal; readonly timeoutSignal: AbortSignal } {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return {
        signal: AbortSignal.any([requestSignal, timeoutSignal]),
        timeoutSignal,
    };
}

function normalizeProviderFailure(
    error: unknown,
    requestSignal: AbortSignal,
    timeoutSignal: AbortSignal
): never {
    if (requestSignal.aborted) throw error;
    if (timeoutSignal.aborted) throw new ChatSpeechProviderFailure("timeout");
    if (error instanceof ChatSpeechProviderFailure) throw error;
    throw new ChatSpeechProviderFailure("unavailable");
}

/**
 * Creates the server-only ElevenLabs adapter used only for ephemeral speech work.
 * @param options Redacted credential, request timeout, and injectable fetch boundary.
 * @returns Bounded STT/TTS provider without storage or logging ports.
 */
export function createElevenLabsSpeechProvider(
    options: ElevenLabsSpeechProviderOptions
): ChatSpeechProvider {
    const apiKey = Redacted.value(options.apiKey);
    if (
        apiKey.length === 0 ||
        apiKey.length > 4096 ||
        apiKey !== apiKey.trim() ||
        /[\p{Cc}\p{Cf}]/u.test(apiKey)
    ) {
        throw new TypeError("ElevenLabs speech credential is invalid");
    }
    const timeoutMs = options.timeoutMs ?? elevenLabsSpeechRequestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw new TypeError("ElevenLabs speech timeout is invalid");
    }
    const fetchImplementation = options.fetch ?? globalThis.fetch;

    return Object.freeze({
        async synthesize(text: string, requestSignal: AbortSignal) {
            const input = v.parse(chatSpeechSynthesisInputSchema, { text });
            const { signal, timeoutSignal } = providerSignal(requestSignal, timeoutMs);
            try {
                const response = await fetchImplementation(elevenLabsTextToSpeechUrl, {
                    body: JSON.stringify({
                        model_id: elevenLabsTextToSpeechModel,
                        text: input.text,
                        voice_settings: {
                            similarity_boost: 0.75,
                            stability: 0.5,
                        },
                    }),
                    headers: {
                        "content-type": "application/json",
                        "xi-api-key": apiKey,
                    },
                    method: "POST",
                    redirect: "manual",
                    signal,
                });
                if (
                    response.status !== 200 ||
                    responseBaseMimeType(response) !== "audio/mpeg"
                ) {
                    await cancelResponse(response, "Rejected speech synthesis response");
                    throw new ChatSpeechProviderFailure("unavailable");
                }
                return await boundedResponseBody(
                    response,
                    chatSpeechLimits.maximumGeneratedAudioBytes
                );
            } catch (error: unknown) {
                return normalizeProviderFailure(error, requestSignal, timeoutSignal);
            }
        },
        async transcribe(
            recording: ValidatedChatSpeechRecording,
            requestSignal: AbortSignal
        ) {
            const form = new FormData();
            const body = Uint8Array.from(recording.bytes).buffer;
            form.append(
                "file",
                new Blob([body], { type: recording.contentType }),
                recording.fileName
            );
            form.append("model_id", elevenLabsSpeechToTextModel);
            form.append("tag_audio_events", "false");
            form.append("diarize", "false");
            const { signal, timeoutSignal } = providerSignal(requestSignal, timeoutMs);
            try {
                const response = await fetchImplementation(elevenLabsSpeechToTextUrl, {
                    body: form,
                    headers: { "xi-api-key": apiKey },
                    method: "POST",
                    redirect: "manual",
                    signal,
                });
                if (
                    response.status !== 200 ||
                    responseBaseMimeType(response) !== "application/json"
                ) {
                    await cancelResponse(
                        response,
                        "Rejected speech transcription response"
                    );
                    throw new ChatSpeechProviderFailure("unavailable");
                }
                const bytes = await boundedResponseBody(
                    response,
                    elevenLabsResponseMetadataMaximumBytes
                );
                let value: unknown;
                try {
                    value = JSON.parse(
                        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
                    );
                } catch {
                    throw new ChatSpeechProviderFailure("invalid-response");
                }
                const source = value as { readonly text?: unknown };
                const transcript =
                    value !== null &&
                    typeof value === "object" &&
                    typeof source.text === "string"
                        ? source.text.trim()
                        : "";
                return v.parse(chatSpeechTranscriptionOutputSchema, {
                    transcript,
                }).transcript;
            } catch (error: unknown) {
                return normalizeProviderFailure(error, requestSignal, timeoutSignal);
            }
        },
    } satisfies ChatSpeechProvider);
}
