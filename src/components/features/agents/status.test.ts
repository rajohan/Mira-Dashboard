import { describe, expect, it } from "vitest";

import { agentStatusColors, agentStatusLabels } from "./status";

describe("agent status metadata", () => {
    it("defines labels and color classes for every known status", () => {
        expect(Object.keys(agentStatusLabels)).toEqual([
            "active",
            "thinking",
            "idle",
            "offline",
        ]);
        expect(agentStatusLabels).toMatchObject({
            active: "Working",
            thinking: "Thinking",
            idle: "Ready",
            offline: "Offline",
        });

        for (const status of Object.keys(agentStatusLabels)) {
            const colors = agentStatusColors[status as keyof typeof agentStatusColors];
            expect(colors.bg).toMatch(/^bg-/);
            expect(colors.text).toMatch(/^text-/);
            expect(colors.border).toMatch(/^border-/);
        }
    });
});
