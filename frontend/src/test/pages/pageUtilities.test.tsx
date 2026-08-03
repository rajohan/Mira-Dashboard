import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { cleanup } from "@testing-library/react";

import { requestUrl } from "../../../../test/support/fetch";
import {
    addDeletedMessageKeys,
    didScheduleBottomFollow,
    isSessionActive,
    nextHistoryLoadSendError,
    nextRefreshedChatMessages,
    readDeletedMessageKeys,
    readStoredChatDiagnosticVisibility,
    sessionTimestampMs,
    shouldStayAtHistoryBottom,
    writeDeletedMessageKeys,
} from "../../components/features/chat/chatPageUtilities";
import { messageFromError } from "../../lib/errorMessage";
import { numberFromDuration, optionalFormValue } from "../../pages/settingsPageUtilities";
import {
    isTerminalOutputAtBottom,
    scrollTerminalOutputToBottom,
    scrollTerminalOutputToBottomAndReport,
} from "../../pages/terminalPageUtilities";
import { authActions } from "../../stores/authStore";
import { createPageBehaviorHarness } from "../support/pageBehaviorHarness";
describe("Dashboard page utilities", () => {
    const {
        FakeWebSocket,
        animationFrameState,
        apiResponse,
        cancelAnimationFrameForTest,
        jobsApiState,
        logsApiState,
        originalGlobals,
        requestAnimationFrameForTest,
        resetLogsCollectionForTest,
        resetSessionsCollectionForTest,
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
    it("keeps chat page storage and history helpers deterministic", () => {
        localStorage.removeItem("mira-dashboard-chat-diagnostic-visibility");
        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
        try {
            Reflect.deleteProperty(globalThis, "window");
            expect(readStoredChatDiagnosticVisibility()).toEqual({
                keepThinkingAfterFinal: false,
                thinking: false,
                toolDetailsExpanded: false,
                tools: false,
            });
        } finally {
            if (originalWindow) {
                Object.defineProperty(globalThis, "window", originalWindow);
            }
        }
        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set());
        expect(
            addDeletedMessageKeys(new Set(["current"]), ["scoped", "history"])
        ).toEqual(new Set(["current", "scoped", "history"]));
        const opaqueKey = "user::no-time::no-run::v2:6:abc123:def456";
        writeDeletedMessageKeys("agent:main:main", new Set([opaqueKey]));
        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set([opaqueKey]));
        localStorage.setItem(
            "openclaw:deleted:agent:main:main",
            JSON.stringify(["user::no-time::no-run::deleted prompt text", opaqueKey])
        );
        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set([opaqueKey]));
        expect(localStorage.getItem("openclaw:deleted:agent:main:main")).toBe(
            JSON.stringify([opaqueKey])
        );
        localStorage.setItem("openclaw:deleted:agent:main:main", "{bad json");
        expect(readDeletedMessageKeys("agent:main:main")).toEqual(new Set());
        expect(localStorage.getItem("openclaw:deleted:agent:main:main")).toBeNull();
        expect(sessionTimestampMs("2026-06-24T08:00:00.000Z")).toBeGreaterThan(0);
        expect(sessionTimestampMs(Number.NaN)).toBeUndefined();
        expect(shouldStayAtHistoryBottom(false, true, false)).toBe(true);
        expect(shouldStayAtHistoryBottom(false, false, false)).toBe(false);
        expect(nextHistoryLoadSendError("old", true, "new")).toBe("old");
        expect(nextHistoryLoadSendError(undefined, false, "new")).toBe("new");
        const unchangedTimestamp = "2026-06-24T08:00:00.000Z";
        expect(
            nextRefreshedChatMessages(
                [
                    {
                        content: "old",
                        role: "assistant",
                        text: "old",
                        timestamp: unchangedTimestamp,
                    },
                ],
                [
                    {
                        content: "new",
                        role: "assistant",
                        text: "new",
                        timestamp: unchangedTimestamp,
                    },
                ]
            )[0]?.text
        ).toBe("new");
        expect(isSessionActive()).toBe(false);
        expect(
            isSessionActive({
                status: "running",
            } as Parameters<typeof isSessionActive>[0])
        ).toBe(true);
        expect(
            isSessionActive({
                activeRunId: "run-1",
            } as Parameters<typeof isSessionActive>[0])
        ).toBe(true);
        expect(
            isSessionActive({
                hasActiveRun: true,
            } as Parameters<typeof isSessionActive>[0])
        ).toBe(true);
        expect(
            isSessionActive({
                currentRunId: "run-2",
            } as Parameters<typeof isSessionActive>[0])
        ).toBe(true);
        expect(
            isSessionActive({
                activeRunId: "stale-run",
                currentRunId: "stale-current-run",
                endedAt: "2026-06-24T08:01:00.000Z",
                status: "running",
            } as Parameters<typeof isSessionActive>[0])
        ).toBe(false);
        const scheduled: string[] = [];
        didScheduleBottomFollow(true, () => {
            scheduled.push("bottom");
        });
        didScheduleBottomFollow(false, () => {
            scheduled.push("skipped");
        });
        expect(scheduled).toEqual(["bottom"]);
    });
    it("preserves stored final-thinking retention while thinking is hidden", () => {
        localStorage.setItem(
            "mira-dashboard-chat-diagnostic-visibility",
            JSON.stringify({
                keepThinkingAfterFinal: true,
                thinking: false,
                toolDetailsExpanded: false,
                tools: true,
            })
        );
        expect(readStoredChatDiagnosticVisibility()).toEqual({
            keepThinkingAfterFinal: true,
            thinking: false,
            toolDetailsExpanded: false,
            tools: true,
        });
    });
    it("keeps settings and terminal page helpers stable", () => {
        expect(numberFromDuration(30, 5)).toBe(30);
        expect(numberFromDuration("2m", 5)).toBe(120);
        expect(numberFromDuration("bad", 5)).toBe(5);
        expect(messageFromError(new Error(" failed "), "fallback")).toBe("failed");
        expect(messageFromError("bad", "fallback")).toBe("bad");
        expect(optionalFormValue("  value  ")).toBe("value");
        expect(optionalFormValue(" ".repeat(3))).toBeUndefined();
        const output = {
            clientHeight: 100,
            scrollHeight: 130,
            scrollTop: 1,
        };
        expect(isTerminalOutputAtBottom(output)).toBe(true);
        expect(scrollTerminalOutputToBottom(output)).toBe(true);
        expect(output.scrollTop).toBe(130);
        expect(scrollTerminalOutputToBottom()).toBe(false);
        const callbacks: string[] = [];
        expect(
            scrollTerminalOutputToBottomAndReport(output, () => {
                callbacks.push("scrolled");
            })
        ).toBe(true);
        expect(callbacks).toEqual(["scrolled"]);
    });
});
