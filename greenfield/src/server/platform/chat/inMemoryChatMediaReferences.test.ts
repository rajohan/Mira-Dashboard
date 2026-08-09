import { describe, expect, test } from "bun:test";

import { createInMemoryChatMediaReferences } from "./inMemoryChatMediaReferences.ts";

const attachmentId = "00000000-0000-4000-8000-000000000001";
const reference = {
    attachmentId,
    messageId: "message-1",
    sessionKey: "agent:main:main",
};

describe("in-memory chat media references", () => {
    test("returns an expired association once for authoritative revalidation", () => {
        const now = { value: 1000 };
        const references = createInMemoryChatMediaReferences({
            nowMs: () => now.value,
            ttlMs: 1000,
        });
        references.register(reference);

        now.value = 2000;
        expect(references.resolve(attachmentId)).toEqual(reference);
        expect(references.resolve(attachmentId)).toBeUndefined();
        references.dispose();
    });
});
