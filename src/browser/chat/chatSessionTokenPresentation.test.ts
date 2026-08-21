import { describe, expect, test } from "bun:test";

import { chatSessionTokenPresentation } from "./chatSessionTokenPresentation.ts";

describe("chat session token presentation", () => {
    test("formats compact magnitudes while preserving exact accessible values", () => {
        expect(
            chatSessionTokenPresentation({
                contextTokens: 200_000,
                totalTokens: 42_000,
                totalTokensFresh: true,
            })
        ).toEqual({
            accessibleLabel: "Session token use: 42,000 of 200,000, current",
            compactLabel: "42k / 200k",
        });
        expect(
            chatSessionTokenPresentation({
                contextTokens: 999,
                totalTokens: 12,
                totalTokensFresh: true,
            }).compactLabel
        ).toBe("12 / 999");
        expect(
            chatSessionTokenPresentation({
                contextTokens: 2_000_000,
                totalTokens: 1_250_000,
                totalTokensFresh: false,
            })
        ).toEqual({
            accessibleLabel: "Session token use: 1,250,000 of 2,000,000, out of date",
            compactLabel: "~1.3m / 2m",
        });
        expect(chatSessionTokenPresentation({ totalTokensFresh: false })).toEqual({
            accessibleLabel: "Session token use: Unknown",
            compactLabel: "Unknown",
        });
    });
});
