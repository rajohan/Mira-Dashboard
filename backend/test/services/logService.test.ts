import { describe, expect, it } from "bun:test";
import { appendFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type DashboardSocket } from "../../src/services/gateway/dashboardSocket.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
import { captureStructuredLogs } from "../support/structuredLogCapture.ts";
describe("backend log services", () => {
    const { createTemporaryRoot, rememberEnvironment, waitFor } =
        createServiceBehaviorHarness();
    it("formats OpenClaw log dates in the app timezone regardless of host TZ", async () => {
        rememberEnvironment("TZ");
        const { formatOpenClawLogDate } = await import("../../src/lib/logRoots.ts");
        const osloOnlyDate = new Date("2026-06-27T22:30:00.000Z");
        process.env.TZ = "UTC";
        expect(formatOpenClawLogDate(osloOnlyDate)).toBe("2026-06-28");
        process.env.TZ = "Not/A_Real_Zone";
        expect(() => formatOpenClawLogDate(osloOnlyDate)).not.toThrow();
        expect(formatOpenClawLogDate(osloOnlyDate)).toBe("2026-06-28");
    });
    it("sends log history to subscribers from the configured isolated log root", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        const logsRoot = createTemporaryRoot("mira-log-streams-test-");
        process.env.MIRA_DASHBOARD_LOGS_ROOT = logsRoot;
        const { formatOpenClawLogDate } = await import("../../src/lib/logRoots.ts");
        const today = formatOpenClawLogDate(new Date());
        const logFile = path.join(logsRoot, `openclaw-${today}.log`);
        writeFileSync(logFile, "first line\nsecond line\n");
        const messages: unknown[] = [];
        const socket = {
            send: (message: string) => {
                messages.push(JSON.parse(message) as unknown);
            },
        } as DashboardSocket;
        const { subscribeToLogs, unsubscribeFromLogs } =
            await import("../../src/services/logStreams.ts");
        subscribeToLogs(socket);
        try {
            await waitFor(() =>
                messages.some(
                    (message) =>
                        typeof message === "object" &&
                        message !== null &&
                        (
                            message as {
                                type?: unknown;
                            }
                        ).type === "log_history_complete"
                )
            );
            expect(messages).toContainEqual({
                type: "log",
                history: true,
                line: "first line",
                lineId: "0",
            });
            expect(messages).toContainEqual({
                type: "log",
                history: true,
                line: "second line",
                lineId: "11",
            });
            expect(messages).toContainEqual({
                type: "log_history_complete",
                count: 2,
            });
            unsubscribeFromLogs(socket);
            messages.length = 0;
            const multibytePrefix = "aé";
            const historyWindowBytes = 128 * 1024;
            const multibyteHistoryLine =
                "history boundary " +
                "z".repeat(
                    historyWindowBytes - Buffer.byteLength("\nhistory boundary \n") - 1
                );
            writeFileSync(logFile, `${multibytePrefix}\n${multibyteHistoryLine}\n`);
            subscribeToLogs(socket);
            await waitFor(() =>
                messages.some(
                    (message) =>
                        typeof message === "object" &&
                        message !== null &&
                        (
                            message as {
                                type?: unknown;
                            }
                        ).type === "log_history_complete"
                )
            );
            const historyCompleteIndex = messages.findIndex(
                (message) =>
                    typeof message === "object" &&
                    message !== null &&
                    (
                        message as {
                            type?: unknown;
                        }
                    ).type === "log_history_complete"
            );
            expect(
                messages.slice(0, historyCompleteIndex).filter(
                    (message) =>
                        typeof message === "object" &&
                        message !== null &&
                        (
                            message as {
                                type?: unknown;
                            }
                        ).type === "log"
                )
            ).toEqual([
                {
                    type: "log",
                    history: true,
                    line: multibyteHistoryLine,
                    lineId: String(Buffer.byteLength(multibytePrefix) + 1),
                },
            ]);
            expect(messages[historyCompleteIndex]).toEqual({
                type: "log_history_complete",
                count: 1,
            });
            appendFileSync(logFile, "third line\n");
            await waitFor(
                () =>
                    messages.some((message) =>
                        JSON.stringify(message).includes("third line")
                    ),
                2500
            );
            expect(messages).toContainEqual({
                type: "log",
                line: "third line",
            });
        } finally {
            unsubscribeFromLogs(socket);
        }
    });
    it("completes log history when today's file is missing and ignores subscriber send errors", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        const logsRoot = createTemporaryRoot("mira-log-streams-empty-test-");
        process.env.MIRA_DASHBOARD_LOGS_ROOT = logsRoot;
        const structuredLogs = captureStructuredLogs();
        const messages: unknown[] = [];
        const socket = {
            send: (message: string) => {
                messages.push(JSON.parse(message) as unknown);
            },
        } as DashboardSocket;
        const throwingSocket = {
            send: () => {
                throw new Error("subscriber closed");
            },
        } as unknown as DashboardSocket;
        const { subscribeToLogs, unsubscribeFromLogs } =
            await import("../../src/services/logStreams.ts");
        subscribeToLogs(socket);
        subscribeToLogs(throwingSocket);
        try {
            await waitFor(() =>
                messages.some(
                    (message) =>
                        typeof message === "object" &&
                        message !== null &&
                        (
                            message as {
                                type?: unknown;
                            }
                        ).type === "log_history_complete"
                )
            );
            expect(messages).toContainEqual({
                type: "log_history_complete",
                count: 0,
            });
            expect(structuredLogs.entries).toContainEqual(
                expect.objectContaining({
                    event: "openclaw_logs.history_send_failed",
                    level: "error",
                })
            );
        } finally {
            unsubscribeFromLogs(socket);
            unsubscribeFromLogs(throwingSocket);
            structuredLogs.stop();
        }
    });
    it("validates configured log roots before routes and streams use them", async () => {
        rememberEnvironment("MIRA_DASHBOARD_LOGS_ROOT");
        const logsRoot = createTemporaryRoot("mira-log-root-test-");
        const logFileRoot = path.join(logsRoot, "not-a-directory");
        const symlinkRoot = path.join(logsRoot, "linked-root");
        writeFileSync(logFileRoot, "not a directory");
        symlinkSync(logsRoot, symlinkRoot);
        const { resolveRealLogsDirectory } = await import("../../src/lib/logRoots.ts");
        process.env.MIRA_DASHBOARD_LOGS_ROOT = logsRoot;
        expect(resolveRealLogsDirectory()).toBe(logsRoot);
        process.env.MIRA_DASHBOARD_LOGS_ROOT = "relative/logs";
        expect(() => resolveRealLogsDirectory()).toThrow(
            "Log directory must be absolute"
        );
        process.env.MIRA_DASHBOARD_LOGS_ROOT = path.parse(logsRoot).root;
        expect(() => resolveRealLogsDirectory()).toThrow(
            "Log directory cannot be the filesystem root"
        );
        process.env.MIRA_DASHBOARD_LOGS_ROOT = symlinkRoot;
        expect(() => resolveRealLogsDirectory()).toThrow(
            "Log directory must not be a symlink"
        );
        process.env.MIRA_DASHBOARD_LOGS_ROOT = logFileRoot;
        expect(() => resolveRealLogsDirectory()).toThrow(
            "Log directory must be a directory"
        );
    });
});
