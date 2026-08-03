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

import { requestUrl } from "../../../test/support/fetch.ts";
import { database } from "../../src/database/connection.ts";
const cleanupCallbacks: Array<() => Promise<void> | void> = [];
function logTailLineIds(startOffset: number, content: string): string[] {
    const rawLines = content.split("\n");
    const lineIds: string[] = [];
    let offset = startOffset;
    for (const [index, line] of rawLines.entries()) {
        lineIds.push(String(offset));
        offset += Buffer.byteLength(line);
        if (index < rawLines.length - 1) {
            offset += 1;
        }
    }
    return lineIds;
}
function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}
function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() =>
        rmSync(root, {
            force: true,
            recursive: true,
        })
    );
    return root;
}
afterEach(async () => {
    while (cleanupCallbacks.length > 0) await cleanupCallbacks.pop()?.();
    database
        .prepare(
            "DELETE FROM task_updates WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database
        .prepare(
            "DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database.prepare("DELETE FROM tasks WHERE title LIKE 'Coverage %'").run();
    database
        .prepare(
            "DELETE FROM openclaw_cron_job_metadata WHERE job_id LIKE 'coverage-%' OR job_id = 'item-cron'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM notifications WHERE dedupe_key LIKE 'quota:%' OR dedupe_key LIKE 'openclaw:%'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM quota_alert_state WHERE provider IN ('openrouter', 'elevenlabs', 'synthetic', 'openai')"
        )
        .run();
    database.prepare("DELETE FROM openclaw_alert_state WHERE id = 1").run();
    database
        .prepare(
            "DELETE FROM scheduled_job_runs WHERE job_id LIKE 'cache.%' OR job_id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM scheduled_jobs WHERE id LIKE 'cache.%' OR id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM cache_entries WHERE key IN ('quotas.summary', 'system.host', 'system.openclaw', 'git.workspace', 'backup.kopia.status', 'backup.walg.status', 'log_rotation.state', 'weather.spydeberg')"
        )
        .run();
    database.prepare("DELETE FROM cache_entries WHERE key LIKE 'moltbook.%'").run();
    database
        .prepare(
            "DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'coverage-%')"
        )
        .run();
    database.prepare("DELETE FROM auth_rate_limit_buckets").run();
    database.prepare("DELETE FROM users WHERE username LIKE 'coverage-%'").run();
});
describe("backend log and media routes", () => {
    it("serves log route listing and guarded tail reads from an isolated log root", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        const logsRoot = createTemporaryRoot("mira-log-route-coverage-");
        const currentLog = path.join(logsRoot, "openclaw-2026-06-25.log");
        const olderLog = path.join(logsRoot, "openclaw-2026-06-24.log");
        const ignoredLog = path.join(logsRoot, "other.log");
        writeFileSync(currentLog, "line 1\nline 2\nline 3\n");
        writeFileSync(olderLog, "older\n");
        writeFileSync(ignoredLog, "ignore\n");
        process.env.MIRA_DASHBOARD_LOGS_ROOT = logsRoot;
        const { logRoutes } = await import("../../src/routes/logRoutes.ts");
        const info = logRoutes["/api/logs/openclaw/files"].GET();
        expect(info.json()).resolves.toMatchObject({
            logs: expect.arrayContaining([
                expect.objectContaining({
                    name: "openclaw-2026-06-25.log",
                }),
                expect.objectContaining({
                    name: "openclaw-2026-06-24.log",
                }),
            ]),
        });
        const explicitTail = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log&lines=2"
            )
        );
        expect(explicitTail.json()).resolves.toEqual({
            content: "line 2\nline 3\n",
            file: "openclaw-2026-06-25.log",
            lineIds: ["7", "14", "21"],
        });
        const largePrefix = `${"x".repeat(2 * 1024 * 1024 + 1024)}\n`;
        const largePrefixLength = Buffer.byteLength(largePrefix);
        writeFileSync(currentLog, `${largePrefix}complete tail\n`);
        const cappedTail = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log&lines=5000"
            )
        );
        expect(cappedTail.json()).resolves.toMatchObject({
            content: "complete tail\n",
            file: "openclaw-2026-06-25.log",
            lineIds: logTailLineIds(largePrefixLength, "complete tail\n"),
        });
        const boundaryTailStart = "boundary first\nboundary second\n";
        const boundaryPrefix = "prefix before boundary\n";
        const boundaryTail =
            boundaryTailStart +
            "z".repeat(64 * 1024 - Buffer.byteLength(boundaryTailStart));
        writeFileSync(currentLog, `${boundaryPrefix}${boundaryTail}`);
        const boundaryTailResponse = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log"
            )
        );
        const boundaryTailBody = (await boundaryTailResponse.json()) as {
            content: string;
            lineIds: string[];
        };
        expect(boundaryTailBody.content.startsWith(boundaryTailStart)).toBe(true);
        expect(boundaryTailBody.lineIds[0]).toBe(
            String(Buffer.byteLength(boundaryPrefix))
        );
        const prefixedJsonTailStart =
            '2026-06-27T20:00:00Z {"_meta":{"logLevelName":"INFO"},"0":"prefixed json tail"}\nplain after prefixed json\n';
        const prefixedJsonTail =
            prefixedJsonTailStart +
            "z".repeat(64 * 1024 - Buffer.byteLength(prefixedJsonTailStart));
        writeFileSync(currentLog, `${boundaryPrefix}${prefixedJsonTail}`);
        const prefixedJsonTailResponse = await logRoutes[
            "/api/logs/openclaw/content"
        ].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log"
            )
        );
        const prefixedJsonTailBody = (await prefixedJsonTailResponse.json()) as {
            content: string;
            lineIds: string[];
        };
        expect(prefixedJsonTailBody.content.startsWith(prefixedJsonTailStart)).toBe(true);
        expect(prefixedJsonTailBody.lineIds[0]).toBe(
            String(Buffer.byteLength(boundaryPrefix))
        );
        const multibytePrefix = "aé";
        const multibyteTailStart = "\nmultibyte boundary\n";
        const multibyteTail =
            multibyteTailStart +
            "z".repeat(64 * 1024 - Buffer.byteLength(multibyteTailStart) - 1);
        writeFileSync(currentLog, `${multibytePrefix}${multibyteTail}`);
        const multibyteTailResponse = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log"
            )
        );
        const multibyteTailBody = (await multibyteTailResponse.json()) as {
            content: string;
            lineIds: string[];
        };
        expect(multibyteTailBody.content.startsWith("multibyte boundary\n")).toBe(true);
        expect(multibyteTailBody.lineIds[0]).toBe(
            String(Buffer.byteLength(multibytePrefix) + 1)
        );
        const metadataPlainTailStart =
            "runtimeVersion mismatch in _meta plain warning\nplain after metadata warning\n";
        const metadataPlainTail =
            metadataPlainTailStart +
            "z".repeat(64 * 1024 - Buffer.byteLength(metadataPlainTailStart));
        writeFileSync(currentLog, `${boundaryPrefix}${metadataPlainTail}`);
        const metadataPlainTailResponse = await logRoutes[
            "/api/logs/openclaw/content"
        ].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log"
            )
        );
        const metadataPlainTailBody = (await metadataPlainTailResponse.json()) as {
            content: string;
            lineIds: string[];
        };
        expect(metadataPlainTailBody.content.startsWith(metadataPlainTailStart)).toBe(
            true
        );
        expect(metadataPlainTailBody.lineIds[0]).toBe(
            String(Buffer.byteLength(boundaryPrefix))
        );
        const structuredFragment = String.raw`{\"subsystem\":\"gateway/ws\"}","1":"partial"`;
        writeFileSync(
            currentLog,
            largePrefix +
                structuredFragment +
                "\n" +
                "plain warning tail\n" +
                '{"level":"info","message":"complete json tail"}\n'
        );
        const cappedJsonTail = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log&lines=5000"
            )
        );
        const cappedJsonTailContent =
            'plain warning tail\n{"level":"info","message":"complete json tail"}\n';
        expect(cappedJsonTail.json()).resolves.toMatchObject({
            content: cappedJsonTailContent,
            file: "openclaw-2026-06-25.log",
            lineIds: logTailLineIds(
                largePrefixLength + Buffer.byteLength(structuredFragment) + 1,
                cappedJsonTailContent
            ),
        });
        writeFileSync(
            currentLog,
            largePrefix +
                structuredFragment +
                "\n" +
                "plain warning tail\n" +
                ": retrying tail\n" +
                '{"level":"info","message":"complete json tail"}\n'
        );
        const cappedPlainTail = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log&lines=2"
            )
        );
        const cappedPlainTailContent =
            ': retrying tail\n{"level":"info","message":"complete json tail"}\n';
        expect(cappedPlainTail.json()).resolves.toMatchObject({
            content: cappedPlainTailContent,
            file: "openclaw-2026-06-25.log",
            lineIds: logTailLineIds(
                largePrefixLength +
                    Buffer.byteLength(structuredFragment) +
                    1 +
                    Buffer.byteLength("plain warning tail\n"),
                cappedPlainTailContent
            ),
        });
        const fragmentLookingPlainTailContent =
            ': first complete plain tail\n{"level":"info","message":"complete json tail"}\n';
        writeFileSync(currentLog, `${largePrefix}${fragmentLookingPlainTailContent}`);
        const cappedFragmentLookingPlainTail = await logRoutes[
            "/api/logs/openclaw/content"
        ].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log&lines=5000"
            )
        );
        expect(cappedFragmentLookingPlainTail.json()).resolves.toMatchObject({
            content: fragmentLookingPlainTailContent,
            file: "openclaw-2026-06-25.log",
            lineIds: logTailLineIds(largePrefixLength, fragmentLookingPlainTailContent),
        });
        const leadingBlankTailContent =
            '\n\n{"level":"info","message":"blank-preserved json tail"}\n';
        writeFileSync(currentLog, `${largePrefix}${leadingBlankTailContent}`);
        const leadingBlankTail = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log&lines=5000"
            )
        );
        expect(leadingBlankTail.json()).resolves.toMatchObject({
            content: leadingBlankTailContent,
            file: "openclaw-2026-06-25.log",
            lineIds: logTailLineIds(largePrefixLength, leadingBlankTailContent),
        });
        const blankSeparatedTailContent =
            "older plain tail\n" + "\n".repeat(70 * 1024) + "newest plain tail\n";
        writeFileSync(currentLog, blankSeparatedTailContent);
        const blankSeparatedTail = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log&lines=2"
            )
        );
        const blankSeparatedTailBody = (await blankSeparatedTail.json()) as {
            content: string;
            file: string;
            lineIds: string[];
        };
        expect(blankSeparatedTailBody.file).toBe("openclaw-2026-06-25.log");
        expect(blankSeparatedTailBody.content).toBe(
            "older plain tail\n\n\nnewest plain tail\n"
        );
        expect(blankSeparatedTailBody.lineIds).toHaveLength(5);
        expect(blankSeparatedTailBody.lineIds).toContain("0");
        expect(blankSeparatedTailBody.lineIds).toContain(
            String(Buffer.byteLength("older plain tail\n") + 70 * 1024)
        );
        const invalidLines = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log&lines=abc"
            )
        );
        expect(invalidLines.status).toBe(400);
        const pathTraversal = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=../openclaw-2026-06-25.log"
            )
        );
        expect(pathTraversal.status).toBe(404);
        rmSync(currentLog);
        const missingLog = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log"
            )
        );
        expect(missingLog.status).toBe(404);
        rmSync(logsRoot, {
            force: true,
            recursive: true,
        });
        const missingInfoRoot = logRoutes["/api/logs/openclaw/files"].GET();
        expect(missingInfoRoot.json()).resolves.toEqual({
            logs: [],
            unavailableReason: "The log directory is unavailable.",
        });
        const missingContentRoot = await logRoutes["/api/logs/openclaw/content"].GET(
            new Request(
                "https://test.local/api/logs/openclaw/content?file=openclaw-2026-06-25.log"
            )
        );
        expect(missingContentRoot.status).toBe(404);
    });
    it("reports unavailable host logs explicitly in isolated Dashboard dev", async () => {
        rememberEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE");
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = "1";
        delete process.env.MIRA_DASHBOARD_LOGS_ROOT;
        const { logRoutes } = await import("../../src/routes/logRoutes.ts");
        const response = logRoutes["/api/logs/openclaw/files"].GET();
        expect(response.json()).resolves.toEqual({
            logs: [],
            unavailableReason: "Host logs are unavailable in isolated Dashboard dev.",
        });
    });
    it("serves the isolated development backend's captured structured logs", async () => {
        rememberEnvironment("MIRA_DASHBOARD_APPLICATION_LOG_PATH");
        rememberEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE");
        const logsRoot = createTemporaryRoot("mira-dashboard-log-route-");
        const appLog = path.join(logsRoot, "dashboard.ndjson");
        const lines = [
            '{"event":"first","level":"info"}',
            '{"event":"second","level":"warn"}',
            '{"event":"third","level":"error"}',
        ];
        writeFileSync(appLog, `${lines.join("\n")}\n`);
        process.env.MIRA_DASHBOARD_APPLICATION_LOG_PATH = appLog;
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = "1";
        const { logRoutes } = await import("../../src/routes/logRoutes.ts");
        const response = await logRoutes["/api/logs/dashboard"].GET(
            new Request("https://test.local/api/logs/dashboard?lines=2")
        );
        const body = (await response.json()) as {
            content: string;
            lineIds: string[];
        };
        expect(response.status).toBe(200);
        expect(body.content).toBe(`${lines[1]}\n${lines[2]}\n`);
        expect(body.lineIds).toHaveLength(3);
    });
    it("serves media from isolated OpenClaw roots while rejecting unsafe paths", async () => {
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const openclawRoot = createTemporaryRoot("mira-media-route-");
        const outsideRoot = createTemporaryRoot("mira-media-outside-");
        const mediaRoot = path.join(openclawRoot, "media");
        mkdirSync(path.join(mediaRoot, "images"), {
            recursive: true,
        });
        mkdirSync(path.join(mediaRoot, "folder"), {
            recursive: true,
        });
        writeFileSync(path.join(mediaRoot, "images", "dashboard.txt"), "media ok");
        writeFileSync(
            path.join(mediaRoot, "images", "dashboard.json"),
            '{"status":"ok"}'
        );
        writeFileSync(
            path.join(mediaRoot, "images", "dashboard.svg"),
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10" /></svg>'
        );
        writeFileSync(path.join(mediaRoot, "images", "report.pdf"), "pdf data");
        writeFileSync(path.join(mediaRoot, "images", "linked.txt"), "linked media");
        linkSync(
            path.join(mediaRoot, "images", "linked.txt"),
            path.join(mediaRoot, "images", "linked-hardlink.txt")
        );
        writeFileSync(
            path.join(outsideRoot, "secret.txt"),
            "outside media should not be served"
        );
        symlinkSync(
            path.join(outsideRoot, "secret.txt"),
            path.join(mediaRoot, "images", "outside-link.txt")
        );
        process.env.OPENCLAW_HOME = openclawRoot;
        delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        const { mediaRoutes } = await import("../../src/routes/mediaRoutes.ts");
        const missingPath = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media")
        );
        expect(missingPath.status).toBe(403);
        const invalidPath = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=bad%00path")
        );
        expect(invalidPath.status).toBe(400);
        const invalidPreview = await mediaRoutes["/api/media"].GET(
            new Request(
                "https://test.local/api/media?path=images/dashboard.txt&preview=active"
            )
        );
        expect(invalidPreview.status).toBe(400);
        const directory = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=folder")
        );
        expect(directory.status).toBe(400);
        const outside = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/outside-link.txt")
        );
        expect(outside.status).toBe(403);
        const hardlink = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/linked-hardlink.txt")
        );
        expect(hardlink.status).toBe(403);
        const served = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/dashboard.txt")
        );
        expect(served.status).toBe(200);
        expect(served.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(served.text()).resolves.toBe("media ok");
        const textPreview = await mediaRoutes["/api/media"].GET(
            new Request(
                "https://test.local/api/media?path=images/dashboard.json&preview=text"
            )
        );
        expect(textPreview.status).toBe(200);
        expect(textPreview.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        expect(await textPreview.text()).toBe('{"status":"ok"}');
        const svgDownload = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/dashboard.svg")
        );
        expect(svgDownload.status).toBe(200);
        expect(svgDownload.headers.get("Content-Type")).toBe("application/octet-stream");
        const svgPreview = await mediaRoutes["/api/media"].GET(
            new Request(
                "https://test.local/api/media?path=images/dashboard.svg&preview=image"
            )
        );
        expect(svgPreview.status).toBe(200);
        expect(svgPreview.headers.get("Content-Type")).toBe("image/svg+xml");
        expect(svgPreview.headers.get("Content-Security-Policy")).toBe(
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
        );
        const invalidImagePreview = await mediaRoutes["/api/media"].GET(
            new Request(
                "https://test.local/api/media?path=images/dashboard.txt&preview=image"
            )
        );
        expect(invalidImagePreview.status).toBe(415);
        const invalidTextPreview = await mediaRoutes["/api/media"].GET(
            new Request(
                "https://test.local/api/media?path=images/report.pdf&preview=text"
            )
        );
        expect(invalidTextPreview.status).toBe(415);
        const pdfDownload = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/report.pdf")
        );
        expect(pdfDownload.status).toBe(200);
        expect(pdfDownload.headers.get("Content-Type")).toBe("application/pdf");
        process.env.OPENCLAW_HOME = createTemporaryRoot("mira-media-empty-root-");
        const missingMediaRoot = await mediaRoutes["/api/media"].GET(
            new Request("https://test.local/api/media?path=images/dashboard.txt")
        );
        expect(missingMediaRoot.status).toBe(404);
    });
    it("proxies managed Gateway media without exposing its bearer token", async () => {
        rememberEnvironment("OPENCLAW_GATEWAY_URL");
        rememberEnvironment("OPENCLAW_GATEWAY_TOKEN");
        process.env.OPENCLAW_GATEWAY_URL = "wss://gateway.example.test/base";
        process.env.OPENCLAW_GATEWAY_TOKEN = "environment-secret";
        const previousToken = database
            .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
            .get() as
            | {
                  value: string;
              }
            | undefined;
        cleanupCallbacks.push(() => {
            database.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();
            if (previousToken) {
                database
                    .prepare(
                        "INSERT INTO app_config (key, value, updated_at) VALUES ('gateway_token', ?, ?)"
                    )
                    .run(previousToken.value, new Date().toISOString());
            }
        });
        database
            .prepare(
                "INSERT INTO app_config (key, value, updated_at) VALUES ('gateway_token', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
            )
            .run("proxy-secret", new Date().toISOString());
        const originalFetch = fetch;
        const gatewayRequests: Array<Parameters<typeof fetch>> = [];
        const gatewayFetch = jest.fn((...requestArguments: Parameters<typeof fetch>) => {
            return Promise.try(() => {
                gatewayRequests.push(requestArguments);
                if (requestArguments.length !== 2) {
                    throw new Error("Expected Gateway URL and request init");
                }
                return new Response(Uint8Array.from([1, 2, 3]), {
                    headers: {
                        "Cache-Control": "public, max-age=86400",
                        "Content-Disposition": 'inline; filename="generated.png"',
                        "Content-Type": "image/png",
                    },
                });
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: gatewayFetch,
            writable: true,
        });
        const gatewayHeadersTimeoutController = new AbortController();
        const gatewayTimeoutSpy = jest
            .spyOn(AbortSignal, "timeout")
            .mockReturnValue(gatewayHeadersTimeoutController.signal);
        cleanupCallbacks.push(
            () => {
                Object.defineProperty(globalThis, "fetch", {
                    configurable: true,
                    value: originalFetch,
                    writable: true,
                });
            },
            () => gatewayTimeoutSpy.mockRestore()
        );
        const { mediaRoutes } = await import("../../src/routes/mediaRoutes.ts");
        const mediaPath =
            "/api/chat/media/outgoing/agent%3Amain%3Amain/123e4567-e89b-42d3-a456-426614174000/full";
        const invalidPreviewMode = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}?preview=download`)
        );
        expect(invalidPreviewMode.status).toBe(400);
        gatewayFetch.mockRejectedValueOnce(new Error("Gateway unavailable"));
        const unavailableGateway = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}`)
        );
        expect(unavailableGateway.status).toBe(502);
        gatewayFetch.mockResolvedValueOnce(
            new Response("missing", {
                status: 404,
            })
        );
        const missingGatewayMedia = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}`)
        );
        expect(missingGatewayMedia.status).toBe(404);
        gatewayFetch.mockResolvedValueOnce(
            new Response("failed", {
                status: 500,
            })
        );
        const failedGatewayMedia = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}`)
        );
        expect(failedGatewayMedia.status).toBe(502);
        gatewayFetch.mockResolvedValueOnce(
            new Response("binary", {
                headers: {
                    "Content-Type": "application/octet-stream",
                },
            })
        );
        const unavailableTextPreview = await mediaRoutes[
            "/api/chat/media/outgoing/*"
        ].GET(new Request(`https://dashboard.test${mediaPath}?preview=text`));
        expect(unavailableTextPreview.status).toBe(415);
        gatewayFetch.mockResolvedValueOnce(
            new Response("plain", {
                headers: {
                    "Content-Type": "text/plain",
                },
            })
        );
        const unavailableImagePreview = await mediaRoutes[
            "/api/chat/media/outgoing/*"
        ].GET(new Request(`https://dashboard.test${mediaPath}?preview=image`));
        expect(unavailableImagePreview.status).toBe(415);
        gatewayFetch.mockResolvedValueOnce(
            new Response(
                new ReadableStream<Uint8Array>({
                    pull() {
                        throw new Error("Gateway text body failed");
                    },
                }),
                {
                    headers: {
                        "Content-Type": "text/plain",
                    },
                }
            )
        );
        const failedTextPreview = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}?preview=text`)
        );
        expect(failedTextPreview.status).toBe(504);
        gatewayFetch.mockResolvedValueOnce(
            new Response("oversized", {
                headers: {
                    "Content-Length": String(16 * 1024 * 1024 + 1),
                    "Content-Type": "image/png",
                },
            })
        );
        const oversizedImagePreview = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}?preview=image`)
        );
        expect(oversizedImagePreview.status).toBe(413);
        gatewayFetch.mockResolvedValueOnce(
            new Response("<svg></svg>", {
                headers: {
                    "Content-Disposition": 'inline; filename="fallback.svg"',
                    "Content-Type": "application/octet-stream",
                },
            })
        );
        const extensionBasedSvgPreview = await mediaRoutes[
            "/api/chat/media/outgoing/*"
        ].GET(new Request(`https://dashboard.test${mediaPath}?preview=image`));
        expect(extensionBasedSvgPreview.status).toBe(200);
        expect(extensionBasedSvgPreview.headers.get("Content-Type")).toBe(
            "image/svg+xml"
        );
        const proxied = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}`)
        );
        expect(proxied.status).toBe(200);
        expect(proxied.headers.get("Content-Type")).toBe("image/png");
        expect(proxied.headers.get("Content-Disposition")).toBe(
            'inline; filename="generated.png"'
        );
        expect(proxied.headers.get("Cache-Control")).toBe("private, no-store");
        expect([...new Uint8Array(await proxied.arrayBuffer())]).toEqual([1, 2, 3]);
        expect(gatewayFetch).toHaveBeenCalledTimes(9);
        const gatewayRequestArguments = gatewayRequests[0];
        if (!gatewayRequestArguments) {
            throw new Error("Gateway request arguments were not captured");
        }
        const [gatewayRequest, gatewayRequestInit] = gatewayRequestArguments;
        expect(requestUrl(gatewayRequest)).toBe(
            `https://gateway.example.test${mediaPath}`
        );
        expect(gatewayRequestInit).toMatchObject({
            headers: {
                Authorization: "Bearer environment-secret",
            },
            redirect: "manual",
        });
        expect(gatewayTimeoutSpy).not.toHaveBeenCalled();
        gatewayHeadersTimeoutController.abort();
        expect(gatewayRequestInit?.signal?.aborted).toBe(false);
        gatewayFetch.mockResolvedValueOnce(
            new Response("name,value\nMira,1", {
                headers: {
                    "Cache-Control": "public, max-age=86400",
                    "Content-Disposition": 'inline; filename="data.csv"',
                    "Content-Type": "text/csv; charset=utf-8",
                },
            })
        );
        const preview = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}?preview=text`)
        );
        expect(preview.status).toBe(200);
        expect(preview.headers.get("Cache-Control")).toBe("private, no-store");
        expect(preview.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        expect(await preview.text()).toBe("name,value\nMira,1");
        gatewayFetch.mockResolvedValueOnce(
            new Response("x".repeat(1024 * 1024 + 1), {
                headers: {
                    "Content-Type": "text/plain",
                },
            })
        );
        const oversizedPreview = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}?preview=text`)
        );
        expect(oversizedPreview.status).toBe(413);
        const activeSvg =
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
        gatewayFetch.mockResolvedValueOnce(
            new Response(activeSvg, {
                headers: {
                    "Cache-Control": "public, max-age=86400",
                    "Content-Disposition": 'inline; filename="generated.svg"',
                    "Content-Type": "image/svg+xml; charset=utf-8",
                },
            })
        );
        const svgDownload = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}`)
        );
        expect(svgDownload.headers.get("Content-Type")).toBe("application/octet-stream");
        expect(svgDownload.headers.get("Content-Disposition")).toBe(
            'attachment; filename="generated.svg"'
        );
        gatewayFetch.mockResolvedValueOnce(
            new Response(activeSvg, {
                headers: {
                    "Content-Disposition": 'inline; filename="generated.svg"',
                    "Content-Type": "image/svg+xml; charset=utf-8",
                },
            })
        );
        const svgPreview = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}?preview=image`)
        );
        expect(svgPreview.status).toBe(200);
        expect(svgPreview.headers.get("Cache-Control")).toBe("private, no-store");
        expect(svgPreview.headers.get("Content-Type")).toBe("image/svg+xml");
        expect(svgPreview.headers.get("Content-Security-Policy")).toBe(
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
        );
        expect(await svgPreview.text()).toBe(activeSvg);
        gatewayFetch.mockResolvedValueOnce(
            new Response(Uint8Array.from([4, 5, 6]), {
                headers: {
                    "Cache-Control": "public, max-age=86400",
                    "Content-Disposition": 'inline; filename="generated.png"',
                    "Content-Type": "image/png",
                },
            })
        );
        const rasterPreview = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}?preview=image`)
        );
        expect(rasterPreview.status).toBe(200);
        expect(rasterPreview.headers.get("Cache-Control")).toBe("private, no-store");
        expect(rasterPreview.headers.get("Content-Type")).toBe("image/png");
        expect([...new Uint8Array(await rasterPreview.arrayBuffer())]).toEqual([4, 5, 6]);
        const originalSetTimeout = setTimeout;
        let didAbortStalledPreview = false;
        gatewayFetch.mockImplementationOnce(
            (...requestArguments: Parameters<typeof fetch>) => {
                return Promise.try(() => {
                    const requestSignal = requestArguments[1]?.signal;
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                const closeTimeout = originalSetTimeout(
                                    () => controller.close(),
                                    100
                                );
                                requestSignal?.addEventListener(
                                    "abort",
                                    () => {
                                        didAbortStalledPreview = true;
                                        clearTimeout(closeTimeout);
                                        controller.error(
                                            new Error("Gateway preview body timed out")
                                        );
                                    },
                                    {
                                        once: true,
                                    }
                                );
                            },
                        }),
                        {
                            headers: {
                                "Content-Disposition": 'inline; filename="stalled.png"',
                                "Content-Type": "image/png",
                            },
                        }
                    );
                });
            }
        );
        const gatewayBodyTimeoutSpy = jest
            .spyOn(globalThis, "setTimeout")
            .mockImplementationOnce(((callback: () => void) =>
                originalSetTimeout(callback, 0)) as unknown as typeof setTimeout);
        const stalledPreview = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}?preview=image`)
        );
        gatewayBodyTimeoutSpy.mockRestore();
        expect(stalledPreview.status).toBe(504);
        expect(didAbortStalledPreview).toBe(true);
        gatewayFetch.mockResolvedValueOnce(
            new Response("<html><script>alert(1)</script></html>", {
                headers: {
                    "Content-Disposition": 'inline; filename="page.html"',
                    "Content-Type": "text/html; charset=utf-8",
                },
            })
        );
        const htmlDownload = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(`https://dashboard.test${mediaPath}`)
        );
        expect(htmlDownload.headers.get("Content-Type")).toBe("application/octet-stream");
        expect(htmlDownload.headers.get("Content-Disposition")).toBe(
            'attachment; filename="page.html"'
        );
        const nonV4Uuid = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(
                "https://dashboard.test/api/chat/media/outgoing/agent%3Amain%3Amain/018f47a2-9b7c-7cc8-a123-456789abcdef/full"
            )
        );
        expect(nonV4Uuid.status).toBe(404);
        const rejected = await mediaRoutes["/api/chat/media/outgoing/*"].GET(
            new Request(
                "https://dashboard.test/api/chat/media/outgoing/agent%3Amain%3Amain/not-a-uuid/full"
            )
        );
        expect(rejected.status).toBe(404);
        expect(gatewayFetch).toHaveBeenCalledTimes(16);
    });
});
