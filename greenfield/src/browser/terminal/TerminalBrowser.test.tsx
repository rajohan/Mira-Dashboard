import { describe, expect, spyOn, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

import type {
    TerminalConnectionTicket,
    TerminalRuntime,
    TerminalSessionSummary,
} from "../../contracts/terminal.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { createDashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { TerminalBrowser } from "./TerminalBrowser.tsx";
import type { TerminalEmulator } from "./terminalEmulator.ts";
import type {
    CreateTerminalSocketConnectionOptions,
    TerminalSocketConnection,
} from "./terminalProtocol.ts";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const sessionId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const runtime: TerminalRuntime = {
    clientMessageMaximumBytes: 16 * 1024,
    defaultLocation: { path: "/", rootId: "dashboard" },
    idleTimeoutMs: 10 * 60 * 1000,
    mode: "pty",
    outputReplayMaximumBytes: 256 * 1024,
    reconnectGraceMs: 15 * 1000,
    roots: [{ defaultPath: "/", id: "dashboard", label: "Dashboard project" }],
    serverMessageMaximumBytes: 32 * 1024,
    sessionMaximumDurationMs: 30 * 60 * 1000,
    supportsInput: true,
    supportsPty: true,
    supportsResize: true,
    supportsSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
    webSocketProtocol: "mira-terminal-v1",
};
const ticket: TerminalConnectionTicket = {
    afterSequence: 0,
    connectionToken: `${"a".repeat(32)}.${"b".repeat(64)}`,
    expiresAtMs: 1_800_000_060_000,
    sessionId,
    webSocketProtocol: "mira-terminal-v1",
    webSocketUrl: `/api/terminal/sessions/${sessionId}/socket`,
};
const connectedSession: TerminalSessionSummary = {
    dimensions: { columns: 80, rows: 24 },
    expiresAtMs: 1_800_001_800_000,
    idleExpiresAtMs: 1_800_000_600_000,
    location: runtime.defaultLocation,
    nextSequence: 1,
    replayAvailableFromSequence: 1,
    sessionId,
    startedAtMs: 1_800_000_000_000,
    state: "connected",
};

function createFakeEmulator() {
    let input: ((data: Uint8Array) => void) | undefined;
    const inputEnabled: boolean[] = [];
    const emulator: TerminalEmulator = {
        clear() {},
        copySelection: () => Promise.resolve("empty"),
        dispose() {},
        fit: () => ({ columns: 80, rows: 24 }),
        focus() {},
        open() {},
        onInput(callback) {
            input = callback;
            return () => {
                input = undefined;
            };
        },
        reset() {},
        search: () => false,
        setInputEnabled(enabled) {
            inputEnabled.push(enabled);
        },
        write(_data, callback) {
            callback();
        },
    };
    return {
        emulator,
        emitInput(data: Uint8Array) {
            input?.(data);
        },
        inputEnabled,
    };
}

describe("interactive terminal browser lifecycle", () => {
    test("prepares, attaches, relays input, and explicitly terminates one PTY", async () => {
        const queryClient = createDashboardQueryClient();
        const calls: { input: unknown; path: string }[] = [];
        const trpcClient = createDashboardTrpcClient({
            mutation(path, input) {
                calls.push({ input, path });
                if (path === "terminal.prepareSession") return Promise.resolve(ticket);
                if (path === "terminal.terminateSession") {
                    return Promise.resolve({ sessionId, terminated: true });
                }
                return Promise.reject(new TypeError("Unexpected terminal mutation"));
            },
            query(path) {
                if (path === "terminal.getRuntime") return Promise.resolve(runtime);
                if (path === "terminal.getActiveSession") {
                    return Promise.resolve({ status: "none" });
                }
                return Promise.reject(new TypeError("Unexpected terminal query"));
            },
        });
        const fakeEmulator = createFakeEmulator();
        const socketOptions: CreateTerminalSocketConnectionOptions[] = [];
        const sentInput: Uint8Array[] = [];
        let closeCalls = 0;
        const socketConnection: TerminalSocketConnection = {
            afterSequence: 0,
            close() {
                closeCalls += 1;
            },
            sendControl: () => true,
            sendInput(data) {
                sentInput.push(new Uint8Array(data));
                return true;
            },
        };
        const createSocketConnection = (
            options: CreateTerminalSocketConnectionOptions
        ) => {
            socketOptions.push(options);
            return socketConnection;
        };
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <TerminalBrowser
                        createEmulator={() => fakeEmulator.emulator}
                        createSocketConnection={createSocketConnection}
                    />
                </DashboardTrpcProvider>
            </QueryClientProvider>
        );

        try {
            await userEvent
                .setup()
                .click(await screen.findByRole("button", { name: "Start terminal" }));
            await waitFor(() => expect(socketOptions).toHaveLength(1));
            expect(calls[0]).toEqual({
                input: {
                    dimensions: { columns: 80, rows: 24 },
                    location: runtime.defaultLocation,
                },
                path: "terminal.prepareSession",
            });

            act(() => {
                socketOptions[0]?.callbacks.onOpen();
                socketOptions[0]?.callbacks.onControl({
                    replayAvailableFromSequence: 1,
                    resumed: false,
                    session: connectedSession,
                    type: "ready",
                });
            });
            expect(await screen.findByText("Connected")).toBeTruthy();
            act(() => fakeEmulator.emitInput(new Uint8Array([27, 91, 65])));
            expect(sentInput).toEqual([new Uint8Array([27, 91, 65])]);

            await userEvent
                .setup()
                .click(screen.getByRole("button", { name: "End terminal" }));
            await userEvent.setup().click(
                within(
                    screen.getByRole("dialog", {
                        name: "End interactive terminal?",
                    })
                ).getByRole("button", { name: "End terminal" })
            );
            await waitFor(() =>
                expect(calls.at(-1)).toEqual({
                    input: { sessionId },
                    path: "terminal.terminateSession",
                })
            );
            expect(closeCalls).toBe(1);
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("fresh pages manually resume from the oldest retained replay sequence", async () => {
        const queryClient = createDashboardQueryClient();
        const resumeInputs: unknown[] = [];
        const replaySession: TerminalSessionSummary = {
            ...connectedSession,
            nextSequence: 9,
            replayAvailableFromSequence: 4,
            state: "awaiting-reconnect",
        };
        const trpcClient = createDashboardTrpcClient({
            mutation(path, input) {
                if (path !== "terminal.prepareResume") {
                    return Promise.reject(new TypeError("Unexpected terminal mutation"));
                }
                resumeInputs.push(input);
                return Promise.resolve({ ...ticket, afterSequence: 3 });
            },
            query(path) {
                if (path === "terminal.getRuntime") return Promise.resolve(runtime);
                if (path === "terminal.getActiveSession") {
                    return Promise.resolve({ session: replaySession, status: "active" });
                }
                return Promise.reject(new TypeError("Unexpected terminal query"));
            },
        });
        const fakeEmulator = createFakeEmulator();
        const socketOptions: CreateTerminalSocketConnectionOptions[] = [];
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <TerminalBrowser
                        createEmulator={() => fakeEmulator.emulator}
                        createSocketConnection={(options) => {
                            socketOptions.push(options);
                            return {
                                afterSequence: options.ticket.afterSequence,
                                close() {},
                                sendControl: () => true,
                                sendInput: () => true,
                            };
                        }}
                    />
                </DashboardTrpcProvider>
            </QueryClientProvider>
        );

        try {
            await userEvent
                .setup()
                .click(await screen.findByRole("button", { name: "Resume terminal" }));
            await waitFor(() => expect(socketOptions).toHaveLength(1));
            expect(resumeInputs).toEqual([{ afterSequence: 3, sessionId }]);
            expect(socketOptions[0]?.ticket.afterSequence).toBe(3);
            expect(
                await screen.findByText(
                    "Some earlier output is no longer available. Showing the newest terminal output."
                )
            ).toBeTruthy();
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("keeps the received cursor and falls back to the retained replay floor", async () => {
        const queryClient = createDashboardQueryClient();
        const resumeInputs: unknown[] = [];
        const fallbackSession: TerminalSessionSummary = {
            ...connectedSession,
            nextSequence: 9,
            replayAvailableFromSequence: 5,
            state: "awaiting-reconnect",
        };
        let activeQueryCount = 0;
        let resumeCount = 0;
        const trpcClient = createDashboardTrpcClient({
            mutation(path, input) {
                if (path === "terminal.prepareSession") return Promise.resolve(ticket);
                if (path === "terminal.prepareResume") {
                    resumeInputs.push(input);
                    resumeCount += 1;
                    if (resumeCount === 1) {
                        return Promise.reject(
                            Object.assign(new Error("Terminal session not found"), {
                                data: { code: "NOT_FOUND" },
                            })
                        );
                    }
                    return Promise.resolve({ ...ticket, afterSequence: 4 });
                }
                return Promise.reject(new TypeError("Unexpected terminal mutation"));
            },
            query(path) {
                if (path === "terminal.getRuntime") return Promise.resolve(runtime);
                if (path === "terminal.getActiveSession") {
                    activeQueryCount += 1;
                    return Promise.resolve(
                        activeQueryCount === 1
                            ? { status: "none" }
                            : { session: fallbackSession, status: "active" }
                    );
                }
                return Promise.reject(new TypeError("Unexpected terminal query"));
            },
        });
        const fakeEmulator = createFakeEmulator();
        const socketOptions: CreateTerminalSocketConnectionOptions[] = [];
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <TerminalBrowser
                        createEmulator={() => fakeEmulator.emulator}
                        createSocketConnection={(options) => {
                            socketOptions.push(options);
                            return {
                                afterSequence: options.ticket.afterSequence,
                                close() {},
                                sendControl: () => true,
                                sendInput: () => true,
                            };
                        }}
                    />
                </DashboardTrpcProvider>
            </QueryClientProvider>
        );

        try {
            await userEvent
                .setup()
                .click(await screen.findByRole("button", { name: "Start terminal" }));
            await waitFor(() => expect(socketOptions).toHaveLength(1));
            act(() => {
                socketOptions[0]?.callbacks.onControl({
                    replayAvailableFromSequence: 1,
                    resumed: false,
                    session: connectedSession,
                    type: "ready",
                });
                socketOptions[0]?.callbacks.onClose({
                    afterSequence: 3,
                    expected: false,
                    kind: "transport",
                });
            });

            await waitFor(() => expect(socketOptions).toHaveLength(2), {
                timeout: 2000,
            });
            expect(resumeInputs).toEqual([
                { afterSequence: 3, sessionId },
                { afterSequence: 4, sessionId },
            ]);
            expect(socketOptions[1]?.ticket.afterSequence).toBe(4);
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("manual resume after same-page reconnect timeout keeps the displayed cursor", async () => {
        const queryClient = createDashboardQueryClient();
        const resumeInputs: unknown[] = [];
        const resumableSession: TerminalSessionSummary = {
            ...connectedSession,
            nextSequence: 9,
            replayAvailableFromSequence: 5,
            state: "awaiting-reconnect",
        };
        let activeQueryCount = 0;
        let automaticResumeAttempted = false;
        let resumeCount = 0;
        const trpcClient = createDashboardTrpcClient({
            mutation(path, input) {
                if (path === "terminal.prepareSession") return Promise.resolve(ticket);
                if (path === "terminal.prepareResume") {
                    resumeInputs.push(input);
                    resumeCount += 1;
                    if (resumeCount === 1) {
                        automaticResumeAttempted = true;
                        return Promise.reject(
                            Object.assign(new Error("Terminal session is busy"), {
                                data: { code: "CONFLICT" },
                            })
                        );
                    }
                    return Promise.resolve({ ...ticket, afterSequence: 7 });
                }
                return Promise.reject(new TypeError("Unexpected terminal mutation"));
            },
            query(path) {
                if (path === "terminal.getRuntime") return Promise.resolve(runtime);
                if (path === "terminal.getActiveSession") {
                    activeQueryCount += 1;
                    return Promise.resolve(
                        activeQueryCount === 1
                            ? { status: "none" }
                            : { session: resumableSession, status: "active" }
                    );
                }
                return Promise.reject(new TypeError("Unexpected terminal query"));
            },
        });
        const fakeEmulator = createFakeEmulator();
        const socketOptions: CreateTerminalSocketConnectionOptions[] = [];
        const nowSpy = spyOn(Date, "now");
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <TerminalBrowser
                        createEmulator={() => fakeEmulator.emulator}
                        createSocketConnection={(options) => {
                            socketOptions.push(options);
                            return {
                                afterSequence: options.ticket.afterSequence,
                                close() {},
                                sendControl: () => true,
                                sendInput: () => true,
                            };
                        }}
                    />
                </DashboardTrpcProvider>
            </QueryClientProvider>
        );

        try {
            await userEvent
                .setup()
                .click(await screen.findByRole("button", { name: "Start terminal" }));
            await waitFor(() => expect(socketOptions).toHaveLength(1));
            act(() => {
                socketOptions[0]?.callbacks.onControl({
                    replayAvailableFromSequence: 1,
                    resumed: false,
                    session: {
                        ...connectedSession,
                        nextSequence: 8,
                    },
                    type: "ready",
                });
            });

            const reconnectStartedAtMs = 1_800_000_000_000;
            nowSpy.mockImplementation(() =>
                automaticResumeAttempted
                    ? reconnectStartedAtMs + runtime.reconnectGraceMs
                    : reconnectStartedAtMs
            );
            act(() => {
                socketOptions[0]?.callbacks.onClose({
                    afterSequence: 7,
                    expected: false,
                    kind: "transport",
                });
            });

            await userEvent
                .setup()
                .click(
                    await screen.findByRole(
                        "button",
                        { name: "Resume terminal" },
                        { timeout: 2000 }
                    )
                );
            await waitFor(() => expect(socketOptions).toHaveLength(2));
            expect(resumeInputs).toEqual([
                { afterSequence: 7, sessionId },
                { afterSequence: 7, sessionId },
            ]);
            expect(socketOptions[1]?.ticket.afterSequence).toBe(7);
            expect(await screen.findByText("Reconnecting")).toBeTruthy();
            expect(
                screen.queryByText(
                    "Some earlier output is no longer available. Showing the newest terminal output."
                )
            ).toBeNull();
        } finally {
            nowSpy.mockRestore();
            view.unmount();
            queryClient.clear();
        }
    });
});
