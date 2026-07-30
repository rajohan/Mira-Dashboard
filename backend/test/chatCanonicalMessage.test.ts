import { describe, expect, it } from "bun:test";

import {
    canonicalChatImageDisplayUrl,
    canonicalChatLocalMediaPathFromUrl,
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
    });
});
