import { describe, expect, it } from "bun:test";

import {
    canonicalChatImageDisplayUrl,
    canonicalChatLocalMediaPathFromUrl,
    extractCanonicalChatImages,
    extractCanonicalChatToolCalls,
    MAX_CANONICAL_CHAT_IMAGE_DATA_CHARACTERS,
    MAX_CANONICAL_CHAT_IMAGES,
    MAX_CANONICAL_CHAT_TOTAL_IMAGE_DATA_CHARACTERS,
    mergeCanonicalChatImages,
    normalizeCanonicalChatText,
} from "../../contracts/chat/canonicalMessage";
import {
    boundCanonicalChatToolValue,
    MAX_CANONICAL_CHAT_TEXT_CHARACTERS,
    MAX_CANONICAL_TOOL_RESULT_CHARACTERS,
} from "../../contracts/chat/canonicalUtilities";
import { normalizeOpenClawHistoryMessage } from "../../contracts/chat/openClawHistoryNormalizer";

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
                    dataFingerprint: expect.any(String),
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

    it("keeps distinct same-sized images when only their middle bytes differ", () => {
        const sharedStart = "a".repeat(128);
        const sharedEnd = "z".repeat(128);
        const forgedFingerprint = "512:aaaa:bbbb";
        const normalizedImages = extractCanonicalChatImages([
            {
                data: `${sharedStart}${"b".repeat(256)}${sharedEnd}`,
                dataFingerprint: forgedFingerprint,
                mimeType: "image/png",
                type: "image",
            },
            {
                data: `${sharedStart}${"c".repeat(256)}${sharedEnd}`,
                dataFingerprint: forgedFingerprint,
                mimeType: "image/png",
                type: "image",
            },
        ]);
        const images = mergeCanonicalChatImages(
            normalizedImages.slice(0, 1),
            normalizedImages.slice(1)
        );

        expect(images).toHaveLength(2);
        expect(images[0]?.dataFingerprint).not.toBe(forgedFingerprint);
        expect(images[1]?.dataFingerprint).not.toBe(forgedFingerprint);
        expect(images[0]?.dataFingerprint).not.toBe(images[1]?.dataFingerprint);
    });

    it("caps aggregate embedded image data while keeping smaller images", () => {
        const imageCharacters =
            Math.floor(MAX_CANONICAL_CHAT_TOTAL_IMAGE_DATA_CHARACTERS / 2) + 1;
        const images = extractCanonicalChatImages([
            {
                data: "a".repeat(imageCharacters),
                mimeType: "image/png",
                type: "image",
            },
            {
                data: "b".repeat(imageCharacters),
                mimeType: "image/png",
                type: "image",
            },
        ]);

        expect(images).toHaveLength(1);
        expect(images[0]?.data).toHaveLength(imageCharacters);
    });

    it("bounds array text before joining provider blocks", () => {
        const content = Array.from({ length: 1001 }, (_, index) => ({
            text: `${index}:`.padEnd(2000, "x"),
            type: "text",
        }));
        const normalized = normalizeCanonicalChatText(content);

        expect(normalized.length).toBe(MAX_CANONICAL_CHAT_TEXT_CHARACTERS);
        expect(normalized).toEndWith("[truncated by Dashboard]");
        expect(normalized).not.toContain("1000:");
    });

    it("preserves colliding bounded tool keys and a provider truncation key", () => {
        const sharedKeyPrefix = "k".repeat(5000);
        const value = boundCanonicalChatToolValue({
            "[truncated]": "provider value",
            [`${sharedKeyPrefix}a`]: "first",
            [`${sharedKeyPrefix}b`]: "second",
            ...Object.fromEntries(
                Array.from({ length: 1000 }, (_, index) => [`property-${index}`, index])
            ),
        }) as Record<string, unknown>;
        const boundedLongKeys = Object.keys(value).filter((key) => key.startsWith("k"));

        expect(boundedLongKeys).toHaveLength(2);
        expect(new Set(boundedLongKeys).size).toBe(2);
        expect(value["[truncated]"]).toBe("provider value");
        expect(
            Object.entries(value).some(
                ([key, item]) =>
                    key !== "[truncated]" && item === "[Truncated properties]"
            )
        ).toBe(true);
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
