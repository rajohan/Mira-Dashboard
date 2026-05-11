import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
    it("combines conditional classes and merges Tailwind conflicts", () => {
        const shouldHide = false;
        expect(cn("px-2", shouldHide && "hidden", "px-4", ["text-sm"])).toBe(
            "px-4 text-sm"
        );
    });
});
