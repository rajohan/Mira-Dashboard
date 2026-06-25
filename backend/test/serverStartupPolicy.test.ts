import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Server } from "bun";
import { describe, expect, it, jest } from "bun:test";

describe("server start scheduler policy", () => {
    it("starts scheduled jobs unless explicitly disabled", async () => {
        const { shouldStartScheduledJobs } = await import("../src/serverStartPolicy.ts");

        expect(shouldStartScheduledJobs({})).toBe(true);
        expect(
            shouldStartScheduledJobs({
                MIRA_DASHBOARD_DISABLE_SCHEDULER: "0",
            })
        ).toBe(true);
        expect(
            shouldStartScheduledJobs({
                MIRA_DASHBOARD_DISABLE_SCHEDULER: "1",
            })
        ).toBe(false);
    });

    it("resolves backend startup entrypoint and gateway token decisions without starting services", async () => {
        const { isDirectEntrypoint, resolveGatewayToken, shouldStartOnImport } =
            await import("../src/serverStart.ts");

        expect(
            resolveGatewayToken(
                {
                    OPENCLAW_GATEWAY_TOKEN: " gateway-token ",
                    OPENCLAW_TOKEN: "legacy-token",
                },
                () => "persisted-token"
            )
        ).toBe("gateway-token");
        expect(
            resolveGatewayToken(
                { OPENCLAW_TOKEN: " legacy-token " },
                () => "persisted-token"
            )
        ).toBe("legacy-token");
        expect(resolveGatewayToken({}, () => " persisted-token ")).toBe(
            "persisted-token"
        );
        expect(resolveGatewayToken({}, () => "")).toBeUndefined();

        expect(
            isDirectEntrypoint("/tmp/serverStart.ts", "file:///tmp/serverStart.ts")
        ).toBe(true);
        expect(isDirectEntrypoint("/tmp/other.ts", "file:///tmp/serverStart.ts")).toBe(
            false
        );
        expect(isDirectEntrypoint(undefined, "file:///tmp/serverStart.ts")).toBe(false);

        expect(shouldStartOnImport("1", false)).toBe(true);
        expect(shouldStartOnImport(undefined, true)).toBe(true);
        expect(shouldStartOnImport("0", false)).toBe(false);
    });

    it("starts listening-time services with and without a configured gateway token", async () => {
        const originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
        const originalSchedulerDisabled = process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
        process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = "1";
        const gatewayModule = await import("../src/gateway.ts");
        const { database } = await import("../src/database.ts");
        const serverStartModule = await import("../src/serverStart.ts");
        database
            .prepare(
                "INSERT INTO cache_entries (key, data_json, source, updated_at, last_attempt_at, expires_at, status, consecutive_failures, metadata_json) VALUES ('quotas.summary', '{\"providers\":[]}', 'test', ?, ?, ?, 'fresh', 0, '{}') ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json, source = excluded.source, updated_at = excluded.updated_at, last_attempt_at = excluded.last_attempt_at, expires_at = excluded.expires_at, status = excluded.status, consecutive_failures = excluded.consecutive_failures, metadata_json = excluded.metadata_json"
            )
            .run(Date.now(), Date.now(), Date.now() + 60_000);
        const initSpy = jest
            .spyOn(gatewayModule.default, "init")
            .mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            delete process.env.OPENCLAW_GATEWAY_TOKEN;
            serverStartModule.handleServerListening();
            expect(warnSpy).toHaveBeenCalledWith(
                "[Backend] No gateway token configured yet; waiting for bootstrap registration"
            );

            process.env.OPENCLAW_GATEWAY_TOKEN = " test-token ";
            serverStartModule.handleServerListening();
            expect(initSpy).toHaveBeenCalledWith("test-token");
            await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
            initSpy.mockRestore();
            warnSpy.mockRestore();
            errorSpy.mockRestore();
            if (originalGatewayToken === undefined) {
                delete process.env.OPENCLAW_GATEWAY_TOKEN;
            } else {
                process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
            }
            if (originalSchedulerDisabled === undefined) {
                delete process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER;
            } else {
                process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = originalSchedulerDisabled;
            }
            database
                .prepare("DELETE FROM cache_entries WHERE key = 'quotas.summary'")
                .run();
        }
    });

    it("starts and stops the backend server with isolated runtime state", async () => {
        const environmentKeys = [
            "MIRA_DASHBOARD_DB_PATH",
            "MIRA_DASHBOARD_DISABLE_SCHEDULER",
            "MIRA_DASHBOARD_FRONTEND_PATH",
            "OPENCLAW_HOME",
        ] as const;
        const originalEnvironment = Object.fromEntries(
            environmentKeys.map((key) => [key, process.env[key]])
        );
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-server-start-"));
        const frontendRoot = path.join(temporaryRoot, "frontend");
        const openclawRoot = path.join(temporaryRoot, "openclaw");
        mkdirSync(frontendRoot, { recursive: true });
        mkdirSync(openclawRoot, { recursive: true });
        writeFileSync(path.join(frontendRoot, "index.html"), "<!doctype html>");
        writeFileSync(path.join(openclawRoot, "openclaw.json"), "{}\n");

        process.env.MIRA_DASHBOARD_DB_PATH = path.join(temporaryRoot, "dashboard.db");
        process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = "1";
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;
        process.env.OPENCLAW_HOME = openclawRoot;
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const { startBackendServer, stopBackendServer } =
                await import("../src/serverStart.ts");

            startBackendServer(0);
            startBackendServer(0);
            await stopBackendServer();
            await stopBackendServer();
        } finally {
            errorSpy.mockRestore();
            warnSpy.mockRestore();
            for (const key of environmentKeys) {
                const originalValue = originalEnvironment[key];
                if (originalValue === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = originalValue;
                }
            }
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });

    it("wires Bun server websocket hooks and static fallbacks", async () => {
        const originalFrontendPath = process.env.MIRA_DASHBOARD_FRONTEND_PATH;
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-server-hooks-"));
        const frontendRoot = path.join(temporaryRoot, "frontend");
        mkdirSync(path.join(frontendRoot, "assets"), { recursive: true });
        writeFileSync(path.join(frontendRoot, "index.html"), "<!doctype html>");
        writeFileSync(path.join(frontendRoot, "assets", "chunk.js"), "export {};\n");
        writeFileSync(path.join(frontendRoot, ".hidden.txt"), "secret\n");
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;

        const serveSpy = jest.spyOn(Bun, "serve").mockImplementation(
            ((options: unknown) =>
                ({
                    port: 0,
                    requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 1 }),
                    stop: async () => {},
                    [Symbol.for("mira.test.options")]: options,
                }) as unknown as Server<unknown>) as typeof Bun.serve
        );
        try {
            const gatewayModule = await import("../src/gateway.ts");
            const handleDashboardClientSpy = jest
                .spyOn(gatewayModule.default, "handleDashboardClient")
                .mockImplementation(() => {});
            const { createServer } = await import("../src/server.ts");
            const optionsSymbol = Symbol.for("mira.test.options");
            const server = createServer(0) as Server<unknown> & {
                [optionsSymbol]: {
                    fetch: (
                        request: Request,
                        server: Server<unknown>
                    ) => Promise<Response> | Response;
                    websocket: {
                        close: (ws: {
                            data: { closeHandlers: Array<() => void> };
                        }) => void;
                        error: (
                            ws: {
                                data: {
                                    errorHandlers: Array<(error: unknown) => void>;
                                };
                            },
                            error: unknown
                        ) => void;
                        message: (
                            ws: {
                                data: {
                                    messageHandlers: Array<
                                        (data: string | Buffer) => void
                                    >;
                                };
                            },
                            message: string | Uint8Array
                        ) => void;
                        open: (ws: {
                            close: (code?: number, reason?: string) => void;
                            data: {
                                closeHandlers: Array<() => void>;
                                errorHandlers: Array<(error: unknown) => void>;
                                messageHandlers: Array<(data: string | Buffer) => void>;
                                socket?: unknown;
                            };
                            readyState: number;
                            send: (data: string) => void;
                        }) => void;
                    };
                };
            };
            const options = server[optionsSymbol];

            const apiFallback = await options.fetch(
                new Request("https://test.local/api/missing"),
                server
            );
            expect(apiFallback.status).toBe(404);
            await expect(apiFallback.json()).resolves.toEqual({ error: "Not found" });

            const badPath = await options.fetch(
                new Request("https://test.local/%E0%A4%A"),
                server
            );
            expect(badPath.status).toBe(400);

            const hiddenFile = await options.fetch(
                new Request("https://test.local/.hidden.txt"),
                server
            );
            expect(hiddenFile.status).toBe(404);

            const rootAsset = await options.fetch(
                new Request("https://test.local/chunk.js"),
                server
            );
            expect(rootAsset.status).toBe(200);
            expect(await rootAsset.text()).toBe("export {};\n");

            const missingNestedAsset = await options.fetch(
                new Request("https://test.local/nested/chunk.js"),
                server
            );
            expect(missingNestedAsset.status).toBe(404);

            const wsForbidden = await options.fetch(
                new Request("https://test.local/ws", {
                    headers: { Origin: "https://evil.example" },
                }),
                server
            );
            expect(wsForbidden.status).toBe(403);

            const closeHandler = jest.fn();
            const errorHandler = jest.fn();
            const messageHandler = jest.fn();
            const sendSpy = jest.fn();
            const closeSpy = jest.fn();
            const ws: {
                close: (code?: number, reason?: string) => void;
                data: {
                    closeHandlers: Array<() => void>;
                    errorHandlers: Array<(error: unknown) => void>;
                    messageHandlers: Array<(data: string | Buffer) => void>;
                    socket?: {
                        close: (code?: number, reason?: string) => void;
                        send: (data: string) => void;
                    };
                };
                readyState: number;
                send: (data: string) => void;
            } = {
                close: closeSpy,
                data: {
                    closeHandlers: [closeHandler],
                    errorHandlers: [errorHandler],
                    messageHandlers: [messageHandler],
                },
                readyState: WebSocket.OPEN,
                send: sendSpy,
            };
            options.websocket.open(ws);
            expect(handleDashboardClientSpy).toHaveBeenCalledWith(ws.data.socket);
            ws.data.socket?.close(1000, "done");
            ws.data.socket?.send("state");
            expect(closeSpy).toHaveBeenCalledWith(1000, "done");
            expect(sendSpy).toHaveBeenCalledWith("state");

            options.websocket.message(ws, new TextEncoder().encode("hello"));
            options.websocket.error(ws, new Error("boom"));
            options.websocket.close(ws);
            expect(messageHandler).toHaveBeenCalledWith(Buffer.from("hello"));
            expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
            expect(closeHandler).toHaveBeenCalled();

            handleDashboardClientSpy.mockRestore();
        } finally {
            serveSpy.mockRestore();
            if (originalFrontendPath === undefined) {
                delete process.env.MIRA_DASHBOARD_FRONTEND_PATH;
            } else {
                process.env.MIRA_DASHBOARD_FRONTEND_PATH = originalFrontendPath;
            }
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });
});
