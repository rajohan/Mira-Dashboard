import { describe, expect, it } from "bun:test";

import { normalizeOpenClawHistoryMessage } from "../../contracts/chat/openClawHistoryNormalizer";
import {
    canonicalChatImageDisplayUrl,
    canonicalChatLocalMediaPathFromUrl,
    extractCanonicalChatImages,
    extractCanonicalChatToolCalls,
    MAX_CANONICAL_CHAT_IMAGE_DATA_CHARACTERS,
    MAX_CANONICAL_CHAT_IMAGES,
} from "../../contracts/chatCanonicalMessage";
import { MAX_CANONICAL_TOOL_RESULT_CHARACTERS } from "../../contracts/chatCanonicalUtilities";

describe("backend canonical chat media normalization", () => {
    it("rejects absolute Dashboard-shaped media routes without a trusted browser origin", () => {
        const managedUrl =
            "https://dashboard.test/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full";
        const localUrl =
            "https://dashboard.test/api/media?path=%2Ftmp%2Fgenerated%20image.png";

        expect(canonicalChatImageDisplayUrl(managedUrl, "image/png")).toBeUndefined();
        expect(canonicalChatLocalMediaPathFromUrl(localUrl)).toBeUndefined();
        expect(
            normalizeOpenClawHistoryMessage({
                content: [
                    {
                        attachment: {
                            label: "generated image.png",
                            mimeType: "image/png",
                            url: localUrl,
                        },
                        type: "attachment",
                    },
                ],
                role: "assistant",
            }).attachments?.[0]?.url
        ).toBe(localUrl);
    });

    it("sanitizes malformed provider image fields before canonicalizing", () => {
        expect(
            extractCanonicalChatImages([
                {
                    alt: 42,
                    image_url: { url: null },
                    source: { data: 5, media_type: "image/png", url: false },
                    type: "image_url",
                    url: 7,
                },
                {
                    alt: "preview",
                    image_url: { extra: "ignored", url: "https://files.test/a.png" },
                    source: {
                        data: "abc",
                        media_type: "image/png",
                        type: "base64",
                        url: null,
                    },
                    type: "image",
                },
            ])
        ).toEqual([
            {
                alt: "preview",
                data: undefined,
                image_url: { url: "https://files.test/a.png" },
                mimeType: undefined,
                openUrl: undefined,
                source: {
                    data: "abc",
                    media_type: "image/png",
                    type: "base64",
                    url: undefined,
                },
                type: "image",
                url: undefined,
            },
        ]);
    });

    it("bounds embedded images and canonical tool payloads", () => {
        expect(
            extractCanonicalChatImages(
                Array.from({ length: MAX_CANONICAL_CHAT_IMAGES + 2 }, (_, index) => ({
                    image_url: `https://files.test/${index}.png`,
                    type: "image_url",
                }))
            )
        ).toHaveLength(MAX_CANONICAL_CHAT_IMAGES);
        expect(
            extractCanonicalChatImages([
                {
                    data: "x".repeat(MAX_CANONICAL_CHAT_IMAGE_DATA_CHARACTERS + 1),
                    mimeType: "image/png",
                    type: "image",
                },
                {
                    data: "PHN2Zz48L3N2Zz4=",
                    mimeType: "image/svg+xml",
                    type: "image",
                },
            ])
        ).toEqual([]);

        const largeResult = normalizeOpenClawHistoryMessage({
            content: "x".repeat(MAX_CANONICAL_TOOL_RESULT_CHARACTERS + 100),
            role: "toolResult",
        }).toolResult?.content;
        expect(largeResult?.length).toBe(MAX_CANONICAL_TOOL_RESULT_CHARACTERS);
        expect(largeResult).toEndWith("[truncated by Dashboard]");

        const [call] = extractCanonicalChatToolCalls([
            {
                arguments: { input: "x".repeat(300_000) },
                name: "exec",
                type: "toolCall",
            },
        ]);
        expect(JSON.stringify(call?.arguments).length).toBeLessThan(300_000);

        const oversizedKey = "k".repeat(300_000);
        const [keyedCall] = extractCanonicalChatToolCalls([
            {
                arguments: { [oversizedKey]: true },
                name: "exec",
                type: "toolCall",
            },
        ]);
        const serializedKeyedArguments = JSON.stringify(keyedCall?.arguments);
        expect(serializedKeyedArguments.length).toBeLessThan(5000);
        expect(serializedKeyedArguments).toContain("[truncated by Dashboard]");
    });

    it("normalizes empty provider tool-call identifiers before canonicalizing", () => {
        expect(
            extractCanonicalChatToolCalls([
                { id: " ", name: "", type: "toolCall" },
                { id: " call-1 ", name: " exec ", type: "toolCall" },
            ])
        ).toEqual([
            { arguments: undefined, id: undefined, name: "tool" },
            { arguments: undefined, id: "call-1", name: "exec" },
        ]);
    });

    it("drops blank provider attachment and tool-result identifiers", () => {
        expect(
            normalizeOpenClawHistoryMessage({
                MediaPaths: ["   ", "/tmp/report.txt"],
                MediaTypes: ["image/png", "text/plain"],
                content: "",
                role: "user",
            }).attachments
        ).toMatchObject([
            {
                fileName: "report.txt",
                mimeType: "text/plain",
                url: "/api/media?path=%2Ftmp%2Freport.txt",
            },
        ]);
        expect(
            normalizeOpenClawHistoryMessage({
                content: "done",
                role: "toolResult",
                toolCallId: " ",
                toolName: "",
                tool_call_id: " call-1 ",
                tool_name: " exec ",
            }).toolResult
        ).toMatchObject({
            content: "done",
            id: "call-1",
            name: "exec",
        });
    });
});
