import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

import logsRoutes, { __testing, subscribeToLogs, unsubscribeFromLogs } from "./logs.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const logsDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-logs-"));
const outsideDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-logs-outside-"));
const testFiles = ["openclaw-2099-03-03.log", "openclaw-2099-03-04.log"];
const RealDate = Date;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`Timed out waiting for ${label}`);
}

class FakeWebSocket {
    readonly sent: string[] = [];
    failSend = false;
    onSend?: () => void;

    send(data: string): void {
        if (this.failSend) {
            throw new Error("socket closed");
        }
        this.sent.push(data);
        this.onSend?.();
    }
}

async function startServer(): Promise<TestServer> {
    const app = express();
    logsRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

describe("logs routes", () => {
    let server: TestServer;

    before(async () => {
        __testing.setLogsDirForTest(logsDir);
        await mkdir(logsDir, { recursive: true });
        await mkdir(outsideDir, { recursive: true });
        await writeFile(
            path.join(logsDir, testFiles[0]),
            "old line 1\nold line 2\n",
            "utf8"
        );
        await writeFile(
            path.join(logsDir, testFiles[1]),
            "first\n\nsecond\nthird\n",
            "utf8"
        );
        await writeFile(path.join(logsDir, "not-openclaw.txt"), "ignored", "utf8");
        await writeFile(path.join(outsideDir, "secret.log"), "secret", "utf8");
        server = await startServer();
    });

    after(async () => {
        __testing.resetLogWatcherForTest();
        await server.close();
        await rm(logsDir, { recursive: true, force: true });
        await rm(outsideDir, { recursive: true, force: true });
    });

    it("lists OpenClaw log files and ignores unrelated files", async () => {
        const secretLink = path.join(logsDir, "openclaw-secret.log");
        await symlink(path.join(outsideDir, "secret.log"), secretLink);
        try {
            const response = await fetch(`${server.baseUrl}/api/logs/info`);
            const body = (await response.json()) as {
                logs: Array<{ name: string; size: number; modified: string }>;
            };

            assert.equal(response.status, 200);
            assert.equal(
                body.logs.some((log) => log.name === testFiles[0]),
                true
            );
            assert.equal(
                body.logs.some((log) => log.name === testFiles[1]),
                true
            );
            assert.equal(
                body.logs.some((log) => log.name === "not-openclaw.txt"),
                false
            );
            assert.equal(
                body.logs.some((log) => log.name === "openclaw-secret.log"),
                false
            );
        } finally {
            await rm(secretLink, { force: true });
        }
    });

    it("handles log info filesystem edge cases", async () => {
        const originalReaddirSync = fs.readdirSync;
        const originalLstatSync = fs.lstatSync;

        try {
            const missingRealRoot = path.join(logsDir, "missing-real-root");
            __testing.setLogsDirForTest(missingRealRoot);
            const missingRealRootList = await fetch(`${server.baseUrl}/api/logs/info`);
            assert.equal(missingRealRootList.status, 200);
            assert.deepEqual(await missingRealRootList.json(), { logs: [] });
            __testing.setLogsDirForTest(logsDir);

            const originalRealpathSync = fs.realpathSync;
            try {
                fs.realpathSync = ((target: fs.PathLike, options?: BufferEncoding) => {
                    if (String(target) === logsDir) {
                        const error = new Error(
                            "log root denied"
                        ) as NodeJS.ErrnoException;
                        error.code = "EACCES";
                        throw error;
                    }
                    return originalRealpathSync(target, options as never);
                }) as typeof fs.realpathSync;
                const deniedRealRoot = await fetch(`${server.baseUrl}/api/logs/info`);
                assert.equal(deniedRealRoot.status, 500);
                assert.deepEqual(await deniedRealRoot.json(), {
                    error: "log root denied",
                });
            } finally {
                fs.realpathSync = originalRealpathSync;
            }

            fs.readdirSync = ((target: fs.PathLike) => {
                if (target === logsDir) {
                    const error = new Error("rotated root") as NodeJS.ErrnoException;
                    error.code = "ENOENT";
                    throw error;
                }
                return originalReaddirSync(target);
            }) as typeof fs.readdirSync;

            const missingDir = await fetch(`${server.baseUrl}/api/logs/info`);
            assert.equal(missingDir.status, 200);
            assert.deepEqual(await missingDir.json(), { logs: [] });

            fs.readdirSync = originalReaddirSync;
            let skippedRotatedEntry = false;
            fs.lstatSync = ((target: fs.PathLike) => {
                if (String(target).endsWith(testFiles[0])) {
                    skippedRotatedEntry = true;
                    const error = new Error("rotated") as NodeJS.ErrnoException;
                    error.code = "ENOENT";
                    throw error;
                }
                return originalLstatSync(target);
            }) as typeof fs.lstatSync;

            const rotated = await fetch(`${server.baseUrl}/api/logs/info`);
            const rotatedBody = (await rotated.json()) as {
                logs: Array<{ name: string }>;
            };
            assert.equal(rotated.status, 200);
            assert.equal(skippedRotatedEntry, true);
            assert.equal(
                rotatedBody.logs.some((log) => log.name === testFiles[0]),
                false
            );

            fs.lstatSync = ((target: fs.PathLike) => {
                if (String(target).endsWith(testFiles[0])) {
                    const error = new Error("permission denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalLstatSync(target);
            }) as typeof fs.lstatSync;

            const failedStat = await fetch(`${server.baseUrl}/api/logs/info`);
            assert.equal(failedStat.status, 500);
            assert.deepEqual(await failedStat.json(), { error: "permission denied" });

            fs.lstatSync = originalLstatSync;
            fs.readdirSync = ((target: fs.PathLike) => {
                if (target === logsDir) {
                    const error = new Error("logs disappeared") as NodeJS.ErrnoException;
                    error.code = "ENOENT";
                    throw error;
                }
                return originalReaddirSync(target);
            }) as typeof fs.readdirSync;

            const disappearedList = await fetch(`${server.baseUrl}/api/logs/info`);
            assert.equal(disappearedList.status, 200);
            assert.deepEqual(await disappearedList.json(), { logs: [] });

            fs.readdirSync = ((target: fs.PathLike) => {
                if (target === logsDir) {
                    const error = new Error(
                        "logs became a file"
                    ) as NodeJS.ErrnoException;
                    error.code = "ENOTDIR";
                    throw error;
                }
                return originalReaddirSync(target);
            }) as typeof fs.readdirSync;

            const notDirectoryList = await fetch(`${server.baseUrl}/api/logs/info`);
            assert.equal(notDirectoryList.status, 200);
            assert.deepEqual(await notDirectoryList.json(), { logs: [] });

            fs.readdirSync = ((target: fs.PathLike) => {
                if (target === logsDir) throw new Error("cannot list logs");
                return originalReaddirSync(target);
            }) as typeof fs.readdirSync;

            const failedList = await fetch(`${server.baseUrl}/api/logs/info`);
            assert.equal(failedList.status, 500);
            assert.deepEqual(await failedList.json(), { error: "cannot list logs" });
        } finally {
            fs.readdirSync = originalReaddirSync;
            fs.lstatSync = originalLstatSync;
        }
    });

    it("returns full or tailed log content", async () => {
        const full = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(testFiles[1])}`
        );
        const fullBody = (await full.json()) as { content: string; file: string };

        assert.equal(full.status, 200);
        assert.equal(fullBody.file, testFiles[1]);
        assert.equal(fullBody.content, "first\n\nsecond\nthird\n");

        const tailed = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(
                testFiles[1]
            )}&lines=2`
        );
        const tailedBody = (await tailed.json()) as { content: string; file: string };

        assert.equal(tailed.status, 200);
        assert.equal(tailedBody.content, "second\nthird");

        const invalidTail = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(
                testFiles[1]
            )}&lines=not-a-number`
        );
        const invalidTailBody = (await invalidTail.json()) as { error: string };
        assert.equal(invalidTail.status, 400);
        assert.equal(invalidTailBody.error, "Invalid lines");

        const partialNumericTail = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(
                testFiles[1]
            )}&lines=10abc`
        );
        const partialNumericTailBody = (await partialNumericTail.json()) as {
            error: string;
        };
        assert.equal(partialNumericTail.status, 400);
        assert.equal(partialNumericTailBody.error, "Invalid lines");

        const negativeTail = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(
                testFiles[1]
            )}&lines=-2`
        );
        const negativeTailBody = (await negativeTail.json()) as { error: string };
        assert.equal(negativeTail.status, 400);
        assert.equal(negativeTailBody.error, "Invalid lines");

        const zeroTail = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(
                testFiles[1]
            )}&lines=0`
        );
        const zeroTailBody = (await zeroTail.json()) as { error: string };
        assert.equal(zeroTail.status, 400);
        assert.equal(zeroTailBody.error, "Invalid lines");

        const directoryName = "openclaw-2099-03-05.log";
        const directoryPath = path.join(logsDir, directoryName);
        await mkdir(directoryPath);
        try {
            const directory = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(directoryName)}`
            );
            assert.equal(directory.status, 404);
            assert.deepEqual(await directory.json(), { error: "Log file not found" });
        } finally {
            await rm(directoryPath, { recursive: true, force: true });
        }

        const mockedToday = new RealDate("2099-12-31T12:00:00.000Z")
            .toISOString()
            .split("T")[0];
        const todayFile = `openclaw-${mockedToday}.log`;
        await rm(path.join(logsDir, todayFile), { force: true });

        try {
            const frozenNow = new RealDate("2099-12-31T12:00:00.000Z").getTime();
            globalThis.Date = class extends RealDate {
                constructor(...args: unknown[]) {
                    if (args.length === 0) {
                        super("2099-12-31T12:00:00.000Z");
                        return;
                    }
                    super(...(args as [string | number | Date]));
                }

                static now() {
                    return frozenNow;
                }
            } as DateConstructor;

            const defaultMissing = await fetch(`${server.baseUrl}/api/logs/content`);
            assert.equal(defaultMissing.status, 404);
            assert.deepEqual(await defaultMissing.json(), {
                error: "Log file not found",
            });
        } finally {
            globalThis.Date = RealDate;
        }
    });

    it("rejects traversal and reports missing logs", async () => {
        const traversal = path.relative(logsDir, path.join(outsideDir, "secret.log"));
        const denied = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(traversal)}`
        );
        assert.equal(denied.status, 403);
        assert.deepEqual(await denied.json(), { error: "Access denied" });

        const missing = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent("openclaw-2099-03-05.log")}`
        );
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { error: "Log file not found" });

        const nestedUnderFile = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(`${testFiles[1]}/extra`)}`
        );
        assert.equal(nestedUnderFile.status, 404);
        assert.deepEqual(await nestedUnderFile.json(), {
            error: "Log file not found",
        });

        const invalidNullByte = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent("openclaw.log\0x")}`
        );
        assert.equal(invalidNullByte.status, 404);
        assert.deepEqual(await invalidNullByte.json(), {
            error: "Log file not found",
        });

        const rootDirectory = await fetch(
            `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(".")}`
        );
        assert.equal(rootDirectory.status, 404);
        assert.deepEqual(await rootDirectory.json(), {
            error: "Log file not found",
        });

        const rootLink = path.join(logsDir, "root-link.log");
        await symlink(logsDir, rootLink);
        try {
            const rootSymlink = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent("root-link.log")}`
            );
            assert.equal(rootSymlink.status, 404);
            assert.deepEqual(await rootSymlink.json(), {
                error: "Log file not found",
            });
        } finally {
            await rm(rootLink, { force: true });
        }

        const loopPath = path.join(logsDir, "loop.log");
        await symlink("loop.log", loopPath);
        try {
            const symlinkLoop = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent("loop.log")}`
            );
            assert.equal(symlinkLoop.status, 404);
            assert.deepEqual(await symlinkLoop.json(), {
                error: "Log file not found",
            });
        } finally {
            await rm(loopPath, { force: true });
        }

        const escapedLink = path.join(logsDir, "outside.log");
        await symlink(path.join(outsideDir, "secret.log"), escapedLink);
        try {
            const symlinkOutside = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent("outside.log")}`
            );
            assert.equal(symlinkOutside.status, 403);
            assert.deepEqual(await symlinkOutside.json(), {
                error: "Access denied",
            });
        } finally {
            await rm(escapedLink, { force: true });
        }
    });

    it("reads enough bytes to return requested tail lines", async () => {
        const logFile = "openclaw-2099-03-07.log";
        const logPath = path.join(logsDir, logFile);
        const lines = Array.from(
            { length: 160 },
            (_, index) => `line-${String(index).padStart(3, "0")} ${"x".repeat(1500)}`
        );
        await writeFile(logPath, `${lines.join("\n")}\n`, "utf8");

        try {
            const response = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(logFile)}&lines=120`
            );
            assert.equal(response.status, 200);
            const body = (await response.json()) as { content: string };
            const returnedLines = body.content.split("\n");
            assert.equal(returnedLines.length, 120);
            assert.equal(returnedLines[0]?.startsWith("line-040 "), true);
            assert.equal(returnedLines.at(-1)?.startsWith("line-159 "), true);
        } finally {
            await rm(logPath, { force: true });
        }
    });

    it("maps log content canonicalization and open failures", async () => {
        const originalRealpathSync = fs.realpathSync;

        try {
            fs.realpathSync = ((target: fs.PathLike) => {
                if (target === logsDir) {
                    throw Object.assign(new Error("root unavailable"), {
                        code: "EACCES",
                    });
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;

            const rootFailure = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(testFiles[1])}`
            );
            assert.equal(rootFailure.status, 500);
            assert.deepEqual(await rootFailure.json(), { error: "root unavailable" });
        } finally {
            fs.realpathSync = originalRealpathSync;
        }

        try {
            fs.realpathSync = ((target: fs.PathLike) => {
                if (path.resolve(String(target)) === path.join(logsDir, testFiles[1])) {
                    throw Object.assign(new Error("candidate unavailable"), {
                        code: "EACCES",
                    });
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;

            const candidateFailure = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(testFiles[1])}`
            );
            assert.equal(candidateFailure.status, 500);
            assert.deepEqual(await candidateFailure.json(), {
                error: "candidate unavailable",
            });
        } finally {
            fs.realpathSync = originalRealpathSync;
        }

        const racedFile = "openclaw-2099-03-06.log";
        const racedPath = path.join(logsDir, racedFile);
        await writeFile(racedPath, "gone\n", "utf8");
        try {
            fs.realpathSync = ((target: fs.PathLike) => {
                const result = originalRealpathSync(target);
                if (path.resolve(String(target)) === racedPath) {
                    fs.rmSync(racedPath, { force: true });
                }
                return result;
            }) as typeof fs.realpathSync;

            const openFailure = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(racedFile)}`
            );
            assert.equal(openFailure.status, 404);
            assert.deepEqual(await openFailure.json(), {
                error: "Log file not found",
            });
        } finally {
            fs.realpathSync = originalRealpathSync;
            await rm(racedPath, { force: true });
        }

        const unreadableFile = "openclaw-2099-03-07.log";
        const unreadablePath = path.join(logsDir, unreadableFile);
        await writeFile(unreadablePath, "blocked\n", "utf8");
        const originalOpen = fs.promises.open;
        try {
            fs.promises.open = ((targetPath: fs.PathLike, ...args: unknown[]) => {
                if (
                    Buffer.isBuffer(targetPath) &&
                    targetPath.toString() === unreadablePath
                ) {
                    throw Object.assign(new Error("EACCES: permission denied"), {
                        code: "EACCES",
                    });
                }
                return Reflect.apply(originalOpen, fs.promises, [
                    targetPath,
                    ...args,
                ]) as ReturnType<typeof fs.promises.open>;
            }) as typeof fs.promises.open;
            const permissionFailure = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(unreadableFile)}`
            );
            assert.equal(permissionFailure.status, 500);
            const permissionFailureBody = (await permissionFailure.json()) as {
                detail: string;
                error: string;
            };
            assert.equal(permissionFailureBody.error, "Failed to open log file");
            assert.equal(permissionFailureBody.detail, "Internal server error");
        } finally {
            fs.promises.open = originalOpen;
            await rm(unreadablePath, { force: true });
        }

        const zeroReadFile = "openclaw-2099-03-08.log";
        const zeroReadPath = path.join(logsDir, zeroReadFile);
        await writeFile(zeroReadPath, "line one\nline two\n", "utf8");
        try {
            fs.promises.open = (async (targetPath: fs.PathLike, ...args: unknown[]) => {
                const file = await Reflect.apply(originalOpen, fs.promises, [
                    targetPath,
                    ...args,
                ]);
                if (
                    Buffer.isBuffer(targetPath) &&
                    targetPath.toString() === zeroReadPath
                ) {
                    return {
                        close: () => file.close(),
                        read: async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) }),
                        stat: () => file.stat(),
                    } as unknown as fs.promises.FileHandle;
                }
                return file;
            }) as typeof fs.promises.open;
            const zeroRead = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(zeroReadFile)}&lines=1`
            );
            assert.equal(zeroRead.status, 200);
            assert.deepEqual(await zeroRead.json(), {
                content: "",
                file: zeroReadFile,
            });
        } finally {
            fs.promises.open = originalOpen;
            await rm(zeroReadPath, { force: true });
        }
    });

    it("sends log history to WebSocket subscribers and tracks unsubscribe", async () => {
        const today = new Date().toISOString().split("T")[0];
        const todayFile = `openclaw-${today}.log`;
        await writeFile(
            path.join(logsDir, todayFile),
            "ignored blank\n\nlatest one\nlatest two\n",
            "utf8"
        );

        const ws = new FakeWebSocket();
        try {
            subscribeToLogs(ws as never);
            await waitFor(
                () =>
                    ws.sent.some((message) => {
                        const parsed = JSON.parse(message) as { type?: string };
                        return parsed.type === "log_history_complete";
                    }),
                "log history completion"
            );

            assert.equal(__testing.subscriberCount(), 1);
            assert.deepEqual(JSON.parse(ws.sent[0] || "{}"), {
                type: "log_file",
                file: todayFile,
            });
            assert.deepEqual(
                ws.sent.slice(1, -1).map((message) => JSON.parse(message)),
                [
                    { type: "log", line: "ignored blank" },
                    { type: "log", line: "latest one" },
                    { type: "log", line: "latest two" },
                ]
            );
            assert.deepEqual(JSON.parse(ws.sent.at(-1) || "{}"), {
                type: "log_history_complete",
                count: 3,
            });
        } finally {
            unsubscribeFromLogs(ws as never);
            __testing.resetLogWatcherForTest();
            await rm(path.join(logsDir, todayFile), { force: true });
        }
    });

    it("stops sending log history after unsubscribe", async () => {
        const today = new Date().toISOString().split("T")[0];
        const todayFile = `openclaw-${today}.log`;
        await writeFile(path.join(logsDir, todayFile), "one\ntwo\n", "utf8");

        const ws = new FakeWebSocket();
        ws.onSend = () => {
            unsubscribeFromLogs(ws as never);
            ws.onSend = undefined;
        };
        try {
            subscribeToLogs(ws as never);
            await new Promise((resolve) => setTimeout(resolve, 25));
            assert.deepEqual(
                ws.sent.map((message) => JSON.parse(message)),
                [{ type: "log_file", file: todayFile }]
            );
        } finally {
            unsubscribeFromLogs(ws as never);
            __testing.resetLogWatcherForTest();
            await rm(path.join(logsDir, todayFile), { force: true });
        }
    });

    it("does not send log history when the socket is not subscribed", async () => {
        const ws = new FakeWebSocket();
        await __testing.sendLogHistoryForTest(ws as never);
        assert.deepEqual(ws.sent, []);
    });

    it("sends empty log history when today's log is missing", async () => {
        const today = new Date().toISOString().split("T")[0];
        const todayFile = `openclaw-${today}.log`;
        const todayPath = path.join(logsDir, todayFile);
        await rm(todayPath, { force: true });

        const ws = new FakeWebSocket();
        try {
            subscribeToLogs(ws as never);
            await waitFor(() => ws.sent.length >= 2, "empty log history");

            assert.deepEqual(JSON.parse(ws.sent[0] || "{}"), {
                type: "log_file",
                file: todayFile,
            });
            assert.deepEqual(JSON.parse(ws.sent[1] || "{}"), {
                type: "log_history_complete",
                count: 0,
            });
        } finally {
            unsubscribeFromLogs(ws as never);
            __testing.resetLogWatcherForTest();
            await rm(todayPath, { force: true });
        }
    });

    it("does not throw when log history sends fail", async () => {
        const ws = new FakeWebSocket();
        ws.failSend = true;
        try {
            subscribeToLogs(ws as never);
            await new Promise((resolve) => setTimeout(resolve, 25));
            assert.equal(__testing.subscriberCount(), 1);
        } finally {
            unsubscribeFromLogs(ws as never);
            __testing.resetLogWatcherForTest();
        }
    });

    it("ignores missing log files during direct polling", async () => {
        const today = new Date().toISOString().split("T")[0];
        const todayFile = `openclaw-${today}.log`;
        await rm(path.join(logsDir, todayFile), { force: true });
        const ws = new FakeWebSocket();
        subscribeToLogs(ws as never);
        try {
            await __testing.pollLogFileForTest();
            assert.equal(
                ws.sent
                    .map((entry) => JSON.parse(entry) as { type?: string })
                    .some((entry) => entry.type === "log"),
                false
            );
        } finally {
            unsubscribeFromLogs(ws as never);
            __testing.resetLogWatcherForTest();
            await rm(path.join(logsDir, todayFile), { force: true });
        }
    });

    it("sends empty log history when history read fails", async () => {
        const today = new Date().toISOString().split("T")[0];
        const todayFile = `openclaw-${today}.log`;
        const todayPath = path.join(logsDir, todayFile);
        const originalOpen = fs.promises.open;
        await writeFile(todayPath, "will fail\n", "utf8");

        try {
            fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
                const [target] = args;
                if (Buffer.isBuffer(target) && target.toString("utf8") === todayPath) {
                    throw new Error("cannot read history");
                }
                return originalOpen(...args);
            }) as typeof fs.promises.open;

            const ws = new FakeWebSocket();
            try {
                subscribeToLogs(ws as never);
                await waitFor(() => ws.sent.length >= 2, "failed log history");

                assert.deepEqual(JSON.parse(ws.sent[0] || "{}"), {
                    type: "log_file",
                    file: todayFile,
                });
                assert.deepEqual(JSON.parse(ws.sent[1] || "{}"), {
                    type: "log_history_complete",
                    count: 0,
                });
            } finally {
                unsubscribeFromLogs(ws as never);
            }
        } finally {
            fs.promises.open = originalOpen;
            __testing.resetLogWatcherForTest();
            await rm(todayPath, { force: true });
        }
    });

    it("polls appended log lines for subscribers and tolerates closed sockets", async () => {
        const today = new Date().toISOString().split("T")[0];
        const todayFile = `openclaw-${today}.log`;
        const todayPath = path.join(logsDir, todayFile);
        await writeFile(todayPath, "initial\n", "utf8");

        const ws = new FakeWebSocket();
        try {
            subscribeToLogs(ws as never);
            await waitFor(
                () =>
                    ws.sent.some((message) => {
                        const parsed = JSON.parse(message) as { type?: string };
                        return parsed.type === "log_history_complete";
                    }),
                "initial log history completion"
            );
            ws.sent.length = 0;

            await __testing.pollLogFileForTest();
            assert.equal(ws.sent.length, 0);

            await writeFile(todayPath, "initial\nnext one\n\nnext two\n", "utf8");
            await __testing.pollLogFileForTest();

            assert.deepEqual(
                ws.sent.map((message) => JSON.parse(message)),
                [
                    { type: "log", line: "next one" },
                    { type: "log", line: "next two" },
                ]
            );

            ws.sent.length = 0;
            await writeFile(todayPath, "truncated\n", "utf8");
            await __testing.pollLogFileForTest();
            assert.deepEqual(
                ws.sent.map((message) => JSON.parse(message)),
                [{ type: "log", line: "truncated" }]
            );

            ws.failSend = true;
            await writeFile(todayPath, "truncated\nignored send error\n", "utf8");
            await __testing.pollLogFileForTest();
            assert.equal(__testing.subscriberCount(), 1);
        } finally {
            unsubscribeFromLogs(ws as never);
            __testing.resetLogWatcherForTest();
            await rm(todayPath, { force: true });
        }
    });

    it("serializes watcher ticks and logs polling errors", async () => {
        const originalError = console.error;
        const errors: unknown[][] = [];
        console.error = (...args: unknown[]) => {
            errors.push(args);
        };

        const today = new Date().toISOString().split("T")[0];
        const todayPath = path.join(logsDir, `openclaw-${today}.log`);
        await rm(todayPath, { force: true });
        await symlink("openclaw-missing-target.log", todayPath);

        try {
            __testing.runLogWatcherTickForTest();
            __testing.runLogWatcherTickForTest();
            await waitFor(() => errors.length === 1, "log watcher error");

            assert.equal(errors.length, 1);
            assert.equal(errors[0]?.[0], "[LogWatcher] Error:");
        } finally {
            console.error = originalError;
            await rm(todayPath, { force: true });
            __testing.resetLogWatcherForTest();
        }
    });

    it("maps missing log root to not found", async () => {
        const originalRealpathSync = fs.realpathSync;

        try {
            fs.realpathSync = ((target: fs.PathLike) => {
                if (target === logsDir) {
                    const error = new Error("missing root") as NodeJS.ErrnoException;
                    error.code = "ENOTDIR";
                    throw error;
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;

            const response = await fetch(
                `${server.baseUrl}/api/logs/content?file=${encodeURIComponent(testFiles[0])}`
            );
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), {
                error: "Log file not found",
            });
        } finally {
            fs.realpathSync = originalRealpathSync;
        }
    });

    it("propagates unexpected polling errors", async () => {
        const originalRealpathSync = fs.realpathSync;
        const today = new Date().toISOString().split("T")[0];
        const todayPath = path.join(logsDir, `openclaw-${today}.log`);
        await rm(todayPath, { force: true });
        await symlink("openclaw-missing-target.log", todayPath);

        try {
            fs.realpathSync = ((target: fs.PathLike) => {
                if (target === logsDir) {
                    const error = new Error("root denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;
            await assert.rejects(() => __testing.pollLogFileForTest(), /root denied/u);

            fs.realpathSync = ((target: fs.PathLike) => {
                if (target === logsDir) {
                    const error = new Error("root missing") as NodeJS.ErrnoException;
                    error.code = "ENOENT";
                    throw error;
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;
            await __testing.pollLogFileForTest();

            fs.realpathSync = originalRealpathSync;
            await assert.rejects(
                () => __testing.pollLogFileForTest(),
                /Failed to resolve path|Log file not found|ENOENT|ELOOP/
            );
        } finally {
            fs.realpathSync = originalRealpathSync;
            await rm(todayPath, { force: true });
            __testing.resetLogWatcherForTest();
        }
    });
});
