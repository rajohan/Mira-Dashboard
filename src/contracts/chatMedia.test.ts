import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    chatAttachmentLimits,
    chatAttachmentTicketPrepareInputSchema,
    chatRawHttpContracts,
} from "./chatMedia.ts";

const baseInput = {
    idempotencyKey: "A".repeat(32),
    sessionKey: "agent:main:main",
};

describe("chat media contracts", () => {
    test("publishes every bounded raw-media terminal status", () => {
        const contractsByMethod = new Map(
            chatRawHttpContracts.map((contract) => [contract.method, contract])
        );

        expect(contractsByMethod.get("PUT")?.statusCodes).toContain(408);
        expect(contractsByMethod.get("GET")?.statusCodes).toContain(429);
        expect(contractsByMethod.get("HEAD")?.statusCodes).toContain(429);
    });

    test("keeps the aggregate raw budget at the encoded-frame-safe 16 MiB boundary", () => {
        expect(chatAttachmentLimits.maximumAggregateRawBytes).toBe(16 * 1024 * 1024);
        expect(
            v.safeParse(chatAttachmentTicketPrepareInputSchema, {
                ...baseInput,
                files: [
                    {
                        fileName: "maximum.txt",
                        mimeType: "text/plain",
                        sizeBytes: 16 * 1024 * 1024,
                    },
                ],
            }).success
        ).toBeTrue();
        expect(
            v.safeParse(chatAttachmentTicketPrepareInputSchema, {
                ...baseInput,
                files: [
                    {
                        fileName: "first.txt",
                        mimeType: "text/plain",
                        sizeBytes: 15 * 1024 * 1024,
                    },
                    {
                        fileName: "second.txt",
                        mimeType: "text/plain",
                        sizeBytes: 1024 * 1024 + 1,
                    },
                ],
            }).success
        ).toBeFalse();
    });
});
