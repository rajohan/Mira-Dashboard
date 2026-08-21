import { describe, expect, test } from "bun:test";

import tailwindConfiguration from "../tailwind.config.ts";

describe("Tailwind configuration", () => {
    test("keeps the shared palette, loading animation, and typography plugin configured", () => {
        expect(tailwindConfiguration.theme.extend.colors).toMatchObject({
            accent: {
                500: "#5B8CFF",
                950: "#17244A",
            },
            primary: {
                500: "#686F7B",
                950: "#0B0B0C",
            },
        });
        expect(tailwindConfiguration.theme.extend.keyframes).toEqual({
            "loading-state-second-dot": {
                "0%, 32%": { opacity: "0" },
                "33%, 100%": { opacity: "1" },
            },
            "loading-state-third-dot": {
                "0%, 65%": { opacity: "0" },
                "66%, 100%": { opacity: "1" },
            },
        });
        expect(tailwindConfiguration.plugins).toHaveLength(1);
        expect(tailwindConfiguration.plugins[0]).toBeFunction();
    });
});
