import { describe, expect, it } from "bun:test";

import { sqlNullable } from "../src/database.ts";
import { parseJsonField, parseTable } from "../src/lib/cacheStore.ts";
import { isValidAgentId } from "../src/services/agents.ts";

describe("backend service utilities", () => {
    it("validates agent ids before they can become filesystem path segments", () => {
        expect(isValidAgentId("mira-2026")).toBe(true);
        expect(isValidAgentId("agent.main_1")).toBe(true);
        expect(isValidAgentId("")).toBe(false);
        expect(isValidAgentId(".")).toBe(false);
        expect(isValidAgentId("..")).toBe(false);
        expect(isValidAgentId("../escape")).toBe(false);
        expect(isValidAgentId("x".repeat(65))).toBe(false);
    });

    it("parses cache JSON and tabular command output defensively", () => {
        expect(parseJsonField<{ ok: boolean }>('{"ok":true}')).toEqual({ ok: true });
        expect(parseJsonField("")).toBeUndefined();
        expect(parseJsonField("{")).toBeUndefined();

        expect(
            parseTable<{ name: string; status: string }>(
                "name\tstatus\nmira\tonline\nraymond\t\n\n"
            )
        ).toEqual([
            { name: "mira", status: "online" },
            { name: "raymond", status: "" },
        ]);
        expect(parseTable("")).toEqual([]);
    });

    it("maps undefined bindings to SQLite null while preserving concrete values", () => {
        expect(sqlNullable("value")).toBe("value");
        expect(sqlNullable(0)).toBe(0);
        expect(sqlNullable(undefined)).toBeNull();
    });
});
