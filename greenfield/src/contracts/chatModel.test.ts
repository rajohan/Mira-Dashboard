import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { utf8ByteLength } from "../shared/encoding.ts";
import {
    chatRuntimeInputSchema,
    chatRuntimeOutputSchema,
    chatSendInputSchema,
} from "./chat.ts";
import {
    chatMessageSchema,
    chatExternalRunSchema,
    chatRuntimeEventSchema,
    chatSendInputMaximumBytes,
    mergeChatStreamText,
} from "./chatModel.ts";

const runId = "019fe5a1-6cb9-7e51-ad2a-bf1f69861218";

describe("chat model contract", () => {
    test("uses one exact overlap-safe merge rule", () => {
        expect(mergeChatStreamText("previous", "")).toBe("previous");
        expect(mergeChatStreamText("", "next")).toBe("next");
        expect(mergeChatStreamText("Fixture ", "Fixture complete.")).toBe(
            "Fixture complete."
        );
        expect(mergeChatStreamText("abc", "bc")).toBe("abc");
        expect(mergeChatStreamText("abc", "def")).toBe("abcdef");
    });

    test("rejects provider sequence zero on points and ranges", () => {
        expect(
            v.safeParse(chatRuntimeEventSchema, {
                kind: "provider-noop",
                occurredAtMs: 1,
                providerSequence: 0,
                reason: "ignored",
                runId,
                sequence: 1,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(chatRuntimeEventSchema, {
                kind: "assistant",
                mode: "merge",
                occurredAtMs: 1,
                providerSequenceEnd: 0,
                providerSequenceStart: 0,
                runId,
                sequence: 1,
                text: "invalid",
            }).success
        ).toBeFalse();
    });

    test("accepts only the exact local managed-media UUIDv4 route", () => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Fixture is scoped to this policy case.
        const attachment = (
            url: string,
            renderPolicy:
                | "bounded-text"
                | "download-only"
                | "inline-image" = "inline-image",
            downloadUrl?: string
        ) => ({
            content: {
                kind: "complete",
                parts: [
                    {
                        ...(downloadUrl === undefined ? {} : { downloadUrl }),
                        fileName: "diagram.png",
                        id: "part-1",
                        kind: "attachment",
                        mediaType: "image/png",
                        renderPolicy,
                        url,
                    },
                ],
            },
            id: "message-1",
            role: "assistant",
            source: "gateway-history",
        });
        const base = "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40";

        expect(
            v.safeParse(chatMessageSchema, attachment(`${base}?disposition=preview`))
                .success
        ).toBeTrue();
        expect(
            v.safeParse(
                chatMessageSchema,
                attachment(
                    `${base}?disposition=preview`,
                    "bounded-text",
                    `${base}?disposition=download`
                )
            ).success
        ).toBeTrue();
        expect(
            v.safeParse(
                chatMessageSchema,
                attachment(`${base}?disposition=download`, "download-only")
            ).success
        ).toBeTrue();
        for (const invalid of [
            base,
            `${base}/full`,
            `${base}?download=true`,
            `${base}?disposition=preview&extra=true`,
            "/api/chat/media/%2e%2e%2fsecret",
            "/api/chat/media/019FE633-9133-4BA0-8B80-809DD80DFB40?disposition=preview",
        ]) {
            expect(
                v.safeParse(chatMessageSchema, attachment(invalid)).success
            ).toBeFalse();
        }
        expect(
            v.safeParse(
                chatMessageSchema,
                attachment(`${base}?disposition=download`, "inline-image")
            ).success
        ).toBeFalse();
        expect(
            v.safeParse(
                chatMessageSchema,
                attachment(`${base}?disposition=preview`, "download-only")
            ).success
        ).toBeFalse();
        expect(
            v.safeParse(
                chatMessageSchema,
                attachment(
                    `${base}?disposition=preview`,
                    "bounded-text",
                    "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb41?disposition=download"
                )
            ).success
        ).toBeFalse();
    });

    test("requires nonblank text unless an attachment ticket is present", () => {
        const input = {
            clientRunId: runId,
            idempotencyKey: "A".repeat(32),
            message: " \n\t ",
            sessionKey: "agent:main:main",
        };
        expect(v.safeParse(chatSendInputSchema, input).success).toBeFalse();
        expect(
            v.safeParse(chatSendInputSchema, {
                ...input,
                attachmentTicketId: "019fe633-9133-4ba0-8b80-809dd80dfb40",
            }).success
        ).toBeTrue();
    });

    test("bounds the canonical UTF-8 send intent independently of code units", () => {
        const empty = {
            clientRunId: runId,
            idempotencyKey: "A".repeat(32),
            message: "",
            sessionKey: "agent:main:main",
        };
        const overhead = utf8ByteLength(JSON.stringify(empty));
        const maximum = {
            ...empty,
            message: "a".repeat(chatSendInputMaximumBytes - overhead),
        };

        expect(utf8ByteLength(JSON.stringify(maximum))).toBe(chatSendInputMaximumBytes);
        expect(v.safeParse(chatSendInputSchema, maximum).success).toBeTrue();
        expect(
            v.safeParse(chatSendInputSchema, {
                ...maximum,
                message: `${maximum.message}a`,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(chatSendInputSchema, {
                ...empty,
                message: "🙂".repeat(40 * 1024),
            }).success
        ).toBeFalse();
    });

    test("requires a non-empty bounded external plan with one active step", () => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Fixture is scoped to this policy case.
        const external = (steps: unknown[]) => ({
            continuity: "complete",
            hasUnprojectedActivity: false,
            plan: { phase: "update", steps },
            providerRunId: "provider-run",
            sessionKey: "agent:main:main",
            source: "provider-runtime",
            text: "working",
            updatedAtMs: 1000,
        });
        expect(v.safeParse(chatExternalRunSchema, external([])).success).toBeFalse();
        expect(
            v.safeParse(
                chatExternalRunSchema,
                external([{ status: "in_progress", text: "Work" }])
            ).success
        ).toBeTrue();
        expect(
            v.safeParse(
                chatExternalRunSchema,
                external([
                    { status: "in_progress", text: "First" },
                    { status: "in_progress", text: "Second" },
                ])
            ).success
        ).toBeFalse();
    });

    test("uses zero only as the unknown browser generation and positive server generations", () => {
        expect(
            v.parse(chatRuntimeInputSchema, { sessionKey: "agent:main:main" })
                .afterTranscriptGeneration
        ).toBe(0);
        expect(
            v.safeParse(chatRuntimeInputSchema, {
                afterTranscriptGeneration: -1,
                sessionKey: "agent:main:main",
            }).success
        ).toBeFalse();
        const output = {
            cursor: "0",
            events: [],
            hasMore: false,
            resetRequired: true,
            runs: [],
            sessionKey: "agent:main:main",
            transcriptGeneration: 1,
        };
        expect(v.safeParse(chatRuntimeOutputSchema, output).success).toBeTrue();
        expect(
            v.safeParse(chatRuntimeOutputSchema, {
                ...output,
                transcriptGeneration: 0,
            }).success
        ).toBeFalse();
    });
});
