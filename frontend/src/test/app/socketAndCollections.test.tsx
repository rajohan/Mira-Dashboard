import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { act, renderHook, waitFor } from "@testing-library/react";

import { withCanonicalOpenClawEvents } from "../../../../contracts/chat/openClawRuntimeAdapter";
import { OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION } from "../../../../contracts/chat/transport";
import {
    readNormalizedSessionsResponsePayload,
    readSessionsResponsePayload,
} from "../../../../contracts/socket";
import { requestUrl } from "../../../../test/support/fetch";
import {
    agentsCollection,
    preloadAgentsCollection,
    writeAgentsFromWebSocket,
} from "../../collections/agents";
import {
    logsCollection,
    preloadLogsCollection,
    trimRetainedLiveLogs,
    writeLogFromWebSocket,
} from "../../collections/logs";
import {
    deleteSessionFromCollection,
    preloadSessionsCollection,
    replaceSessionsFromWebSocket,
    sessionsCollection,
} from "../../collections/sessions";
import { useOpenClawChatTransport } from "../../components/features/chat/transport/useOpenClawChatTransport";
import { useOpenClawSocket } from "../../hooks/useOpenClawSocket";
import {
    notifyAuthSessionRotated,
    UNAUTHORIZED_EVENT_NAME,
    uninstallAuthSessionRotationSync,
} from "../../lib/authBoundary";
import {
    cancelSecurityVerification,
    completeSecurityVerification,
    SecurityVerificationCancelledError,
} from "../../lib/securityVerification";
import {
    createSocketClient,
    socketReconnectDelayMs,
} from "../../lib/socket/socketClient";
import { handleSocketMessage } from "../../lib/socket/socketMessageRouter";
import {
    installUserActivityTracking,
    resetUserActivityForTests,
} from "../../lib/userActivity";
import { authActions, authStore } from "../../stores/authStore";
import { createFrontendBehaviorHarness } from "../support/frontendBehaviorHarness";
describe("Dashboard socket and live collections", () => {
    const {
        FakeWebSocket,
        claimSecurityVerification,
        latestSocketRequest,
        openClawSocketWrapper,
        patchWritableCollection,
    } = createFrontendBehaviorHarness();
    beforeEach(() => {
        authActions.clearSession();
        resetUserActivityForTests();
    });
    afterEach(() => {
        uninstallAuthSessionRotationSync();
        authActions.clearSession();
        resetUserActivityForTests();
    });
    it("routes socket messages into dashboard connection state", () => {
        expect(handleSocketMessage({})).toBeUndefined();
        expect(
            handleSocketMessage({
                type: "state",
                gatewayConnected: false,
            })
        ).toBe(false);
        expect(
            handleSocketMessage({
                type: "state",
            })
        ).toBe(true);
        expect(
            handleSocketMessage({
                type: "connected",
            })
        ).toBe(true);
        expect(
            handleSocketMessage({
                type: "disconnected",
            })
        ).toBe(false);
        expect(
            handleSocketMessage({
                payload: {
                    data: {
                        sessions: [
                            {
                                id: "session-1",
                                key: "session-1",
                            },
                        ],
                    },
                },
                type: "response",
            })
        ).toBeUndefined();
        expect(
            handleSocketMessage({
                event: "agents.list",
                payload: [
                    {
                        id: "mira-2026",
                        status: "online",
                    },
                ],
                type: "event",
            })
        ).toBeUndefined();
        expect(
            handleSocketMessage({
                line: "2026-06-23T10:00:00.000Z info dashboard ready",
                type: "log",
            })
        ).toBeUndefined();
    });
    it("separates raw Gateway session wrappers from normalized browser responses", () => {
        const responsePayloads: unknown[] = [
            [],
            {
                sessions: [],
            },
            {
                result: {
                    sessions: [],
                },
            },
            {
                data: {
                    sessions: [],
                },
            },
        ];
        for (const payload of responsePayloads) {
            expect(readSessionsResponsePayload(payload)).toEqual([]);
        }
        expect(
            readSessionsResponsePayload({
                unrelated: [],
            })
        ).toBeUndefined();
        expect(
            readNormalizedSessionsResponsePayload({
                sessions: [],
            })
        ).toEqual([]);
        for (const payload of [
            [],
            {
                result: {
                    sessions: [],
                },
            },
            {
                data: {
                    sessions: [],
                },
            },
            {
                sessions: [
                    {
                        key: "raw-gateway-session",
                    },
                ],
            },
        ]) {
            expect(readNormalizedSessionsResponsePayload(payload)).toBeUndefined();
        }
        const deletes: string[] = [];
        const restore = patchWritableCollection(
            sessionsCollection,
            [
                [
                    "retained-session",
                    {
                        key: "retained-session",
                    },
                ],
            ],
            {
                writeDelete: (key) => {
                    deletes.push(key);
                },
            }
        );
        try {
            handleSocketMessage({
                payload: [],
                type: "response",
            });
            handleSocketMessage({
                gatewayConnected: false,
                sessions: [],
                type: "sessions",
            });
            expect(deletes).toEqual([]);
        } finally {
            restore();
        }
    });
    it("uses bounded exponential WebSocket reconnect backoff with jitter", () => {
        expect(socketReconnectDelayMs(0, () => 0.5)).toBe(2000);
        expect(socketReconnectDelayMs(1, () => 0.5)).toBe(4000);
        expect(socketReconnectDelayMs(2, () => 0)).toBe(6400);
        expect(socketReconnectDelayMs(2, () => 1)).toBe(9600);
        expect(socketReconnectDelayMs(20, () => 1)).toBe(30_000);
    });
    it("defers WebSocket connect and reconnect while the page is hidden", () => {
        const originalWebSocket = WebSocket;
        const visibilityDescriptor = Object.getOwnPropertyDescriptor(
            document,
            "visibilityState"
        );
        FakeWebSocket.instances = [];
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: FakeWebSocket,
            writable: true,
        });
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
        });
        const timeoutSpy = jest.spyOn(globalThis, "setTimeout");
        const client = createSocketClient({
            url: "ws://dashboard.test/socket",
        });
        try {
            client.connect();
            expect(FakeWebSocket.instances).toHaveLength(0);
            Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "visible",
            });
            client.connect();
            const socket = FakeWebSocket.instances[0]!;
            socket.open();
            Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "hidden",
            });
            const timeoutCount = timeoutSpy.mock.calls.length;
            socket.close();
            expect(timeoutSpy).toHaveBeenCalledTimes(timeoutCount);
        } finally {
            client.disconnect();
            timeoutSpy.mockRestore();
            Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
                writable: true,
            });
            if (visibilityDescriptor) {
                Object.defineProperty(document, "visibilityState", visibilityDescriptor);
            } else {
                delete (
                    document as unknown as {
                        visibilityState?: string;
                    }
                ).visibilityState;
            }
        }
    });
    it("drives socket client request, response, error, and disconnect behavior", async () => {
        const originalWebSocket = WebSocket;
        FakeWebSocket.instances = [];
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: FakeWebSocket,
            writable: true,
        });
        const events: string[] = [];
        try {
            const client = createSocketClient({
                url: "ws://dashboard.test/socket",
                onOpen: () => {
                    events.push("open");
                },
                onClose: () => {
                    events.push("close");
                },
                onError: () => {
                    events.push("error");
                },
                onMessage: () => {
                    events.push("message");
                },
            });
            expect(client.request("before-open")).rejects.toThrow(
                "WebSocket not connected"
            );
            client.connect();
            client.connect();
            const socket = FakeWebSocket.instances[0]!;
            expect(FakeWebSocket.instances).toHaveLength(1);
            expect(socket.url).toBe("ws://dashboard.test/socket");
            socket.open();
            expect(client.isOpen()).toBe(true);
            expect(events).toContain("open");
            const requestPromise = client.request<{
                answer: number;
            }>("answer", {
                question: true,
            });
            expect(JSON.parse(socket.sent[0]!)).toEqual({
                type: "req",
                id: "1",
                method: "answer",
                params: {
                    question: true,
                },
                timeoutMs: 30_000,
                userActivity: false,
            });
            socket.message({
                type: "response",
                id: "1",
                isOk: true,
                payload: {
                    answer: 42,
                },
            });
            expect(requestPromise).resolves.toEqual({
                answer: 42,
            });
            const rejectedPromise = client.request("fail");
            socket.message({
                type: "response",
                id: "2",
                isOk: false,
                error: "nope",
            });
            expect(rejectedPromise).rejects.toBe("nope");
            const verificationEvents: CustomEvent[] = [];
            const verificationHandler = (event: Event) => {
                verificationEvents.push(event as CustomEvent);
            };
            addEventListener("mira:security-verification-required", verificationHandler);
            try {
                const stepUpPromise = client.request("privileged.operation");
                const stepUpRequest = latestSocketRequest(socket);
                socket.message({
                    type: "response",
                    id: stepUpRequest.id,
                    isOk: false,
                    code: "step_up_required",
                    error: "Recent MFA verification is required",
                });
                expect(stepUpPromise).rejects.toBe("Recent MFA verification is required");
                expect(verificationEvents).toHaveLength(1);
                expect(verificationEvents[0]?.detail).toEqual({
                    code: "step_up_required",
                });
            } finally {
                removeEventListener(
                    "mira:security-verification-required",
                    verificationHandler
                );
            }
            const cancelledVerificationHandler = claimSecurityVerification;
            addEventListener(
                "mira:security-verification-required",
                cancelledVerificationHandler
            );
            try {
                const cancelledPromise = client.request("privileged.cancelled");
                const cancelledRequest = latestSocketRequest(socket);
                socket.message({
                    type: "response",
                    id: cancelledRequest.id,
                    isOk: false,
                    code: "step_up_required",
                    error: "Recent MFA verification is required",
                });
                cancelSecurityVerification();
                expect(cancelledPromise).rejects.toBeInstanceOf(
                    SecurityVerificationCancelledError
                );
                expect(latestSocketRequest(socket)).toEqual(cancelledRequest);
            } finally {
                removeEventListener(
                    "mira:security-verification-required",
                    cancelledVerificationHandler
                );
            }
            const resumableVerificationHandler = claimSecurityVerification;
            addEventListener(
                "mira:security-verification-required",
                resumableVerificationHandler
            );
            try {
                const resumablePromise = client.request<{
                    resumed: boolean;
                }>("privileged.resumable");
                const blockedRequest = latestSocketRequest(socket);
                socket.message({
                    type: "response",
                    id: blockedRequest.id,
                    isOk: false,
                    code: "step_up_required",
                    error: "Recent MFA verification is required",
                });
                completeSecurityVerification();
                await waitFor(() =>
                    expect(latestSocketRequest(socket).id).not.toBe(blockedRequest.id)
                );
                const retriedRequest = latestSocketRequest(socket);
                expect(retriedRequest).toMatchObject({
                    method: "privileged.resumable",
                });
                socket.message({
                    type: "response",
                    id: retriedRequest.id,
                    isOk: true,
                    payload: {
                        resumed: true,
                    },
                });
                expect(resumablePromise).resolves.toEqual({
                    resumed: true,
                });
            } finally {
                removeEventListener(
                    "mira:security-verification-required",
                    resumableVerificationHandler
                );
            }
            installUserActivityTracking();
            dispatchEvent(new Event("pointerdown"));
            const activeRequestPromise = client.request<{
                active: boolean;
            }>("active-request");
            const activeRequest = latestSocketRequest(socket) as {
                id: string;
                userActivity?: boolean;
            };
            expect(activeRequest.userActivity).toBe(true);
            socket.message({
                type: "response",
                id: activeRequest.id,
                isOk: true,
                payload: {
                    active: true,
                },
            });
            expect(activeRequestPromise).resolves.toEqual({
                active: true,
            });
            socket.message({
                type: "event",
                event: "agents.list",
                payload: [],
            });
            socket.error();
            expect(events).toContain("message");
            expect(events).toContain("error");
            const pendingPromise = client.request("pending");
            socket.readyState = FakeWebSocket.CLOSED;
            client.connect();
            const replacementSocket = FakeWebSocket.instances[1]!;
            replacementSocket.open();
            const replacementPromise = client.request<{
                current: boolean;
            }>("replacement");
            const replacementRequest = JSON.parse(replacementSocket.sent.at(-1)!) as {
                id: string;
            };
            socket.close();
            socket.error();
            expect(pendingPromise).rejects.toThrow("WebSocket disconnected");
            replacementSocket.message({
                type: "response",
                id: replacementRequest.id,
                isOk: true,
                payload: {
                    current: true,
                },
            });
            expect(replacementPromise).resolves.toEqual({
                current: true,
            });
            expect(events.filter((event) => event === "error")).toHaveLength(1);
            const timeoutPromise = client.request(
                "custom-timeout",
                {},
                {
                    timeoutMs: 20,
                }
            );
            expect(JSON.parse(replacementSocket.sent.at(-1)!)).toMatchObject({
                method: "custom-timeout",
                timeoutMs: 20,
            });
            expect(timeoutPromise).rejects.toThrow("Request timeout");
            const timeoutSpy = jest.spyOn(globalThis, "setTimeout");
            try {
                const invalidTimeoutPromise = client.request<{
                    normalized: boolean;
                }>(
                    "invalid-timeout",
                    {},
                    {
                        timeoutMs: Number.NaN,
                    }
                );
                const invalidTimeoutRequest = latestSocketRequest(replacementSocket);
                expect(invalidTimeoutRequest.timeoutMs).toBe(30_000);
                expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 30_000);
                replacementSocket.message({
                    type: "response",
                    id: invalidTimeoutRequest.id,
                    isOk: true,
                    payload: {
                        normalized: true,
                    },
                });
                expect(invalidTimeoutPromise).resolves.toEqual({
                    normalized: true,
                });
                const clampedTimeoutPromise = client.request<{
                    clamped: boolean;
                }>(
                    "clamped-timeout",
                    {},
                    {
                        timeoutMs: Number.MAX_SAFE_INTEGER,
                    }
                );
                const clampedTimeoutRequest = latestSocketRequest(replacementSocket);
                expect(clampedTimeoutRequest.timeoutMs).toBe(2_147_483_647);
                expect(timeoutSpy).toHaveBeenLastCalledWith(
                    expect.any(Function),
                    2_147_483_647
                );
                replacementSocket.message({
                    type: "response",
                    id: clampedTimeoutRequest.id,
                    isOk: true,
                    payload: {
                        clamped: true,
                    },
                });
                expect(clampedTimeoutPromise).resolves.toEqual({
                    clamped: true,
                });
                const timeoutCallCount = timeoutSpy.mock.calls.length;
                const noDeadlinePromise = client.request<{
                    completed: boolean;
                }>(
                    "no-deadline",
                    {},
                    {
                        shouldWaitIndefinitely: true,
                        timeoutMs: 20,
                    }
                );
                expect(timeoutSpy).toHaveBeenCalledTimes(timeoutCallCount);
                const noDeadlineRequest = JSON.parse(replacementSocket.sent.at(-1)!) as {
                    id: string;
                    shouldWaitIndefinitely?: boolean;
                };
                expect(noDeadlineRequest).not.toHaveProperty("shouldWaitIndefinitely");
                expect(noDeadlineRequest).not.toHaveProperty("timeoutMs");
                replacementSocket.message({
                    type: "response",
                    id: noDeadlineRequest.id,
                    isOk: true,
                    payload: {
                        completed: true,
                    },
                });
                expect(noDeadlinePromise).resolves.toEqual({
                    completed: true,
                });
            } finally {
                timeoutSpy.mockRestore();
            }
            const clearTimeoutSpy = jest.spyOn(globalThis, "clearTimeout");
            try {
                const cyclicParameters: Record<string, unknown> = {};
                cyclicParameters.self = cyclicParameters;
                expect(
                    client.request("cyclic-parameters", cyclicParameters)
                ).rejects.toBeInstanceOf(TypeError);
                expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
                const sendError = new Error("WebSocket send failed");
                const sendSpy = jest
                    .spyOn(replacementSocket, "send")
                    .mockImplementationOnce(() => {
                        throw sendError;
                    });
                try {
                    expect(client.request("send-failure")).rejects.toBe(sendError);
                } finally {
                    sendSpy.mockRestore();
                }
                expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
            } finally {
                clearTimeoutSpy.mockRestore();
            }
            const disconnectedPromise = client.request("disconnect");
            client.disconnect();
            expect(disconnectedPromise).rejects.toThrow("WebSocket disconnected");
            expect(client.isOpen()).toBe(false);
            expect(events.filter((event) => event === "close")).toHaveLength(1);
        } finally {
            Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
                writable: true,
            });
        }
    });
    it("reconnects before retrying a verified request when no socket is open", async () => {
        const originalWebSocket = WebSocket;
        FakeWebSocket.instances = [];
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: FakeWebSocket,
            writable: true,
        });
        const verificationHandler = claimSecurityVerification;
        addEventListener("mira:security-verification-required", verificationHandler);
        const onMessage = jest.fn();
        const client = createSocketClient({
            onMessage,
            url: "ws://dashboard.test/socket",
        });
        try {
            client.connect();
            const originalSocket = FakeWebSocket.instances[0]!;
            originalSocket.open();
            let request: Promise<{
                resumed: boolean;
            }>;
            const timeoutSpy = jest.spyOn(globalThis, "setTimeout");
            try {
                request = client.request<{
                    resumed: boolean;
                }>("privileged.reconnect", undefined, {
                    timeoutMs: 9876,
                });
                expect(
                    timeoutSpy.mock.calls.filter(([, timeout]) => timeout === 9876)
                ).toHaveLength(1);
                const blockedRequest = latestSocketRequest(originalSocket);
                originalSocket.message({
                    type: "response",
                    id: blockedRequest.id,
                    isOk: false,
                    code: "step_up_required",
                    error: "Recent MFA verification is required",
                });
                originalSocket.readyState = FakeWebSocket.CLOSED;
                await act(async () => {
                    completeSecurityVerification();
                    await Promise.resolve();
                });
                expect(FakeWebSocket.instances).toHaveLength(2);
                expect(
                    timeoutSpy.mock.calls.filter(([, timeout]) => timeout === 9876)
                ).toHaveLength(2);
            } finally {
                timeoutSpy.mockRestore();
            }
            const replacementSocket = FakeWebSocket.instances[1]!;
            expect(replacementSocket.sent).toEqual([]);
            replacementSocket.open();
            await waitFor(() => expect(replacementSocket.sent).toHaveLength(1));
            const currentMessageCount = onMessage.mock.calls.length;
            originalSocket.message({
                type: "event",
                event: "stale-after-session-rotation",
            });
            expect(onMessage).toHaveBeenCalledTimes(currentMessageCount);
            const retriedRequest = latestSocketRequest(replacementSocket);
            expect(retriedRequest).toMatchObject({
                method: "privileged.reconnect",
            });
            replacementSocket.message({
                type: "response",
                id: retriedRequest.id,
                isOk: true,
                payload: {
                    resumed: true,
                },
            });
            expect(request).resolves.toEqual({
                resumed: true,
            });
            let indefiniteRequest: Promise<{
                resumed: boolean;
            }>;
            const indefiniteTimeoutSpy = jest.spyOn(globalThis, "setTimeout");
            try {
                const defaultTimeoutCallCount = indefiniteTimeoutSpy.mock.calls.filter(
                    ([, timeout]) => timeout === 30_000
                ).length;
                indefiniteRequest = client.request<{
                    resumed: boolean;
                }>("privileged.indefinite", undefined, {
                    shouldWaitIndefinitely: true,
                });
                const indefiniteBlockedRequest = latestSocketRequest(replacementSocket);
                replacementSocket.message({
                    type: "response",
                    id: indefiniteBlockedRequest.id,
                    isOk: false,
                    code: "step_up_required",
                    error: "Recent MFA verification is required",
                });
                replacementSocket.readyState = FakeWebSocket.CLOSED;
                await act(async () => {
                    completeSecurityVerification();
                    await Promise.resolve();
                });
                expect(FakeWebSocket.instances).toHaveLength(3);
                expect(
                    indefiniteTimeoutSpy.mock.calls.filter(
                        ([, timeout]) => timeout === 30_000
                    )
                ).toHaveLength(defaultTimeoutCallCount);
            } finally {
                indefiniteTimeoutSpy.mockRestore();
            }
            const indefiniteSocket = FakeWebSocket.instances[2]!;
            indefiniteSocket.open();
            await waitFor(() => expect(indefiniteSocket.sent).toHaveLength(1));
            const indefiniteRetry = latestSocketRequest(indefiniteSocket);
            expect(indefiniteRetry).not.toHaveProperty("timeoutMs");
            indefiniteSocket.message({
                type: "response",
                id: indefiniteRetry.id,
                isOk: true,
                payload: {
                    resumed: true,
                },
            });
            expect(indefiniteRequest).resolves.toEqual({
                resumed: true,
            });
        } finally {
            client.disconnect();
            removeEventListener(
                "mira:security-verification-required",
                verificationHandler
            );
            Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
                writable: true,
            });
        }
    });
    it("does not revive a verified request after terminal socket authorization failure", async () => {
        const originalWebSocket = WebSocket;
        const originalFetch = fetch;
        FakeWebSocket.instances = [];
        Object.defineProperties(globalThis, {
            WebSocket: {
                configurable: true,
                value: FakeWebSocket,
                writable: true,
            },
            fetch: {
                configurable: true,
                value: jest.fn(() =>
                    Promise.try(() =>
                        Response.json({
                            authenticated: false,
                            isBootstrapRequired: false,
                            user: undefined,
                        })
                    )
                ),
                writable: true,
            },
        });
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "raymond",
            },
        });
        const verificationHandler = claimSecurityVerification;
        addEventListener("mira:security-verification-required", verificationHandler);
        const client = createSocketClient({
            url: "ws://dashboard.test/socket",
        });
        try {
            client.connect();
            const socket = FakeWebSocket.instances[0]!;
            socket.open();
            const request = client.request("privileged.terminal");
            const blockedRequest = latestSocketRequest(socket);
            socket.message({
                type: "response",
                id: blockedRequest.id,
                isOk: false,
                code: "step_up_required",
                error: "Recent MFA verification is required",
            });
            socket.close(4401);
            await waitFor(() => expect(authStore.state.isAuthenticated).toBe(false));
            completeSecurityVerification();
            expect(request).rejects.toThrow("WebSocket authorization failed");
            expect(FakeWebSocket.instances).toHaveLength(1);
        } finally {
            client.disconnect();
            removeEventListener(
                "mira:security-verification-required",
                verificationHandler
            );
            Object.defineProperties(globalThis, {
                WebSocket: {
                    configurable: true,
                    value: originalWebSocket,
                    writable: true,
                },
                fetch: {
                    configurable: true,
                    value: originalFetch,
                    writable: true,
                },
            });
        }
    });
    it("logs out without reconnecting after a confirmed 4401 WebSocket close", async () => {
        const originalWebSocket = WebSocket;
        const originalFetch = fetch;
        FakeWebSocket.instances = [];
        Object.defineProperties(globalThis, {
            WebSocket: {
                configurable: true,
                value: FakeWebSocket,
                writable: true,
            },
            fetch: {
                configurable: true,
                value: jest.fn(() =>
                    Promise.try(() =>
                        Response.json({
                            authenticated: false,
                            isBootstrapRequired: false,
                            user: undefined,
                        })
                    )
                ),
                writable: true,
            },
        });
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            user: {
                id: 1,
                username: "raymond",
            },
        });
        const unauthorized = Promise.withResolvers<void>();
        const unauthorizedEvents: Event[] = [];
        const unauthorizedHandler = (event: Event) => {
            unauthorizedEvents.push(event);
            unauthorized.resolve();
        };
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        const timeoutSpy = jest.spyOn(globalThis, "setTimeout");
        try {
            const client = createSocketClient({
                url: "ws://dashboard.test/socket",
            });
            client.connect();
            const socket = FakeWebSocket.instances[0]!;
            socket.open();
            socket.close(4401);
            await unauthorized.promise;
            expect(authStore.state.isAuthenticated).toBe(false);
            expect(unauthorizedEvents).toHaveLength(1);
            expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 2000);
            expect(FakeWebSocket.instances).toHaveLength(1);
        } finally {
            timeoutSpy.mockRestore();
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
            Object.defineProperties(globalThis, {
                WebSocket: {
                    configurable: true,
                    value: originalWebSocket,
                    writable: true,
                },
                fetch: {
                    configurable: true,
                    value: originalFetch,
                    writable: true,
                },
            });
        }
    });
    it("reconnects a 4401 WebSocket when the browser has a rotated session", async () => {
        const originalWebSocket = WebSocket;
        const originalFetch = fetch;
        FakeWebSocket.instances = [];
        Object.defineProperties(globalThis, {
            WebSocket: {
                configurable: true,
                value: FakeWebSocket,
                writable: true,
            },
            fetch: {
                configurable: true,
                value: jest.fn((input: RequestInfo | URL) => {
                    return Promise.try(() => {
                        if (requestUrl(input) !== "/api/auth/session") {
                            throw new Error(
                                `Unexpected socket recovery request: ${requestUrl(input)}`
                            );
                        }
                        return Response.json({
                            authenticated: true,
                            isBootstrapRequired: false,
                            session: {
                                authMethod: "webauthn",
                                expiresAt: "2026-08-24T12:00:00.000Z",
                                lastSeenAt: "2026-07-25T04:01:00.000Z",
                                mfaEnabled: true,
                                sessionId: "22222222222222222222222222222222",
                            },
                            user: {
                                id: 1,
                                username: "raymond",
                            },
                        });
                    });
                }),
                writable: true,
            },
        });
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "raymond",
            },
        });
        const unauthorizedHandler = jest.fn();
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        const client = createSocketClient({
            url: "ws://dashboard.test/socket",
        });
        try {
            client.connect();
            const oldSocket = FakeWebSocket.instances[0]!;
            oldSocket.open();
            notifyAuthSessionRotated();
            oldSocket.close(4401);
            await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
            expect(authStore.state.sessionId).toBe("22222222222222222222222222222222");
            expect(unauthorizedHandler).not.toHaveBeenCalled();
            const rotatedSocket = FakeWebSocket.instances[1]!;
            rotatedSocket.open();
            expect(client.isOpen()).toBe(true);
        } finally {
            client.disconnect();
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
            Object.defineProperties(globalThis, {
                WebSocket: {
                    configurable: true,
                    value: originalWebSocket,
                    writable: true,
                },
                fetch: {
                    configurable: true,
                    value: originalFetch,
                    writable: true,
                },
            });
        }
    });
    it("connects the OpenClaw socket provider, publishes messages, and cleans up", async () => {
        installUserActivityTracking();
        const originalWebSocket = WebSocket;
        FakeWebSocket.instances = [];
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: FakeWebSocket,
            writable: true,
        });
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "raymond",
            },
        });
        const receivedMessages: unknown[] = [];
        const lifecycle: string[] = [];
        try {
            const { result, unmount } = renderHook(
                () =>
                    useOpenClawSocket({
                        onConnect: () => {
                            lifecycle.push("connect");
                        },
                        onDisconnect: () => {
                            lifecycle.push("disconnect");
                        },
                    }),
                {
                    wrapper: openClawSocketWrapper,
                }
            );
            await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
            const socket = FakeWebSocket.instances[0]!;
            const unsubscribe = result.current.subscribe((message) => {
                receivedMessages.push(message);
            });
            act(() => {
                socket.open();
            });
            await waitFor(() => expect(result.current.isConnected).toBe(true));
            expect(lifecycle).toContain("connect");
            act(() => {
                socket.message({
                    type: "response",
                    id: "1",
                    isOk: true,
                    payload: {
                        unrelated: [],
                    },
                });
            });
            expect(result.current.hasConfirmedSessionList).toBe(false);
            act(() => {
                socket.message({
                    gatewayConnected: true,
                    sessions: [],
                    type: "state",
                });
            });
            expect(result.current.hasConfirmedSessionList).toBe(false);
            act(() => {
                socket.message({
                    gatewayConnected: false,
                    sessions: [],
                    type: "sessions",
                });
            });
            expect(result.current.hasConfirmedSessionList).toBe(false);
            act(() => {
                socket.message({
                    gatewayConnected: true,
                    type: "connected",
                });
            });
            await waitFor(() =>
                expect(result.current.hasConfirmedSessionList).toBe(false)
            );
            const previousRequestCount = socket.sent.length;
            act(() => {
                dispatchEvent(new Event("focus"));
            });
            await waitFor(() =>
                expect(socket.sent.length).toBe(previousRequestCount + 1)
            );
            const sessionsRequest = JSON.parse(socket.sent.at(-1)!) as {
                id: string;
                method: string;
            };
            expect(sessionsRequest.method).toBe("sessions.list");
            act(() => {
                socket.message({
                    type: "response",
                    id: sessionsRequest.id,
                    isOk: true,
                    payload: {
                        sessions: [],
                    },
                });
            });
            await waitFor(() =>
                expect(result.current.hasConfirmedSessionList).toBe(true)
            );
            act(() => {
                socket.message({
                    gatewayConnected: true,
                    type: "connected",
                });
            });
            await waitFor(() =>
                expect(result.current.hasConfirmedSessionList).toBe(false)
            );
            act(() => {
                socket.message({
                    sessions: [],
                    type: "sessions",
                });
            });
            await waitFor(() =>
                expect(result.current.hasConfirmedSessionList).toBe(true)
            );
            act(() => {
                socket.message({
                    gatewayConnected: true,
                    type: "connected",
                });
            });
            await waitFor(() =>
                expect(result.current.hasConfirmedSessionList).toBe(false)
            );
            const request = result.current.request<{
                pong: true;
            }>("ping", {
                value: 1,
            });
            const pingRequest = JSON.parse(socket.sent.at(-1)!) as {
                id: string;
            };
            expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
                type: "req",
                id: pingRequest.id,
                method: "ping",
                params: {
                    value: 1,
                },
                timeoutMs: 30_000,
                userActivity: true,
            });
            act(() => {
                socket.message({
                    type: "response",
                    id: pingRequest.id,
                    isOk: true,
                    payload: {
                        pong: true,
                    },
                });
            });
            expect(request).resolves.toEqual({
                pong: true,
            });
            act(() => {
                notifyAuthSessionRotated();
            });
            await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
            const rotatedSocket = FakeWebSocket.instances[1]!;
            expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
            act(() => {
                rotatedSocket.open();
            });
            await waitFor(() => expect(result.current.isConnected).toBe(true));
            act(() => {
                authActions.setSession({
                    authenticated: true,
                    isBootstrapRequired: false,
                    user: {
                        id: 1,
                        username: "raymond",
                    },
                });
            });
            await waitFor(() => expect(result.current.isConnected).toBe(true));
            expect(FakeWebSocket.instances).toHaveLength(2);
            expect(rotatedSocket.readyState).toBe(FakeWebSocket.OPEN);
            act(() => {
                authActions.setSession({
                    authenticated: true,
                    isBootstrapRequired: false,
                    session: {
                        authMethod: "webauthn",
                        expiresAt: "2026-08-24T12:00:00.000Z",
                        lastSeenAt: "2026-07-25T04:01:00.000Z",
                        mfaEnabled: true,
                        sessionId: "22222222222222222222222222222222",
                    },
                    user: {
                        id: 1,
                        username: "raymond",
                    },
                });
            });
            await waitFor(() => expect(result.current.isConnected).toBe(true));
            expect(FakeWebSocket.instances).toHaveLength(2);
            expect(rotatedSocket.readyState).toBe(FakeWebSocket.OPEN);
            act(() => {
                authActions.setSession({
                    authenticated: true,
                    isBootstrapRequired: false,
                    session: {
                        authMethod: "webauthn",
                        expiresAt: "2026-08-24T12:00:00.000Z",
                        lastSeenAt: "2026-07-25T04:02:00.000Z",
                        mfaEnabled: true,
                        sessionId: "33333333333333333333333333333333",
                    },
                    user: {
                        id: 2,
                        username: "second-user",
                    },
                });
            });
            await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
            const identitySocket = FakeWebSocket.instances[2]!;
            expect(rotatedSocket.readyState).toBe(FakeWebSocket.CLOSED);
            act(() => {
                identitySocket.open();
            });
            await waitFor(() => expect(result.current.isConnected).toBe(true));
            act(() => {
                identitySocket.message({
                    type: "state",
                    gatewayConnected: false,
                });
            });
            await waitFor(() => expect(result.current.isConnected).toBe(false));
            expect(receivedMessages).toContainEqual({
                type: "state",
                gatewayConnected: false,
            });
            unsubscribe();
            act(() => {
                result.current.disconnect();
            });
            expect(result.current.isConnected).toBe(false);
            unmount();
        } finally {
            authActions.clearSession();
            Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
                writable: true,
            });
        }
    });
    it("uses the socket response contracts for snapshots and compaction", async () => {
        const originalWebSocket = WebSocket;
        FakeWebSocket.instances = [];
        Object.defineProperty(globalThis, "WebSocket", {
            configurable: true,
            value: FakeWebSocket,
            writable: true,
        });
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: {
                id: 1,
                username: "raymond",
            },
        });
        try {
            const { result, unmount } = renderHook(() => useOpenClawChatTransport(), {
                wrapper: openClawSocketWrapper,
            });
            await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
            const socket = FakeWebSocket.instances[0]!;
            act(() => {
                socket.open();
            });
            await waitFor(() => expect(result.current.isConnected).toBe(true));
            await act(async () => {
                socket.message({
                    type: "response",
                    id: "1",
                    isOk: true,
                    payload: [],
                });
                await Promise.resolve();
            });
            const liveBatches: unknown[] = [];
            const unsubscribe = result.current.subscribe((events) => {
                liveBatches.push(events);
            });
            const liveEnvelope = withCanonicalOpenClawEvents({
                event: "session.tool",
                payload: {
                    data: {
                        name: "bash",
                        phase: "result",
                        result: "completed",
                        toolCallId: "call-1",
                    },
                    runId: "run-1",
                    sessionKey: "agent:main:main",
                    stream: "tool",
                },
                runtimeRecordedAt: Date.now(),
                runtimeSequence: 8,
                type: "event",
            });
            act(() => {
                socket.message(liveEnvelope);
            });
            expect(liveBatches).toEqual([
                [
                    expect.objectContaining({
                        kind: "status",
                        sequence: expect.any(Number),
                    }),
                    expect.objectContaining({
                        kind: "tool",
                        sequence: expect.any(Number),
                    }),
                ],
            ]);
            const snapshotPromise = result.current.snapshot("agent:main:main");
            const snapshotRequest = JSON.parse(socket.sent.at(-1)!) as {
                id: string;
            };
            expect(snapshotRequest).toMatchObject({
                method: "chat.runtimeSnapshot",
                params: {
                    sessionKey: "agent:main:main",
                },
            });
            act(() => {
                socket.message({
                    type: "response",
                    id: snapshotRequest.id,
                    isOk: true,
                    payload: {
                        completed: false,
                        events: [],
                        replayScope: "gateway-scope",
                        runtimeGeneration: "backend-generation",
                        schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
                        throughSequence: 7,
                    },
                });
            });
            expect(snapshotPromise).resolves.toEqual({
                completed: false,
                events: [],
                replayScope: "gateway-scope",
                runtimeGeneration: "backend-generation",
                schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
                throughSequence: 127,
            });
            const compactPromise = result.current.compact("agent:main:main");
            const compactRequest = JSON.parse(socket.sent.at(-1)!) as {
                id: string;
            };
            expect(compactRequest).toMatchObject({
                method: "sessions.compact",
                params: {
                    key: "agent:main:main",
                },
            });
            expect(compactRequest).not.toHaveProperty("timeoutMs");
            act(() => {
                socket.message({
                    type: "response",
                    id: compactRequest.id,
                    isOk: true,
                    payload: {},
                });
            });
            expect(compactPromise).resolves.toBeUndefined();
            const rejectedCompactPromise = result.current.compact("agent:main:main");
            const rejectedRequest = JSON.parse(socket.sent.at(-1)!) as {
                id: string;
            };
            act(() => {
                socket.message({
                    type: "response",
                    id: rejectedRequest.id,
                    isOk: false,
                    error: "compaction unavailable",
                });
            });
            expect(rejectedCompactPromise).rejects.toBe("compaction unavailable");
            unsubscribe();
            unmount();
        } finally {
            authActions.clearSession();
            Object.defineProperty(globalThis, "WebSocket", {
                configurable: true,
                value: originalWebSocket,
                writable: true,
            });
        }
    });
    it("writes live agent, log, and session updates into ready collections", () => {
        preloadAgentsCollection();
        preloadLogsCollection();
        preloadSessionsCollection();
        const agentUpserts: Array<Partial<Record<string, unknown>>> = [];
        const restoreAgents = patchWritableCollection(agentsCollection, [], {
            writeUpsert: (item) => {
                agentUpserts.push(item);
            },
        });
        try {
            writeAgentsFromWebSocket([
                {
                    id: "mira-2026",
                    name: "Mira",
                    status: "online",
                },
            ]);
            expect(agentUpserts).toEqual([
                {
                    id: "mira-2026",
                    name: "Mira",
                    status: "online",
                },
            ]);
        } finally {
            restoreAgents();
        }
        const logUpserts: Array<Partial<Record<string, unknown>>> = [];
        const restoreLogs = patchWritableCollection(logsCollection, [], {
            writeUpsert: (item) => {
                logUpserts.push(item);
            },
        });
        try {
            writeLogFromWebSocket(
                '{"_meta":{"logLevelName":"INFO","date":"2026-06-23T08:00:00.000Z"},"0":"[gateway] connected"}',
                "42"
            );
            writeLogFromWebSocket("");
            writeLogFromWebSocket("{bad json");
            handleSocketMessage({
                type: "log_file",
                file: "openclaw.log",
            });
            handleSocketMessage({
                history: true,
                line: "history from socket should be ignored",
                lineId: "100",
                type: "log",
            });
            handleSocketMessage({
                line: "live from socket should be written while history is loading",
                lineId: "101",
                type: "log",
            });
            handleSocketMessage({
                line: '{"component":"server","event":"server.started","level":"info"}',
                type: "dashboard_log",
            });
            handleSocketMessage({
                type: "log_history_complete",
                count: 1,
            });
            expect(logUpserts[0]).toMatchObject({
                level: "info",
                lineId: "42",
                subsystem: "gateway",
                msg: "connected",
            });
            expect(logUpserts[1]).toMatchObject({
                id: expect.stringContaining("{bad json"),
                dedupeKey: "|||{bad json",
                subsystem: "",
                msg: "{bad json",
                raw: "{bad json",
            });
            expect(logUpserts).toHaveLength(4);
            expect(logUpserts[2]).toMatchObject({
                lineId: "101",
                msg: "live from socket should be written while history is loading",
            });
            expect(logUpserts[3]).toMatchObject({
                msg: "server.started",
                subsystem: "server",
            });
        } finally {
            restoreLogs();
        }
        const sessionDeletes: string[] = [];
        const sessionUpserts: Array<Partial<Record<string, unknown>>> = [];
        const restoreSessions = patchWritableCollection(
            sessionsCollection,
            [
                [
                    "old-session",
                    {
                        key: "old-session",
                    },
                ],
                [
                    "fallback-id",
                    {
                        key: "fallback-id",
                    },
                ],
            ],
            {
                writeDelete: (key) => {
                    sessionDeletes.push(key);
                },
                writeUpsert: (item) => {
                    sessionUpserts.push(item);
                },
            }
        );
        try {
            replaceSessionsFromWebSocket([
                {
                    agentType: "",
                    channel: "unknown",
                    displayLabel: "Fallback",
                    displayName: "",
                    hookName: "",
                    id: "fallback-id",
                    key: " ".repeat(3),
                    label: "",
                    maxTokens: 0,
                    model: "Unknown",
                    tokenCount: 0,
                    type: "MAIN",
                },
                {
                    id: "",
                    key: " ".repeat(3),
                    type: "invalid",
                },
            ]);
            expect(sessionDeletes).toEqual(["old-session"]);
            expect(sessionUpserts).toEqual([
                {
                    agentType: "",
                    channel: "unknown",
                    displayLabel: "Fallback",
                    displayName: "",
                    hookName: "",
                    id: "fallback-id",
                    key: " ".repeat(3),
                    label: "",
                    maxTokens: 0,
                    model: "Unknown",
                    tokenCount: 0,
                    type: "MAIN",
                },
            ]);
            deleteSessionFromCollection("fallback-id");
            expect(sessionDeletes).toEqual(["old-session", "fallback-id"]);
        } finally {
            restoreSessions();
        }
    });
    it("bounds the retained live log collection", async () => {
        await logsCollection.preload();
        const existingKeys = Array.from(logsCollection, ([key]) => key);
        logsCollection.utils.writeDelete(existingKeys);
        try {
            for (let index = 0; index < 5; index += 1) {
                writeLogFromWebSocket(`live log ${index}`, String(index));
            }
            trimRetainedLiveLogs(3);
            expect(logsCollection.size).toBe(3);
            expect(Array.from(logsCollection, ([, log]) => log.msg)).not.toContain(
                "live log 0"
            );
            expect(Array.from(logsCollection, ([, log]) => log.msg)).toContain(
                "live log 4"
            );
        } finally {
            logsCollection.utils.writeDelete(Array.from(logsCollection, ([key]) => key));
        }
    });
});
