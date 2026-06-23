import type { Server } from "bun";
import { describe, expect, it } from "bun:test";

import { sqlNullable } from "../src/database.ts";
import {
    isAllowedDashboardOrigin,
    readJson,
    readRequestBytes,
    sessionIdFromCookie,
    text,
    withCookie,
} from "../src/http.ts";
import { parseJsonField, parseTable } from "../src/lib/cacheStore.ts";
import { isValidAgentId } from "../src/services/agents.ts";
import { getResolvedRoots, validatePrNumber } from "../src/services/pullRequests.ts";

function serverWithAddress(address: string): Server<unknown> {
    return {
        requestIP: () => ({ address, family: "IPv4", port: 12_345 }),
    } as unknown as Server<unknown>;
}

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

    it("validates pull request numbers and configured Dashboard roots", () => {
        const originalRoot = process.env.MIRA_DASHBOARD_ROOT;
        const originalWorktreeRoot = process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
        process.env.MIRA_DASHBOARD_ROOT = "/tmp/dashboard-root";
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = "/tmp/dashboard-worktrees";
        try {
            expect(validatePrNumber("189")).toBe(189);
            expect(() => validatePrNumber("0")).toThrow("Invalid pull request number");
            expect(() => validatePrNumber("1.5")).toThrow("Invalid pull request number");
            expect(() => validatePrNumber("abc")).toThrow("Invalid pull request number");
            expect(getResolvedRoots()).toEqual({
                dashboardRoot: "/tmp/dashboard-root",
                dashboardWorktreeRoot: "/tmp/dashboard-worktrees",
            });

            process.env.MIRA_DASHBOARD_ROOT = "/";
            expect(() => getResolvedRoots()).toThrow(
                "MIRA_DASHBOARD_ROOT must be an absolute non-root path"
            );
        } finally {
            if (originalRoot === undefined) {
                delete process.env.MIRA_DASHBOARD_ROOT;
            } else {
                process.env.MIRA_DASHBOARD_ROOT = originalRoot;
            }
            if (originalWorktreeRoot === undefined) {
                delete process.env.MIRA_DASHBOARD_WORKTREE_ROOT;
            } else {
                process.env.MIRA_DASHBOARD_WORKTREE_ROOT = originalWorktreeRoot;
            }
        }
    });

    it("parses HTTP helpers for JSON, cookies, origins, and body limits", async () => {
        const validJsonBody = JSON.stringify({ ok: true });
        await expect(
            readJson<{ ok: boolean }>(
                new Request("http://localhost/api", {
                    body: validJsonBody,
                    method: "POST",
                })
            )
        ).resolves.toEqual({ ok: true });
        await expect(
            readJson(new Request("http://localhost/api", { body: "{", method: "POST" }))
        ).rejects.toThrow("Invalid JSON");
        await expect(
            readRequestBytes(
                new Request("http://localhost/api", {
                    body: "too large",
                    headers: { "content-length": "9" },
                    method: "POST",
                }),
                4
            )
        ).rejects.toThrow("Request body too large");

        const response = withCookie(text("hello", { status: 201 }), "a=b");
        expect(response.status).toBe(201);
        expect(response.headers.get("set-cookie")).toBe("a=b");
        expect(sessionIdFromCookie(new Request("http://localhost/api"))).toBeUndefined();
        expect(
            sessionIdFromCookie(
                new Request("http://localhost/api", {
                    headers: { cookie: "other=1; mira_dashboard_session=session%201" },
                })
            )
        ).toBe("session 1");
        expect(
            sessionIdFromCookie(
                new Request("http://localhost/api", {
                    headers: { cookie: "mira_dashboard_session=%E0%A4%A" },
                })
            )
        ).toBeUndefined();
        expect(isAllowedDashboardOrigin(new Request("http://localhost:3100/api"))).toBe(
            true
        );
        expect(
            isAllowedDashboardOrigin(
                new Request("http://localhost:3100/api", {
                    headers: { origin: "http://localhost:3100" },
                })
            )
        ).toBe(true);
        expect(
            isAllowedDashboardOrigin(
                new Request("http://localhost:3100/api", {
                    headers: { origin: "not a url" },
                })
            )
        ).toBe(false);
        expect(serverWithAddress("127.0.0.1").requestIP(new Request("http://x"))).toEqual(
            { address: "127.0.0.1", family: "IPv4", port: 12_345 }
        );
    });
});
