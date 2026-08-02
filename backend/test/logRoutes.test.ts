import { afterEach, describe, expect, it, jest } from "bun:test";
import {
    linkSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatOpenClawLogDate } from "../src/lib/logRoots.ts";
import { logRoutes } from "../src/routes/logRoutes.ts";
import { readDashboardJournal } from "../src/routes/logRoutes/dashboard.ts";

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
    while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
});

function temporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() => rmSync(root, { force: true, recursive: true }));
    return root;
}

function setEnvironment(key: string, value: string | undefined): void {
    const original = process.env[key];
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
    cleanupCallbacks.push(() => {
        if (original === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = original;
        }
    });
}

function dashboardRequest(query = ""): Request {
    return new Request(`https://test.local/api/logs/dashboard${query}`);
}

function openClawContentRequest(file?: string, lines?: string): Request {
    const query = new URLSearchParams();
    if (file !== undefined) query.set("file", file);
    if (lines !== undefined) query.set("lines", lines);
    return new Request(
        `https://test.local/api/logs/openclaw/content?${query.toString()}`
    );
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error("Expected promise to reject");
}

describe("log routes", () => {
    it("queries only Dashboard Bun processes and parses stable journal identifiers", async () => {
        const runner = jest.fn(() =>
            Promise.resolve({
                code: 0,
                stderr: "",
                stdout: [
                    "",
                    "not-json",
                    '{"MESSAGE":""}',
                    '{"MESSAGE":"web ready","__CURSOR":"cursor-web"}',
                    '{"MESSAGE":"worker ready","__REALTIME_TIMESTAMP":"12345"}',
                    '{"MESSAGE":"fallback id","__CURSOR":7}',
                ].join("\n"),
            })
        );

        const result = await readDashboardJournal(25, runner);

        expect(result).toEqual({
            content: "web ready\nworker ready\nfallback id",
            lineIds: ["cursor-web", "12345:4", "journal:5"],
        });
        expect(runner).toHaveBeenCalledWith(
            "/usr/bin/journalctl",
            [
                "--user",
                "--no-pager",
                "--quiet",
                "--output=json",
                "--lines",
                "25",
                "--unit",
                "mira-dashboard.service",
                "--unit",
                "mira-dashboard-worker.service",
                "_COMM=bun",
            ],
            {
                maxBuffer: 8 * 1024 * 1024,
                timeoutMs: 5000,
            }
        );
    });

    it("reports the journal runner's failure without exposing an empty message", async () => {
        const failingRunner = jest.fn(() =>
            Promise.resolve({
                code: 1,
                stderr: "permission denied\n",
                stdout: "",
            })
        );
        const emptyFailureRunner = jest.fn(() =>
            Promise.resolve({
                code: 1,
                stderr: "",
                stdout: "",
            })
        );

        expect(await rejectionMessage(readDashboardJournal(10, failingRunner))).toBe(
            "permission denied"
        );
        expect(await rejectionMessage(readDashboardJournal(10, emptyFailureRunner))).toBe(
            "journalctl failed"
        );
    });

    it("validates isolated Dashboard log configuration and missing files", async () => {
        setEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE", "1");
        setEnvironment("MIRA_DASHBOARD_APPLICATION_LOG_PATH", undefined);

        const unconfigured =
            await logRoutes["/api/logs/dashboard"].GET(dashboardRequest());
        expect(unconfigured.status).toBe(200);
        expect(await unconfigured.json()).toEqual({
            content: "",
            lineIds: [],
            unavailableReason: "Dashboard application log capture is not configured.",
        });

        process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH = "dashboard.ndjson";
        const relative = await logRoutes["/api/logs/dashboard"].GET(dashboardRequest());
        expect(relative.status).toBe(503);

        const root = temporaryRoot("mira-log-route-validation-");
        process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH = path.join(root, "other.ndjson");
        const wrongName = await logRoutes["/api/logs/dashboard"].GET(dashboardRequest());
        expect(wrongName.status).toBe(503);

        process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH = path.join(
            root,
            "dashboard.ndjson"
        );
        const invalidLines = await logRoutes["/api/logs/dashboard"].GET(
            dashboardRequest("?lines=zero")
        );
        expect(invalidLines.status).toBe(400);

        const missing = await logRoutes["/api/logs/dashboard"].GET(dashboardRequest());
        expect(missing.status).toBe(200);
        expect(await missing.json()).toEqual({ content: "", lineIds: [] });
    });

    it("rejects non-regular and multiply linked isolated Dashboard logs", async () => {
        setEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE", "1");
        const root = temporaryRoot("mira-log-route-files-");
        const appLog = path.join(root, "dashboard.ndjson");
        setEnvironment("MIRA_DASHBOARD_APPLICATION_LOG_PATH", appLog);

        mkdirSync(appLog);
        const directory = await logRoutes["/api/logs/dashboard"].GET(dashboardRequest());
        expect(directory.status).toBe(503);
        rmSync(appLog, { recursive: true });

        writeFileSync(appLog, '{"event":"linked"}\n');
        linkSync(appLog, path.join(root, "linked.ndjson"));
        const hardLinked = await logRoutes["/api/logs/dashboard"].GET(dashboardRequest());
        expect(hardLinked.status).toBe(503);
    });

    it("maps unexpected isolated Dashboard open failures to service unavailable", async () => {
        setEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE", "1");
        const root = temporaryRoot("mira-log-route-long-path-");
        const oversizedParent = "a".repeat(5000);
        setEnvironment(
            "MIRA_DASHBOARD_APPLICATION_LOG_PATH",
            path.join(root, oversizedParent, "dashboard.ndjson")
        );

        const response = await logRoutes["/api/logs/dashboard"].GET(dashboardRequest());
        expect(response.status).toBe(503);
    });

    it("validates production Dashboard line counts before reading the journal", async () => {
        setEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE", undefined);

        const response = await logRoutes["/api/logs/dashboard"].GET(
            dashboardRequest("?lines=-1")
        );
        expect(response.status).toBe(400);
    });

    it("uses today's OpenClaw log by default and caps requested line counts", async () => {
        const root = temporaryRoot("mira-openclaw-log-default-");
        const fileName = `openclaw-${formatOpenClawLogDate(new Date())}.log`;
        writeFileSync(path.join(root, fileName), "first\nsecond\n");
        setEnvironment("MIRA_DASHBOARD_LOGS_ROOT", root);
        setEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE", undefined);

        const response = await logRoutes["/api/logs/openclaw/content"].GET(
            openClawContentRequest(undefined, "999999")
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            content: "first\nsecond\n",
            file: fileName,
        });
    });

    it("rejects unsafe OpenClaw file kinds and links", async () => {
        const root = temporaryRoot("mira-openclaw-log-files-");
        setEnvironment("MIRA_DASHBOARD_LOGS_ROOT", root);
        setEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE", undefined);

        const directoryName = "openclaw-directory.log";
        mkdirSync(path.join(root, directoryName));
        const directory = await logRoutes["/api/logs/openclaw/content"].GET(
            openClawContentRequest(directoryName)
        );
        expect(directory.status).toBe(404);

        const linkedName = "openclaw-linked.log";
        writeFileSync(path.join(root, linkedName), "linked\n");
        linkSync(path.join(root, linkedName), path.join(root, "linked-copy.log"));
        const hardLinked = await logRoutes["/api/logs/openclaw/content"].GET(
            openClawContentRequest(linkedName)
        );
        expect(hardLinked.status).toBe(403);

        const symbolicName = "openclaw-symbolic.log";
        symlinkSync(path.join(root, linkedName), path.join(root, symbolicName));
        const symbolic = await logRoutes["/api/logs/openclaw/content"].GET(
            openClawContentRequest(symbolicName)
        );
        expect(symbolic.status).toBe(404);
    });

    it("maps unsafe roots and unexpected OpenClaw open errors", async () => {
        setEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE", undefined);
        setEnvironment("MIRA_DASHBOARD_LOGS_ROOT", "relative/logs");

        const invalidListing = logRoutes["/api/logs/openclaw/files"].GET();
        expect(invalidListing.status).toBe(500);
        const invalidContent = await logRoutes["/api/logs/openclaw/content"].GET(
            openClawContentRequest("openclaw-current.log")
        );
        expect(invalidContent.status).toBe(500);

        const root = temporaryRoot("mira-openclaw-log-long-name-");
        process.env.MIRA_DASHBOARD_LOGS_ROOT = root;
        const oversizedName = `openclaw-${"x".repeat(300)}.log`;
        const oversized = await logRoutes["/api/logs/openclaw/content"].GET(
            openClawContentRequest(oversizedName)
        );
        expect(oversized.status).toBe(500);
    });
});
