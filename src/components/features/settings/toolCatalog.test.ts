import { describe, expect, it } from "vitest";

import { TOOL_CATALOG, TOOL_RISK_LABELS } from "./toolCatalog";

describe("tool catalog", () => {
    it("keeps tool ids unique and fully described", () => {
        const ids = TOOL_CATALOG.map((tool) => tool.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(TOOL_CATALOG.length).toBeGreaterThan(10);

        for (const tool of TOOL_CATALOG) {
            expect(tool.label.trim()).toBeTruthy();
            expect(tool.description.trim()).toBeTruthy();
            expect(tool.icon).toBeTruthy();
            expect(TOOL_RISK_LABELS[tool.risk]).toBeTruthy();
        }
    });

    it("classifies high-impact tools as elevated or critical", () => {
        expect(TOOL_CATALOG.find((tool) => tool.id === "read")?.risk).toBe("read");
        expect(TOOL_CATALOG.find((tool) => tool.id === "exec")?.risk).toBe("elevated");
        expect(TOOL_CATALOG.find((tool) => tool.id === "message")?.risk).toBe("elevated");
        expect(TOOL_CATALOG.find((tool) => tool.id === "gateway")?.risk).toBe("critical");
    });

    it("exposes labels for every risk level", () => {
        expect(TOOL_RISK_LABELS).toEqual({
            read: "Read-only",
            standard: "Standard",
            elevated: "Elevated",
            critical: "Critical",
        });
    });
});
