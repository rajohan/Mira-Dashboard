import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
import { errorMessage, httpStatusCode } from "../src/lib/errors.ts";
import { loadOrCreateDeviceIdentity } from "../src/lib/openclawGatewayClient.ts";
import { pipeProcessOutput, runProcess } from "../src/lib/processes.ts";
import {
    prepareSafeWriteTargetWithinRoot,
    safePathWithinRoot,
    sanitizeFilename,
} from "../src/lib/safePath.ts";
import {
    arrayFallback,
    environmentFallback,
    nonEmptyEnvironmentFallback,
    nullableString,
    objectFallback,
    stringFallback,
} from "../src/lib/values.ts";
import { isValidAgentId } from "../src/services/agents.ts";
import { mapBackupJob } from "../src/services/backups.ts";
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

    it("normalizes optional backend values for API responses and environment defaults", () => {
        const originalValue = process.env.MIRA_TEST_OPTIONAL_VALUE;
        try {
            delete process.env.MIRA_TEST_OPTIONAL_VALUE;
            expect(environmentFallback("MIRA_TEST_OPTIONAL_VALUE", "fallback")).toBe(
                "fallback"
            );
            expect(
                nonEmptyEnvironmentFallback("MIRA_TEST_OPTIONAL_VALUE", "fallback")
            ).toBe("fallback");

            process.env.MIRA_TEST_OPTIONAL_VALUE = "  configured  ";
            expect(environmentFallback("MIRA_TEST_OPTIONAL_VALUE", "fallback")).toBe(
                "  configured  "
            );
            expect(
                nonEmptyEnvironmentFallback("MIRA_TEST_OPTIONAL_VALUE", "fallback")
            ).toBe("configured");

            expect(stringFallback(undefined, "fallback")).toBe("fallback");
            expect(stringFallback(42)).toBe("42");
            expect(nullableString("")).toBeUndefined();
            expect(nullableString("mira")).toBe("mira");
            expect(objectFallback({ ok: true })).toEqual({ ok: true });
            expect(objectFallback()).toEqual({});
            expect(
                objectFallback<Record<string, unknown>>("not-object" as never)
            ).toEqual({});
            expect(arrayFallback(["a"])).toEqual(["a"]);
            expect(arrayFallback("not-array", ["fallback"])).toEqual(["fallback"]);
        } finally {
            if (originalValue === undefined) {
                delete process.env.MIRA_TEST_OPTIONAL_VALUE;
            } else {
                process.env.MIRA_TEST_OPTIONAL_VALUE = originalValue;
            }
        }
    });

    it("maps operational errors without leaking unknown values", () => {
        const blankError = new Error(" ".repeat(3));
        expect(errorMessage(new Error("  failed  "), "fallback")).toBe("failed");
        expect(errorMessage(blankError, "fallback")).toBe("fallback");
        expect(errorMessage("raw secret-ish value", "fallback")).toBe("fallback");
        const notFoundError = Object.assign(new Error("missing"), { statusCode: 404 });
        const invalidStatusError = Object.assign(new Error("bad"), { statusCode: 399 });
        expect(httpStatusCode(notFoundError)).toBe(404);
        expect(httpStatusCode(invalidStatusError)).toBe(500);
        expect(httpStatusCode(undefined)).toBe(500);
    });

    it("keeps filesystem helpers inside their configured root", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-safe-path-"));
        const outside = mkdtempSync(path.join(tmpdir(), "mira-safe-path-outside-"));
        try {
            writeFileSync(path.join(root, "inside.txt"), "ok");
            symlinkSync(outside, path.join(root, "outside-link"));

            expect(safePathWithinRoot("inside.txt", root)).toBe(
                path.join(root, "inside.txt")
            );
            expect(safePathWithinRoot("../escape.txt", root)).toBeUndefined();
            expect(safePathWithinRoot("outside-link/escape.txt", root)).toBeUndefined();
            expect(safePathWithinRoot("bad\0name", root)).toBeUndefined();

            const writeTarget = path.join(root, "nested", "report.txt");
            expect(prepareSafeWriteTargetWithinRoot(writeTarget, root)).toBe(writeTarget);
            expect(
                prepareSafeWriteTargetWithinRoot(path.join(outside, "report.txt"), root)
            ).toBeUndefined();

            expect(sanitizeFilename(" report/../name?.txt ")).toBe("name?.txt ");
            expect(() => sanitizeFilename("..")).toThrow("Invalid filename");
            expect(() => sanitizeFilename("bad\0name")).toThrow("Invalid filename");
        } finally {
            rmSync(root, { force: true, recursive: true });
            rmSync(outside, { force: true, recursive: true });
        }
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

    it("serializes backup jobs without exposing live process handles", () => {
        expect(mapBackupJob(undefined)).toBeUndefined();
        const completed = Promise.resolve(undefined);
        expect(
            mapBackupJob({
                id: "backup-1",
                type: "kopia",
                status: "needs_attention",
                code: 130,
                stdout: "stdout",
                stderr: "stderr",
                startedAt: 1,
                endedAt: 2,
                completed,
                process: { pid: 123 },
            } as never)
        ).toEqual({
            id: "backup-1",
            type: "kopia",
            status: "needs_attention",
            code: 130,
            stdout: "stdout",
            stderr: "stderr",
            startedAt: 1,
            endedAt: 2,
        });
    });

    it("persists and repairs OpenClaw Gateway device identity files", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-device-identity-"));
        const identityPath = path.join(root, "nested", "identity.json");
        try {
            const created = loadOrCreateDeviceIdentity(identityPath);
            expect(created.deviceId).toMatch(/^[a-f0-9]{64}$/u);
            expect(created.publicKeyPem).toContain("PUBLIC KEY");
            expect(created.privateKeyPem).toContain("PRIVATE KEY");

            const loaded = loadOrCreateDeviceIdentity(identityPath);
            expect(loaded).toEqual(created);

            writeFileSync(identityPath, JSON.stringify({ broken: true }));
            const repaired = loadOrCreateDeviceIdentity(identityPath);
            expect(repaired.deviceId).toMatch(/^[a-f0-9]{64}$/u);
            expect(repaired.deviceId).not.toBe(created.deviceId);
        } finally {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("runs and limits local processes through the shared process helpers", async () => {
        await expect(
            runProcess(process.execPath, ["--eval", "console.log('hello');"])
        ).resolves.toEqual({ code: 0, stdout: "hello\n", stderr: "" });

        await expect(
            runProcess(process.execPath, ["--eval", "console.log('too much');"], {
                maxBuffer: 4,
            })
        ).rejects.toThrow("Process output exceeded maxBuffer");

        const chunks: string[] = [];
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("one"));
                controller.enqueue(new TextEncoder().encode("two"));
                controller.close();
            },
        });
        await pipeProcessOutput(stream, (chunk) => {
            chunks.push(chunk);
        });
        expect(chunks.join("")).toBe("onetwo");
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
