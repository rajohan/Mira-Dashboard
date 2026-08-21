import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    chatSpeechCapabilitiesOutputSchema,
    chatSpeechCapabilitiesPath,
    chatSpeechLimits,
    chatSpeechRawHttpContracts,
    chatSpeechRecordingContentTypes,
    chatSpeechSynthesisInputSchema,
    chatSpeechSynthesisPath,
    chatSpeechSynthesisTextFitsByteBudget,
    chatSpeechTranscriptionOutputSchema,
    chatSpeechTranscriptionPath,
} from "./chatSpeech.ts";

describe("chat speech contracts", () => {
    test("publishes exact mobile-compatible routes, capabilities, and byte budgets", () => {
        expect(chatSpeechRecordingContentTypes).toEqual([
            "audio/webm;codecs=opus",
            "audio/ogg;codecs=opus",
            "audio/mp4;codecs=mp4a.40.2",
            "audio/mp4",
        ]);
        expect(
            chatSpeechRawHttpContracts.map(({ method, path }) => [method, path])
        ).toEqual([
            ["GET", chatSpeechCapabilitiesPath],
            ["POST", chatSpeechTranscriptionPath],
            ["POST", chatSpeechSynthesisPath],
        ]);
        expect(chatSpeechRawHttpContracts[1].requestBody).toMatchObject({
            contentTypes: chatSpeechRecordingContentTypes,
            maximumBytes: 8 * 1024 * 1024,
        });
        expect(chatSpeechRawHttpContracts[2].response).toMatchObject({
            contentTypes: ["audio/mpeg"],
            maximumBytes: 8 * 1024 * 1024,
        });
        expect(chatSpeechRawHttpContracts[1].access).toMatchObject({
            capabilities: ["chat:write"],
        });
        expect(chatSpeechRawHttpContracts[2].access).toMatchObject({
            capabilities: ["chat:write"],
        });
        for (const contract of chatSpeechRawHttpContracts) {
            expect(contract.statusCodes).toContain(404);
        }
    });

    test("validates caller-scoped capability and sanitized transcript shapes", () => {
        expect(
            v.parse(chatSpeechCapabilitiesOutputSchema, {
                speechToText: true,
                textToSpeech: false,
            })
        ).toEqual({ speechToText: true, textToSpeech: false });
        expect(
            v.parse(chatSpeechTranscriptionOutputSchema, {
                transcript: "Hei fra opptaket",
            })
        ).toEqual({ transcript: "Hei fra opptaket" });
        expect(
            v.safeParse(chatSpeechTranscriptionOutputSchema, {
                provider: "elevenlabs",
                transcript: "secret provider detail",
            }).success
        ).toBe(false);
        expect(
            v.safeParse(chatSpeechTranscriptionOutputSchema, {
                transcript: "x".repeat(chatSpeechLimits.maximumTranscriptCharacters + 1),
            }).success
        ).toBe(false);
    });

    test("trims bounded synthesis text and enforces character and UTF-8 helpers", () => {
        expect(
            v.parse(chatSpeechSynthesisInputSchema, { text: "  Les dette  " })
        ).toEqual({
            text: "Les dette",
        });
        expect(
            v.safeParse(chatSpeechSynthesisInputSchema, {
                text: "x".repeat(chatSpeechLimits.maximumSynthesisTextCharacters + 1),
            }).success
        ).toBe(false);
        expect(
            chatSpeechSynthesisTextFitsByteBudget(
                "😀".repeat(
                    Math.floor(chatSpeechLimits.maximumSynthesisTextUtf8Bytes / 4) + 1
                )
            )
        ).toBe(false);
        expect(
            v.safeParse(chatSpeechSynthesisInputSchema, { text: "\0hidden" }).success
        ).toBe(false);
    });
});
