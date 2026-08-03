import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";

import { requestUrl } from "../../../../test/support/fetch";
import { logsCollection } from "../../collections/logs";
import { Logs } from "../../pages/Logs";
import { Sessions } from "../../pages/Sessions";
import { authActions } from "../../stores/authStore";
import { parseLogLine } from "../../utils/logUtilities";
import { createPageBehaviorHarness } from "../support/pageBehaviorHarness";
describe("Dashboard logs, chat, and session pages", () => {
    const {
        FakeWebSocket,
        animationFrameState,
        apiResponse,
        cancelAnimationFrameForTest,
        dashboardSessionFixture,
        emitNormalizedSessions,
        findSocketRequest,
        flushQueuedTimers,
        jobsApiState,
        logsApiState,
        originalGlobals,
        renderChatPage,
        renderPage,
        requestAnimationFrameForTest,
        resetLogsCollectionForTest,
        resetSessionsCollectionForTest,
        respondToSocketRequest,
        scrollIntoViewMock,
        terminalApiState,
    } = createPageBehaviorHarness();
    beforeEach(() => {
        FakeWebSocket.instances = [];
        terminalApiState.expectedExecCwd = "/tmp";
        terminalApiState.wasJobStopped = false;
        logsApiState.dashboardRequests = 0;
        logsApiState.openclawHundredLineRequests = 0;
        logsApiState.simulateOpenclawTruncation = false;
        logsApiState.unavailableReason = undefined;
        jobsApiState.cronName = "heartbeat";
        jobsApiState.heartbeatDisableIntent = undefined;
        jobsApiState.heartbeatEnabled = true;
        jobsApiState.heartbeatIntervalSeconds = 1800;
        jobsApiState.heartbeatRuns = [
            {
                cancellable: false,
                id: 1,
                jobId: "heartbeat",
                queuedAt: "2026-06-24T08:00:00.000Z",
                resourceClass: "light",
                status: "success",
                triggerType: "manual",
                startedAt: "2026-06-24T08:00:00.000Z",
                finishedAt: "2026-06-24T08:01:00.000Z",
                output: {
                    message: "ok",
                },
            },
        ];
        const sessionLastSeenAt = Date.now();
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: new Date(
                    sessionLastSeenAt + 30 * 24 * 60 * 60_000
                ).toISOString(),
                lastSeenAt: new Date(sessionLastSeenAt).toISOString(),
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "mira",
            },
        });
        Object.defineProperties(globalThis, {
            fetch: {
                configurable: true,
                value: jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
                    Promise.try(() =>
                        apiResponse(requestUrl(input), init?.method ?? "GET", init)
                    )
                ),
                writable: true,
            },
            WebSocket: {
                configurable: true,
                value: FakeWebSocket,
                writable: true,
            },
            requestAnimationFrame: {
                configurable: true,
                value: requestAnimationFrameForTest,
                writable: true,
            },
            cancelAnimationFrame: {
                configurable: true,
                value: cancelAnimationFrameForTest,
                writable: true,
            },
        });
        scrollIntoViewMock.mockReset();
        Element.prototype.scrollIntoView = scrollIntoViewMock;
    });
    afterEach(() => {
        cleanup();
        resetLogsCollectionForTest();
        resetSessionsCollectionForTest();
        authActions.clearSession();
        localStorage.clear();
        animationFrameState.frames.clear();
        Object.defineProperties(globalThis, {
            fetch: {
                configurable: true,
                value: originalGlobals.fetch,
                writable: true,
            },
            WebSocket: {
                configurable: true,
                value: originalGlobals.WebSocket,
                writable: true,
            },
            requestAnimationFrame: {
                configurable: true,
                value: originalGlobals.requestAnimationFrame,
                writable: true,
            },
            cancelAnimationFrame: {
                configurable: true,
                value: originalGlobals.cancelAnimationFrame,
                writable: true,
            },
        });
        if (originalGlobals.scrollIntoViewDescriptor) {
            Object.defineProperty(
                Element.prototype,
                "scrollIntoView",
                originalGlobals.scrollIntoViewDescriptor
            );
        } else {
            Reflect.deleteProperty(Element.prototype, "scrollIntoView");
        }
    });
    it("drives logs page loading, searching, level filtering, and clearing", async () => {
        const user = userEvent.setup();
        const exportedBlobs: Blob[] = [];
        const createObjectUrl = jest.fn((blob: Blob) => {
            exportedBlobs.push(blob);
            return "blob:logs-export";
        });
        const revokeObjectUrl = jest.fn();
        const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
        const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
        const anchorClick = jest
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => {});
        let view: ReturnType<typeof renderPage> | undefined;
        try {
            Object.defineProperties(URL, {
                createObjectURL: {
                    configurable: true,
                    value: createObjectUrl,
                    writable: true,
                },
                revokeObjectURL: {
                    configurable: true,
                    value: revokeObjectUrl,
                    writable: true,
                },
            });
            await logsCollection.preload();
            view = renderPage(createElement(Logs), {
                withSocket: true,
            });
            await waitFor(() => {
                expect(logsApiState.dashboardRequests).toBeGreaterThan(0);
            });
            await waitFor(() => {
                expect(Array.from(logsCollection, ([, log]) => log.msg)).toContain(
                    "server.started"
                );
            });
            await waitFor(() => {
                expect(screen.getByText("1 entry")).toBeInTheDocument();
            });
            expect(logsApiState.dashboardRequests).toBe(1);
            await user.click(
                screen.getByRole("button", {
                    name: "OpenClaw logs",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("openclaw.log")).toBeInTheDocument();
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });
            const duplicateFallbackLog = parseLogLine(
                JSON.stringify({
                    level: "info",
                    time: "2026-06-24T08:00:00.000Z",
                    msg: "dashboard ready",
                })
            );
            expect(duplicateFallbackLog).toBeDefined();
            await act(async () => {
                logsCollection.utils.writeUpsert(duplicateFallbackLog!);
                await Promise.resolve();
            });
            await waitFor(() => {
                expect(screen.getByText("3 entries")).toBeInTheDocument();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "Reload",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "Export",
                })
            );
            const dedupedExport = await exportedBlobs.at(-1)?.text();
            expect(dedupedExport?.match(/dashboard ready/g)).toHaveLength(1);
            await user.click(
                screen.getByRole("button", {
                    name: "100 lines",
                })
            );
            await user.click(
                screen.getByRole("menuitem", {
                    name: "5000 lines",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("3 entries")).toBeInTheDocument();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "Export",
                })
            );
            const expandedExport = await exportedBlobs.at(-1)?.text();
            expect(expandedExport).toContain("expanded tail only");
            expect(expandedExport?.indexOf("expanded tail only")).toBeLessThan(
                expandedExport?.indexOf("dashboard ready") ?? 0
            );
            const liveLog = parseLogLine(
                JSON.stringify({
                    level: "info",
                    time: "2026-06-24T08:02:00.000Z",
                    msg: "live after snapshot",
                }),
                "400"
            );
            const fallbackLiveLog = parseLogLine("fallback live after snapshot");
            expect(liveLog).toBeDefined();
            expect(fallbackLiveLog).toBeDefined();
            await act(async () => {
                logsCollection.utils.writeUpsert(liveLog!);
                logsCollection.utils.writeUpsert(fallbackLiveLog!);
                await Promise.resolve();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "5000 lines",
                })
            );
            await user.click(
                screen.getByRole("menuitem", {
                    name: "100 lines",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("4 entries")).toBeInTheDocument();
                expect(screen.queryByText("expanded tail only")).not.toBeInTheDocument();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "Export",
                })
            );
            const livePreservedExport = await exportedBlobs.at(-1)?.text();
            expect(livePreservedExport).toContain("live after snapshot");
            expect(livePreservedExport).toContain("fallback live after snapshot");
            expect(livePreservedExport).not.toContain("expanded tail only");
            await user.click(
                screen.getByRole("button", {
                    name: "openclaw.log",
                })
            );
            await user.click(
                screen.getByRole("menuitem", {
                    name: "archived.log",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("1 entry")).toBeInTheDocument();
                expect(screen.queryByText("live after snapshot")).not.toBeInTheDocument();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "Export",
                })
            );
            const archivedExport = await exportedBlobs.at(-1)?.text();
            expect(archivedExport).toContain("archived dashboard ready");
            expect(archivedExport).not.toContain("live after snapshot");
            await user.click(
                screen.getByRole("button", {
                    name: "archived.log",
                })
            );
            await user.click(
                screen.getByRole("menuitem", {
                    name: "openclaw.log",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });
            const searchInput = screen.getByPlaceholderText("Search logs...");
            await user.type(searchInput, " failed ");
            await waitFor(() => {
                expect(screen.getByText(/1 of 2 entries/)).toBeInTheDocument();
            });
            await user.clear(searchInput);
            await user.type(searchInput, "missing");
            await waitFor(() => {
                expect(
                    screen.getByText("No logs match your filter.")
                ).toBeInTheDocument();
            });
            await user.clear(searchInput);
            await waitFor(() => {
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "error",
                })
            );
            await waitFor(() => {
                expect(screen.getByText(/1 of 2 entries/)).toBeInTheDocument();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "error",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("2 entries")).toBeInTheDocument();
            });
            logsApiState.simulateOpenclawTruncation = true;
            await user.click(
                screen.getByRole("button", {
                    name: "Reload",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("1 entry")).toBeInTheDocument();
                expect(screen.queryByText("live after snapshot")).not.toBeInTheDocument();
                expect(screen.queryByText("failed backup")).not.toBeInTheDocument();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "Export",
                })
            );
            const truncatedExport = await exportedBlobs.at(-1)?.text();
            expect(truncatedExport).toContain("truncated dashboard ready");
            expect(truncatedExport).not.toContain("live after snapshot");
            expect(truncatedExport).not.toContain("fallback live after snapshot");
            expect(truncatedExport).not.toContain("failed backup");
            await user.click(
                screen.getByRole("button", {
                    name: "Clear",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("Waiting for logs...")).toBeInTheDocument();
                expect(
                    screen.queryByText("truncated dashboard ready")
                ).not.toBeInTheDocument();
            });
            await user.click(
                screen.getByRole("button", {
                    name: "openclaw.log",
                })
            );
            await user.click(
                screen.getByRole("menuitem", {
                    name: "blank.log",
                })
            );
            await waitFor(() => {
                expect(screen.getByText("Waiting for logs...")).toBeInTheDocument();
                expect(screen.queryByText("dashboard ready")).not.toBeInTheDocument();
                expect(screen.queryByText("live after snapshot")).not.toBeInTheDocument();
            });
        } finally {
            view?.unmount();
            view?.queryClient.clear();
            anchorClick.mockRestore();
            Object.defineProperties(URL, {
                createObjectURL: {
                    configurable: true,
                    value: originalCreateObjectUrl,
                    writable: true,
                },
                revokeObjectURL: {
                    configurable: true,
                    value: originalRevokeObjectUrl,
                    writable: true,
                },
            });
        }
    }, 15_000);
    it("drives chat page session sync, history loading, diagnostics, and send ack", async () => {
        const user = userEvent.setup();
        const view = renderChatPage();
        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;
        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });
        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"sessions.list"'))
            ).toBe(true);
        });
        const sessions = [
            dashboardSessionFixture({
                id: "session-main",
                key: "agent:main:main",
                type: "MAIN",
                agentType: "main",
                displayLabel: "Main chat",
                model: "codex",
                tokenCount: 525,
                maxTokens: 1000,
                thinkingDefault: "low",
                thinkingLevel: "medium",
                thinkingLevels: [
                    {
                        id: "low",
                        label: "low",
                    },
                    {
                        id: "medium",
                        label: "medium",
                    },
                    {
                        id: "high",
                        label: "high",
                    },
                ],
                verboseLevel: "compact",
                updatedAt: Date.parse("2026-06-24T08:00:00.000Z"),
            }),
        ];
        await respondToSocketRequest(socket, "sessions.list", {
            sessions,
        });
        await emitNormalizedSessions(socket, sessions);
        await flushQueuedTimers();
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"chat.history"'))
            ).toHaveLength(1);
        });
        await respondToSocketRequest(socket, "chat.history", {
            messages: [
                {
                    role: "user",
                    content: "Previous question",
                    timestamp: "2026-06-24T08:00:00.000Z",
                },
                {
                    role: "assistant",
                    content: "Previous answer",
                    timestamp: "2026-06-24T08:00:01.000Z",
                },
            ],
        });
        await flushQueuedTimers();
        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"models.list"'))
            ).toBe(true);
        });
        await respondToSocketRequest(socket, "models.list", {
            models: [
                {
                    id: "codex",
                    label: "Codex",
                },
            ],
        });
        await flushQueuedTimers();
        expect(findSocketRequest(socket, "chat.history")?.params).toMatchObject({
            sessionKey: "agent:main:main",
        });
        await waitFor(() => {
            expect(screen.getByText(/Context: 0.5k \/ 1k \(53%\)/)).toBeInTheDocument();
            expect(screen.getByLabelText("Model: codex")).toHaveTextContent("codex");
            expect(screen.queryByText(/MAIN ·/u)).not.toBeInTheDocument();
        });
        await waitFor(() => {
            expect(view.router.state.location.search).toEqual({
                session: "agent:main:main",
            });
        });
        await user.click(screen.getByLabelText("Model and response settings"));
        await user.click(
            screen.getByRole("button", {
                name: "Thinking: medium",
            })
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: "high",
            })
        );
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"sessions.patch"'))
            ).toHaveLength(1);
        });
        expect(
            socket.sent
                .map(
                    (entry) =>
                        JSON.parse(entry) as {
                            method?: string;
                            params?: unknown;
                        }
                )
                .findLast((entry) => entry.method === "sessions.patch")?.params
        ).toEqual({
            key: "agent:main:main",
            thinkingLevel: "high",
        });
        await respondToSocketRequest(socket, "sessions.patch", {});
        await flushQueuedTimers();
        await user.click(
            screen.getByRole("button", {
                name: "Speed: Default",
            })
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: "Fast",
            })
        );
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"sessions.patch"'))
            ).toHaveLength(2);
        });
        expect(
            socket.sent
                .map(
                    (entry) =>
                        JSON.parse(entry) as {
                            method?: string;
                            params?: unknown;
                        }
                )
                .findLast((entry) => entry.method === "sessions.patch")?.params
        ).toEqual({
            fastMode: true,
            key: "agent:main:main",
        });
        await user.type(
            screen.getByPlaceholderText(
                "Message, attach files, or use / commands (try /help)"
            ),
            "Ship it"
        );
        expect(
            screen.getByRole("button", {
                name: "Send",
            })
        ).toBeDisabled();
        await respondToSocketRequest(socket, "sessions.patch", {});
        await flushQueuedTimers();
        await waitFor(() => {
            expect(
                screen.getByRole("button", {
                    name: "Send",
                })
            ).toBeEnabled();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Chat display settings",
            })
        );
        const thinkingToggle = screen.getByRole("button", {
            name: "Show thinking",
        });
        const toolsToggle = screen.getByRole("button", {
            name: "Show tools",
        });
        await user.click(thinkingToggle);
        await user.click(toolsToggle);
        expect(thinkingToggle).toHaveAttribute("aria-pressed", "true");
        expect(toolsToggle).toHaveAttribute("aria-pressed", "true");
        const keepThinkingToggle = screen.getByRole("button", {
            name: "Keep thinking after final answer",
        });
        await user.click(keepThinkingToggle);
        expect(keepThinkingToggle).toHaveAttribute("aria-pressed", "true");
        await user.click(thinkingToggle);
        expect(thinkingToggle).toHaveAttribute("aria-pressed", "false");
        expect(keepThinkingToggle).toHaveAttribute("aria-pressed", "true");
        expect(keepThinkingToggle).toBeDisabled();
        await user.click(thinkingToggle);
        expect(keepThinkingToggle).toHaveAttribute("aria-pressed", "true");
        const toolDetailsToggle = screen.getByRole("button", {
            name: "Expand tool call details",
        });
        expect(toolDetailsToggle).toHaveAttribute("aria-pressed", "false");
        await user.click(toolDetailsToggle);
        expect(toolDetailsToggle).toHaveAttribute("aria-pressed", "true");
        await user.click(
            screen.getByRole("button", {
                name: "Send",
            })
        );
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"sessions.patch"'))
            ).toHaveLength(3);
        });
        await respondToSocketRequest(socket, "sessions.patch", {});
        await flushQueuedTimers();
        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"chat.send"'))
            ).toBe(true);
        });
        const chatSendRequest = socket.sent
            .map(
                (entry) =>
                    JSON.parse(entry) as {
                        method?: string;
                        params?: unknown;
                    }
            )
            .find(
                (entry) =>
                    entry.method === "chat.send" &&
                    (
                        entry.params as
                            | {
                                  message?: string;
                              }
                            | undefined
                    )?.message === "Ship it"
            );
        expect(chatSendRequest?.params).toMatchObject({
            sessionKey: "agent:main:main",
            sessionId: "session-main",
            message: "Ship it",
        });
        expect(
            screen.getByRole("button", {
                name: "Stop",
            })
        ).toBeEnabled();
        await respondToSocketRequest(socket, "chat.send", {
            runId: "run-123",
        });
        await flushQueuedTimers();
        await waitFor(() => {
            expect(
                screen.getByPlaceholderText(
                    "Message, attach files, or use / commands (try /help)"
                )
            ).toHaveValue("");
        });
        const composer = screen.getByPlaceholderText(
            "Message, attach files, or use / commands (try /help)"
        );
        await user.type(composer, "Follow up after stop");
        await user.click(
            screen.getByRole("button", {
                name: "Stop",
            })
        );
        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"chat.abort"'))
            ).toBe(true);
        });
        expect(composer).toHaveValue("Follow up after stop");
        expect(
            screen.getByRole("button", {
                name: "Send",
            })
        ).toBeDisabled();
        await respondToSocketRequest(socket, "chat.abort", {});
        await flushQueuedTimers();
        await waitFor(() => {
            expect(
                screen.getByRole("button", {
                    name: "Send",
                })
            ).toBeEnabled();
        });
        await user.clear(composer);
        const fileInput = view.container.querySelector<HTMLInputElement>(
            'input[type="file"][multiple]'
        );
        expect(fileInput).not.toBeNull();
        fireEvent.change(fileInput!, {
            target: {
                files: [
                    new File(["failed attachment"], "failed.txt", {
                        type: "text/plain",
                    }),
                ],
            },
        });
        await flushQueuedTimers();
        await waitFor(() => {
            expect(screen.getByText("failed.txt")).toBeInTheDocument();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Send",
            })
        );
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"sessions.patch"'))
            ).toHaveLength(4);
        });
        await respondToSocketRequest(socket, "sessions.patch", {});
        await flushQueuedTimers();
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"chat.send"'))
            ).toHaveLength(2);
        });
        await respondToSocketRequest(socket, "chat.send", undefined, false);
        await flushQueuedTimers();
        await waitFor(() => {
            expect(screen.getByText("failed.txt")).toBeInTheDocument();
            expect(screen.getByText("Failed to send message")).toBeInTheDocument();
        });
        await act(async () => {
            socket.emit("error");
            await Promise.resolve();
        });
        await user.click(
            screen.getByRole("button", {
                name: "Dismiss error",
            })
        );
        expect(screen.queryByText("Failed to send message")).not.toBeInTheDocument();
        expect(screen.getByText("WebSocket connection failed")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Dismiss error",
            })
        );
        expect(screen.queryByText("WebSocket connection failed")).not.toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    }, 10_000);
    it("clears chat history loading when the selected session disappears", async () => {
        const view = renderChatPage();
        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;
        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });
        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"sessions.list"'))
            ).toBe(true);
        });
        const sessions = [
            dashboardSessionFixture({
                id: "session-main",
                key: "agent:main:main",
                type: "MAIN",
                agentType: "main",
                displayLabel: "Main chat",
                model: "codex",
                updatedAt: Date.parse("2026-06-24T08:00:00.000Z"),
            }),
        ];
        await respondToSocketRequest(socket, "sessions.list", {
            sessions,
        });
        await emitNormalizedSessions(socket, sessions);
        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"chat.history"'))
            ).toBe(true);
        });
        expect(screen.getByText(/Loading chat/)).toBeInTheDocument();
        await act(async () => {
            socket.emit("message", {
                data: JSON.stringify({
                    type: "state",
                    sessions: [],
                }),
            });
            await Promise.resolve();
        });
        await waitFor(() => {
            expect(screen.queryByText(/Loading chat/)).not.toBeInTheDocument();
        });
        expect(view.router.state.location.search).toEqual({});
        view.unmount();
        view.queryClient.clear();
    });
    it("shows why logs are unavailable in isolated Dashboard dev", async () => {
        const user = userEvent.setup();
        logsApiState.unavailableReason =
            "Host logs are unavailable in isolated Dashboard dev.";
        const view = renderPage(createElement(Logs), {
            withSocket: true,
        });
        await user.click(
            screen.getByRole("button", {
                name: "OpenClaw logs",
            })
        );
        await waitFor(() => {
            expect(
                screen.getByText("Host logs are unavailable in isolated Dashboard dev.")
            ).toBeInTheDocument();
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("preserves a URL-selected chat while reconnecting through an empty session state", async () => {
        const view = renderChatPage("/chat?session=agent%3Amain%3Amain");
        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;
        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });
        await waitFor(() => {
            expect(
                socket.sent.some((entry) => entry.includes('"method":"sessions.list"'))
            ).toBe(true);
            expect(findSocketRequest(socket, "chat.history")).toBeDefined();
        });
        const session = dashboardSessionFixture({
            agentType: "main",
            displayLabel: "Main chat",
            id: "session-main",
            key: "agent:main:main",
            model: "codex",
            type: "MAIN",
            updatedAt: Date.parse("2026-07-19T18:00:00.000Z"),
        });
        await respondToSocketRequest(socket, "chat.history", {
            messages: [],
        });
        await respondToSocketRequest(socket, "sessions.list", {
            sessions: [session],
        });
        await emitNormalizedSessions(socket, [session]);
        await flushQueuedTimers();
        expect(view.router.state.location.search).toEqual({
            session: "agent:main:main",
        });
        expect(
            screen.getByRole("button", {
                name: "Session: main",
            })
        ).toBeInTheDocument();
        await act(async () => {
            socket.emit("message", {
                data: JSON.stringify({
                    gatewayConnected: false,
                    sessions: [],
                    type: "state",
                }),
            });
            await Promise.resolve();
        });
        expect(view.router.state.location.search).toEqual({
            session: "agent:main:main",
        });
        expect(
            screen.getByRole("button", {
                name: "Session: main",
            })
        ).toBeInTheDocument();
        await act(async () => {
            socket.emit("message", {
                data: JSON.stringify({
                    gatewayConnected: true,
                    type: "connected",
                }),
            });
            await Promise.resolve();
        });
        expect(view.router.state.location.search).toEqual({
            session: "agent:main:main",
        });
        await act(async () => {
            socket.emit("message", {
                data: JSON.stringify({
                    sessions: [session],
                    type: "sessions",
                }),
            });
            await Promise.resolve();
        });
        await waitFor(() => {
            expect(
                screen.getByRole("button", {
                    name: "Session: main",
                })
            ).toBeInTheDocument();
        });
        expect(view.router.state.location.search).toEqual({
            session: "agent:main:main",
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("keeps the selected chat when another session becomes active during resync", async () => {
        const selectedSessionKey = "agent:ops:main:heartbeat";
        const activeSessionKey = "agent:main:main";
        const view = renderChatPage(
            `/chat?session=${encodeURIComponent(selectedSessionKey)}`
        );
        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;
        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });
        await waitFor(() => {
            expect(findSocketRequest(socket, "sessions.list")).toBeDefined();
            expect(findSocketRequest(socket, "chat.history")?.params).toMatchObject({
                sessionKey: selectedSessionKey,
            });
        });
        const activeSession = dashboardSessionFixture({
            agentType: "main",
            displayLabel: "Main chat",
            id: "session-main",
            key: activeSessionKey,
            model: "codex",
            type: "MAIN",
            updatedAt: Date.parse("2026-07-19T18:00:00.000Z"),
        });
        const selectedSession = dashboardSessionFixture({
            agentType: "ops",
            displayLabel: "Heartbeat",
            id: "session-heartbeat",
            key: selectedSessionKey,
            model: "synthetic",
            type: "SUBAGENT",
            updatedAt: Date.parse("2026-07-19T17:00:00.000Z"),
        });
        const resyncedSessions = [
            {
                ...activeSession,
                updatedAt: Date.parse("2026-07-19T19:00:00.000Z"),
            },
            selectedSession,
        ];
        await respondToSocketRequest(socket, "chat.history", {
            messages: [],
        });
        await respondToSocketRequest(socket, "sessions.list", {
            sessions: resyncedSessions,
        });
        await emitNormalizedSessions(socket, [activeSession, selectedSession]);
        await waitFor(() => {
            expect(
                screen.getByRole("button", {
                    name: "Session: main:heartbeat",
                })
            ).toBeInTheDocument();
        });
        const sessionListRequestCount = socket.sent.filter((entry) =>
            entry.includes('"method":"sessions.list"')
        ).length;
        act(() => {
            dispatchEvent(new Event("focus"));
        });
        await waitFor(() => {
            expect(
                socket.sent.filter((entry) => entry.includes('"method":"sessions.list"'))
                    .length
            ).toBeGreaterThan(sessionListRequestCount);
        });
        await respondToSocketRequest(socket, "sessions.list", {
            sessions: resyncedSessions,
        });
        await flushQueuedTimers();
        expect(view.router.state.location.search).toEqual({
            session: selectedSessionKey,
        });
        expect(
            screen.getByRole("button", {
                name: "Session: main:heartbeat",
            })
        ).toBeInTheDocument();
        await emitNormalizedSessions(socket, resyncedSessions);
        await flushQueuedTimers();
        expect(view.router.state.location.search).toEqual({
            session: selectedSessionKey,
        });
        const historySessionKeys = socket.sent
            .filter((entry) => entry.includes('"method":"chat.history"'))
            .map((entry) => {
                const request = JSON.parse(entry) as {
                    params?: {
                        sessionKey?: string;
                    };
                };
                return request.params?.sessionKey;
            });
        expect(new Set(historySessionKeys)).toEqual(new Set([selectedSessionKey]));
        expect(historySessionKeys).not.toContain(activeSessionKey);
        await emitNormalizedSessions(socket, [activeSession]);
        await waitFor(() => {
            expect(view.router.state.location.search).toEqual({
                session: activeSessionKey,
            });
            expect(
                screen.getByRole("button", {
                    name: "Session: main",
                })
            ).toBeInTheDocument();
        });
        view.unmount();
        view.queryClient.clear();
    });
    it("restores the selected chat session from the URL and follows URL changes", async () => {
        const user = userEvent.setup();
        const view = renderChatPage("/chat?session=agent%3Aops%3Amain%3Aheartbeat");
        const chatRouter = view.router;
        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;
        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });
        await waitFor(() => {
            expect(findSocketRequest(socket, "chat.history")?.params).toMatchObject({
                sessionKey: "agent:ops:main:heartbeat",
            });
        });
        await respondToSocketRequest(socket, "chat.history", {
            messages: [],
        });
        const sessions = [
            dashboardSessionFixture({
                agentType: "main",
                displayLabel: "Main chat",
                id: "session-main",
                key: "agent:main:main",
                model: "codex",
                type: "MAIN",
                updatedAt: Date.parse("2026-07-19T18:00:00.000Z"),
            }),
            dashboardSessionFixture({
                agentType: "ops",
                displayLabel: "Heartbeat",
                id: "session-heartbeat",
                key: "agent:ops:main:heartbeat",
                model: "synthetic",
                type: "SUBAGENT",
                updatedAt: Date.parse("2026-07-19T17:00:00.000Z"),
            }),
        ];
        await respondToSocketRequest(socket, "sessions.list", {
            sessions,
        });
        await emitNormalizedSessions(socket, sessions);
        await flushQueuedTimers();
        await waitFor(() => {
            expect(
                screen.getByRole("button", {
                    name: "Session: main:heartbeat",
                })
            ).toBeInTheDocument();
        });
        expect(chatRouter.state.location.search).toEqual({
            session: "agent:ops:main:heartbeat",
        });
        const historyRequestsBeforeSelection = socket.sent.filter((entry) =>
            entry.includes('"method":"chat.history"')
        ).length;
        await user.click(
            screen.getByRole("button", {
                name: "Agent: ops",
            })
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: /^main\b/i,
            })
        );
        await waitFor(() => {
            expect(
                screen.getByRole("button", {
                    name: "Session: main",
                })
            ).toBeInTheDocument();
            expect(findSocketRequest(socket, "chat.history")?.params).toMatchObject({
                sessionKey: "agent:main:main",
            });
        });
        await flushQueuedTimers();
        const selectedSessionHistoryRequests = socket.sent
            .filter((entry) => entry.includes('"method":"chat.history"'))
            .slice(historyRequestsBeforeSelection)
            .map((entry) => {
                const request = JSON.parse(entry) as {
                    params?: {
                        sessionKey?: string;
                    };
                };
                return request.params?.sessionKey;
            });
        expect(selectedSessionHistoryRequests).toEqual(["agent:main:main"]);
        view.unmount();
        view.queryClient.clear();
    });
    it("does not enable sending for an unknown URL-selected session", async () => {
        const user = userEvent.setup();
        const view = renderChatPage("/chat?session=agent%3Amissing%3Amain");
        await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        const socket = FakeWebSocket.instances[0]!;
        await act(async () => {
            socket.emit("open");
            await Promise.resolve();
        });
        await respondToSocketRequest(socket, "chat.history", {
            messages: [],
        });
        const sessions = [
            dashboardSessionFixture({
                agentType: "main",
                displayLabel: "Main chat",
                id: "session-main",
                key: "agent:main:main",
                model: "codex",
                type: "MAIN",
                updatedAt: Date.parse("2026-07-19T18:00:00.000Z"),
            }),
        ];
        await respondToSocketRequest(socket, "sessions.list", {
            sessions,
        });
        await emitNormalizedSessions(socket, sessions);
        await flushQueuedTimers();
        expect(view.router.state.location.search).toEqual({
            session: "agent:missing:main",
        });
        const composer = screen.getByPlaceholderText(
            "Message, attach files, or use / commands (try /help)"
        );
        await user.type(composer, "Do not send this");
        expect(
            screen.getByRole("button", {
                name: "Send",
            })
        ).toBeDisabled();
        view.unmount();
        view.queryClient.clear();
    });
    it("renders sessions page connection state with a socket provider", async () => {
        const user = userEvent.setup();
        const view = renderPage(createElement(Sessions), {
            withSocket: true,
        });
        await waitFor(() => {
            expect(screen.getByText("Connecting to OpenClaw...")).toBeInTheDocument();
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        await act(() => {
            return Promise.try(() => {
                FakeWebSocket.instances[0]?.emit("open");
            });
        });
        await act(async () => {
            FakeWebSocket.instances[0]?.respondToLastRequest({
                sessions: [],
            });
            await Promise.resolve();
        });
        await waitFor(() =>
            expect(
                screen.queryByText("Connecting to OpenClaw...")
            ).not.toBeInTheDocument()
        );
        expect(screen.getByText("No sessions found")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "CRON",
            })
        );
        expect(screen.getByText("No CRON sessions found")).toBeInTheDocument();
        await act(() => {
            return Promise.try(() => {
                FakeWebSocket.instances[0]?.close();
            });
        });
        expect(await screen.findByText("Connecting to OpenClaw...")).toBeInTheDocument();
        view.unmount();
        view.queryClient.clear();
    });
});
