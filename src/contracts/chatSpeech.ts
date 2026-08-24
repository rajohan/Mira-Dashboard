import * as v from "valibot";

import { utf8ByteLength } from "../shared/encoding.ts";
import { boundedNonBlankTextSchema } from "../shared/validation.ts";
import type { RawHttpContract } from "./registry.ts";

/** Browser-visible budgets for ephemeral speech requests and responses. */
export const chatSpeechLimits = Object.freeze({
    maximumGeneratedAudioBytes: 8 * 1024 * 1024,
    maximumRecordingBytes: 8 * 1024 * 1024,
    maximumRecordingDurationMs: 120_000,
    maximumSynthesisRequestBytes: 20 * 1024,
    maximumSynthesisTextCharacters: 4000,
    maximumSynthesisTextUtf8Bytes: 16 * 1024,
    maximumTranscriptCharacters: 32_000,
    maximumTranscriptUtf8Bytes: 64 * 1024,
});

/** Exact recorder formats decoded and duration-validated by the server. */
export const chatSpeechRecordingContentTypes = Object.freeze([
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
] as const);

export const chatSpeechCapabilitiesOutputSchema = v.strictObject({
    speechToText: v.boolean("Speech-to-text availability is invalid"),
    textToSpeech: v.boolean("Text-to-speech availability is invalid"),
});

/**
 * Returns whether ephemeral transcript text fits its encoded response budget.
 * @param value Candidate transcript text.
 * @returns Whether the UTF-8 representation fits the response budget.
 */
export function chatSpeechTranscriptFitsByteBudget(value: string): boolean {
    return utf8ByteLength(value) <= chatSpeechLimits.maximumTranscriptUtf8Bytes;
}

const chatSpeechTranscriptTextSchema = v.pipe(
    boundedNonBlankTextSchema(
        chatSpeechLimits.maximumTranscriptCharacters,
        "Speech transcript is invalid"
    ),
    v.check(
        chatSpeechTranscriptFitsByteBudget,
        "Speech transcript exceeds its byte budget"
    )
);

export const chatSpeechTranscriptionOutputSchema = v.strictObject({
    transcript: chatSpeechTranscriptTextSchema,
});

/**
 * Returns whether synthesis text fits its encoded provider-request budget.
 * @param value Candidate synthesis text.
 * @returns Whether the UTF-8 representation fits the provider-request budget.
 */
export function chatSpeechSynthesisTextFitsByteBudget(value: string): boolean {
    return utf8ByteLength(value) <= chatSpeechLimits.maximumSynthesisTextUtf8Bytes;
}

/**
 * Returns the canonical outer-whitespace-free synthesis text.
 * @param value Candidate synthesis text.
 * @returns Text with outer whitespace removed.
 */
export function normalizeChatSpeechSynthesisText(value: string): string {
    return value.trim();
}

const chatSpeechSynthesisTextSchema = v.pipe(
    boundedNonBlankTextSchema(
        chatSpeechLimits.maximumSynthesisTextCharacters,
        "Speech synthesis text is invalid"
    ),
    v.check(
        chatSpeechSynthesisTextFitsByteBudget,
        "Speech synthesis text exceeds its byte budget"
    ),
    v.transform(normalizeChatSpeechSynthesisText)
);

export const chatSpeechSynthesisInputSchema = v.strictObject({
    text: chatSpeechSynthesisTextSchema,
});

export type ChatSpeechCapabilitiesOutput = v.InferOutput<
    typeof chatSpeechCapabilitiesOutputSchema
>;
export type ChatSpeechTranscriptionOutput = v.InferOutput<
    typeof chatSpeechTranscriptionOutputSchema
>;
export type ChatSpeechSynthesisInput = v.InferOutput<
    typeof chatSpeechSynthesisInputSchema
>;

export const chatSpeechCapabilitiesPath = "/api/chat/speech/capabilities";
export const chatSpeechTranscriptionPath = "/api/chat/speech/transcribe";
export const chatSpeechSynthesisPath = "/api/chat/speech/synthesize";

const authenticatedSpeechAccess = Object.freeze({
    capabilities: Object.freeze([]),
    capabilityPolicy: "all",
    kind: "authenticated",
} as const);
const chatSpeechWriteAccess = Object.freeze({
    capabilities: Object.freeze(["chat:write"]),
    capabilityPolicy: "all",
    kind: "authenticated",
} as const);
const noQuery = Object.freeze({
    additionalParameters: "forbidden",
    parameters: Object.freeze([]),
} as const);

/** Implemented ephemeral, capability-scoped speech operations. */
export const chatSpeechRawHttpContracts = [
    {
        access: authenticatedSpeechAccess,
        method: "GET",
        path: chatSpeechCapabilitiesPath,
        query: noQuery,
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: {
            contentTypes: ["application/json"],
            kind: "schema",
            schema: chatSpeechCapabilitiesOutputSchema,
            schemaId: "chat.speech.capabilities.output",
        },
        statusCodes: [200, 400, 401, 403, 404, 405],
        summary:
            "Reports caller-scoped ephemeral speech availability without exposing provider configuration.",
    },
    {
        access: chatSpeechWriteAccess,
        method: "POST",
        path: chatSpeechTranscriptionPath,
        query: noQuery,
        rangeRequests: "none",
        requestBody: {
            contentTypes: chatSpeechRecordingContentTypes,
            kind: "binary",
            maximumBytes: chatSpeechLimits.maximumRecordingBytes,
            transfer: "buffered",
        },
        response: {
            contentTypes: ["application/json"],
            kind: "schema",
            schema: chatSpeechTranscriptionOutputSchema,
            schemaId: "chat.speech.transcribe.output",
        },
        statusCodes: [200, 400, 401, 403, 404, 405, 408, 413, 415, 429, 502, 503, 504],
        summary:
            "Transcribes one MIME-sniffed, duration-checked Opus or AAC recording without retaining audio or transcript text.",
    },
    {
        access: chatSpeechWriteAccess,
        method: "POST",
        path: chatSpeechSynthesisPath,
        query: noQuery,
        rangeRequests: "none",
        requestBody: {
            contentTypes: ["application/json"],
            kind: "schema",
            schema: chatSpeechSynthesisInputSchema,
            schemaId: "chat.speech.synthesize.input",
        },
        response: {
            contentTypes: ["audio/mpeg"],
            kind: "binary",
            maximumBytes: chatSpeechLimits.maximumGeneratedAudioBytes,
            transfer: "buffered",
        },
        statusCodes: [200, 400, 401, 403, 404, 405, 408, 413, 415, 429, 502, 503, 504],
        summary:
            "Generates one bounded no-store MPEG audio response from bounded text without retaining text or audio.",
    },
] as const satisfies readonly RawHttpContract[];
