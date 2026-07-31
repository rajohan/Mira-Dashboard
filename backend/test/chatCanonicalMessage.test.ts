import { describe, expect, it } from "bun:test";

import { normalizeOpenClawHistoryMessage } from "../../contracts/chat/openClawHistoryNormalizer";
import {
    canonicalChatImageDisplayUrl,
    canonicalChatLocalMediaPathFromUrl,
    extractCanonicalChatImages,
    extractCanonicalChatToolCalls,
} from "../../contracts/chatCanonicalMessage";

describe("backend canonical chat media normalization", () => {
    it("rebases absolute Dashboard media routes without retaining an external origin", () => {
        const managedUrl =
            "https://dashboard.test/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full";
        const localUrl =
            "https://dashboard.test/api/media?path=%2Ftmp%2Fgenerated%20image.png";

        expect(canonicalChatImageDisplayUrl(managedUrl, "image/png")).toBe(
            "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full?preview=image"
        );
        expect(canonicalChatLocalMediaPathFromUrl(localUrl)).toBe(
            "/tmp/generated image.png"
        );
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
        ).toBe("/api/media?path=%2Ftmp%2Fgenerated%20image.png");
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
                alt: undefined,
                data: undefined,
                image_url: undefined,
                mimeType: undefined,
                openUrl: undefined,
                source: { media_type: "image/png" },
                type: "image_url",
                url: undefined,
            },
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
