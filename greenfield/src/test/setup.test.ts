import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("test process setup", () => {
    test("pins ambient project and temporary paths to one private test root", async () => {
        const projectRoot = process.env.MIRA_DASHBOARD_PROJECT_ROOT;
        if (projectRoot === undefined) throw new Error("Expected a test project root");

        const status = await stat(projectRoot);
        expect(process.env.NODE_ENV).toBe("test");
        expect(tmpdir()).toBe(projectRoot);
        expect(process.env.TEMP).toBe(projectRoot);
        expect(process.env.TMP).toBe(projectRoot);
        expect(process.env.TMPDIR).toBe(projectRoot);
        expect(path.basename(projectRoot)).toStartWith("mira-dashboard-test-");
        expect(status.isDirectory()).toBe(true);
        expect(status.mode & 0o777).toBe(0o700);
    });
});
