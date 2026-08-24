import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { chatSpeechCapabilitiesPath } from "../../contracts/chatSpeech.ts";
import {
    deriveGatewaySessionStats,
    gatewayPrimarySessionKey,
    type GatewaySession,
    type ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import type { OpenClawTaskSummary } from "../../contracts/openClawTasks.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import type { DashboardRealtimeClient } from "../api/realtimeClient.ts";
import { DashboardRealtimeProvider } from "../api/realtimeContext.tsx";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { gatewaySessionQueryKey } from "../sessions/gatewaySessionQueries.ts";
import { ChatBrowser } from "./ChatBrowser.tsx";
import {
    chatCompanionQueryKey,
    chatHistoryQueryKey,
    chatRuntimeQueryKey,
    openClawTaskDetailQueryKey,
    openClawTaskListSessionQueryKey,
} from "./chatQueries.ts";
import { chatRuntimeStoreContext as ChatRuntimeStoreContext } from "./chatRuntimeContextValue.ts";
import { createChatRuntimeStore } from "./chatRuntimeStore.ts";

const { act, fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;
const observedAtMs = 1_800_000_000_000;
const activeRunId = "019fe633-9133-7ba0-8b80-809dd80dfb39";
const browserFetch = globalThis.fetch;

beforeEach(() => {
    Reflect.set(globalThis, "fetch", (input: RequestInfo | URL): Promise<Response> => {
        let target: string;
        if (typeof input === "string") {
            target = input;
        } else if (input instanceof URL) {
            target = input.pathname;
        } else {
            target = new URL(input.url).pathname;
        }
        if (target !== chatSpeechCapabilitiesPath) {
            return Promise.reject(new Error(`Unexpected browser fetch ${target}`));
        }
        return Promise.resolve(
            Response.json({ speechToText: false, textToSpeech: false })
        );
    });
});

afterEach(() => {
    Reflect.set(globalThis, "fetch", browserFetch);
});

const primarySession: GatewaySession = {
    activeRunIds: [],
    displayName: "Mira main",
    effectiveFastMode: false,
    hasActiveRun: false,
    key: gatewayPrimarySessionKey,
    kind: "main",
    model: "openai/gpt-5.6-sol",
    sessionId: "session-generation-1",
    thinkingLevel: "high",
    totalTokensFresh: false,
    updatedAtMs: observedAtMs,
};

function snapshot(
    freshness: "fresh" | "stale" = "fresh",
    session: GatewaySession = primarySession,
    providerObservedAtMs = observedAtMs
): ListGatewaySessionsResult {
    return {
        filter: "ALL",
        projectionTruncated: false,
        sessions: [session],
        source:
            freshness === "fresh"
                ? {
                      checkedAtMs: providerObservedAtMs,
                      connection: "connected",
                      freshness,
                      observedAtMs: providerObservedAtMs,
                  }
                : {
                      checkedAtMs: providerObservedAtMs + 1000,
                      connection: "disconnected",
                      freshness,
                      observedAtMs: providerObservedAtMs,
                  },
        stats: deriveGatewaySessionStats([session], providerObservedAtMs),
    };
}

function queryOutput(name: string, input: unknown): Promise<unknown> {
    const sessionKey =
        typeof input === "object" && input !== null && "sessionKey" in input
            ? String(input.sessionKey)
            : gatewayPrimarySessionKey;
    switch (name) {
        case "chat.listModels": {
            return Promise.resolve({
                models: [
                    {
                        id: "openai/gpt-5.6-sol",
                        label: "GPT-5.6 Sol",
                        provider: "openai",
                        supportsFastMode: true,
                        thinkingLevels: ["high"],
                    },
                ],
            });
        }
        case "chat.history": {
            return Promise.resolve({
                messages: [],
                providerPagesRead: 1,
                sessionKey,
                truncated: false,
            });
        }
        case "chat.runtime": {
            return Promise.resolve({
                cursor: "0",
                events: [],
                hasMore: false,
                resetRequired: false,
                runs: [],
                sessionKey,
            });
        }
        case "chat.companionState": {
            return Promise.resolve({ exchanges: [] });
        }
        case "openClawTasks.list": {
            return Promise.resolve({ tasks: [] });
        }
        default: {
            return Promise.reject(new Error(`Unexpected query ${name}`));
        }
    }
}

function activeRuntimePage(sessionKey = gatewayPrimarySessionKey, sequence = 1) {
    return {
        cursor: String(sequence),
        events: [],
        hasMore: false,
        resetRequired: true,
        runs: [
            {
                firstSequence: sequence,
                parts: [],
                projectionTruncated: false,
                run: {
                    admittedAtMs: observedAtMs,
                    id: activeRunId,
                    reconciliation: "runtime-authoritative" as const,
                    sessionKey,
                    state: "active" as const,
                    stateVersion: sequence,
                    updatedAtMs: observedAtMs + sequence,
                },
                throughSequence: sequence,
            },
        ],
        sessionKey,
    };
}

function externalRuntimePage(
    sessionKey = gatewayPrimarySessionKey,
    providerRunId = "external-provider-run",
    updatedAtMs = observedAtMs,
    abortBoundary?: Readonly<{
        attemptId: string;
        attemptedAtMs: number;
        baselineObservationEpoch: number;
        baselineUpdatedAtMs: number;
        settlement: "not-aborted" | "pending" | "unknown";
    }>,
    observationEpoch = 1,
    providerObservedAtMs = updatedAtMs
) {
    return {
        cursor: "0",
        events: [],
        externalRuns: [
            {
                ...(abortBoundary === undefined ? {} : { abortBoundary }),
                continuity: "complete" as const,
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                observationEpoch,
                observedAtMs: providerObservedAtMs,
                projectionTruncated: false,
                providerRunId,
                sessionKey,
                source: "provider-runtime" as const,
                text: "Provider-origin response",
                updatedAtMs,
            },
        ],
        externalRunsTruncated: false,
        hasMore: false,
        resetRequired: false,
        runs: [],
        sessionKey,
        transcriptGeneration: 1,
    };
}

function historyUserMessage(id: string, text: string, createdAtMs: number) {
    return {
        content: {
            kind: "complete" as const,
            parts: [{ id: `${id}:text`, kind: "text" as const, text }],
        },
        createdAtMs,
        id,
        role: "user" as const,
        source: "gateway-history" as const,
    };
}

function harness(
    options: Readonly<{
        mirrorSelection?: boolean;
        mutation?: (
            name: string,
            input: unknown,
            options?: Readonly<{ signal?: AbortSignal }>
        ) => Promise<unknown>;
        query?: (
            name: string,
            input: unknown,
            options?: Readonly<{ signal?: AbortSignal }>
        ) => Promise<unknown> | undefined;
        requestedSessionKey?: string;
        sessionSnapshotQuery?: () =>
            | ListGatewaySessionsResult
            | Promise<ListGatewaySessionsResult>;
        sessionSnapshot?: ListGatewaySessionsResult;
        sessionsFailure?: boolean;
    }> = {}
) {
    const queryClient = createDashboardQueryClient();
    const runtimeStore = createChatRuntimeStore();
    if (options.sessionSnapshot !== undefined) {
        queryClient.setQueryData(gatewaySessionQueryKey, options.sessionSnapshot, {
            updatedAt: Date.now(),
        });
    }
    const query = jest.fn(
        (
            name: string,
            input: unknown,
            queryOptions?: Readonly<{ signal?: AbortSignal }>
        ) => {
            const override = options.query?.(name, input, queryOptions);
            if (override !== undefined) return override;
            if (name !== "gatewaySessions.list") return queryOutput(name, input);
            if (options.sessionsFailure) return Promise.reject(new Error("offline"));
            return Promise.resolve(
                options.sessionSnapshotQuery?.() ?? options.sessionSnapshot ?? snapshot()
            );
        }
    );
    const mutation = jest.fn(
        options.mutation ?? (() => Promise.reject(new Error("Unexpected mutation")))
    );
    const client = { mutation, query } as unknown as DashboardTrpcClient;
    const realtimeClient: DashboardRealtimeClient = {
        subscribe: () => ({ unsubscribe() {} }),
    };
    const onSelectedSessionChange = jest.fn();
    function BrowserSelectionHarness() {
        const [selection, setSelection] = useState(options.requestedSessionKey);
        const [handleSelection] = useState(() => (sessionKey: string) => {
            onSelectedSessionChange(sessionKey);
            setSelection(sessionKey);
        });
        return (
            <ChatBrowser
                onSelectedSessionChange={handleSelection}
                requestedSessionKey={selection}
            />
        );
    }
    const browser = options.mirrorSelection ? (
        <BrowserSelectionHarness />
    ) : (
        <ChatBrowser
            onSelectedSessionChange={onSelectedSessionChange}
            requestedSessionKey={options.requestedSessionKey}
        />
    );
    const rendered = render(
        <QueryClientProvider client={queryClient}>
            <DashboardRealtimeProvider client={realtimeClient}>
                <DashboardTrpcProvider client={client}>
                    <ChatRuntimeStoreContext value={runtimeStore}>
                        {browser}
                    </ChatRuntimeStoreContext>
                </DashboardTrpcProvider>
            </DashboardRealtimeProvider>
        </QueryClientProvider>
    );
    return {
        mutation,
        onSelectedSessionChange,
        query,
        queryClient,
        rendered,
        runtimeStore,
    };
}

async function waitForConnectedComposer(): Promise<void> {
    await waitFor(() =>
        expect(screen.getByTestId("chat-workspace")).toHaveAttribute(
            "data-connection",
            "connected"
        )
    );
}

async function revealCompanionControls(): Promise<void> {
    const user = userEvent.setup();
    const activityTrigger = screen.queryByRole("button", {
        name: "Open activity panel",
    });
    if (activityTrigger !== null) await user.click(activityTrigger);
    const companion = await screen.findByRole("button", { name: /Chat companion/iu });
    if (companion.getAttribute("aria-expanded") !== "true") {
        await user.click(companion);
    }
    expect(
        await screen.findByRole("textbox", { name: "Ask about this chat" })
    ).toBeVisible();
}

describe("chat browser", () => {
    test("keeps older history loading single-flight and allows the next top gesture", async () => {
        const firstOlderPage = Promise.withResolvers<unknown>();
        const secondOlderPage = Promise.withResolvers<unknown>();
        const historyCursors: string[] = [];
        const view = harness({
            query: (name, input) => {
                if (name !== "chat.history") return;
                const cursor = String((input as { cursor?: unknown }).cursor);
                historyCursors.push(cursor);
                if (cursor === "0") {
                    return Promise.resolve({
                        messages: [
                            historyUserMessage(
                                "current-message",
                                "Current message",
                                observedAtMs
                            ),
                        ],
                        nextCursor: "100",
                        providerPagesRead: 1,
                        sessionId: "provider-session-a",
                        sessionKey: gatewayPrimarySessionKey,
                        truncated: true,
                    });
                }
                return cursor === "100"
                    ? firstOlderPage.promise
                    : secondOlderPage.promise;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        try {
            const log = await screen.findByRole("log", { name: "Messages" });
            Object.defineProperties(log, {
                clientHeight: { configurable: true, value: 200 },
                scrollHeight: { configurable: true, value: 1000 },
                scrollTop: { configurable: true, value: 100, writable: true },
            });

            fireEvent.scroll(log);
            log.scrollTop = 0;
            fireEvent.scroll(log);
            fireEvent.scroll(log);
            await waitFor(() => expect(historyCursors).toEqual(["0", "100"]));
            expect(log).toHaveAttribute("aria-busy", "true");

            await act(async () => {
                firstOlderPage.resolve({
                    messages: [
                        historyUserMessage(
                            "older-message",
                            "Older message",
                            observedAtMs - 1000
                        ),
                    ],
                    nextCursor: "200",
                    providerPagesRead: 1,
                    sessionId: "provider-session-a",
                    sessionKey: gatewayPrimarySessionKey,
                    truncated: true,
                });
                await firstOlderPage.promise;
            });
            await waitFor(() =>
                expect(
                    view.queryClient.getQueryData<{
                        pages: readonly unknown[];
                    }>(chatHistoryQueryKey(gatewayPrimarySessionKey))?.pages
                ).toHaveLength(2)
            );
            await waitFor(() => expect(log).toHaveAttribute("aria-busy", "false"));

            log.scrollTop = 100;
            fireEvent.scroll(log);
            fireEvent.wheel(log, { deltaY: -100 });
            log.scrollTop = 0;
            fireEvent.scroll(log);
            await waitFor(() => expect(historyCursors).toEqual(["0", "100", "200"]));
            expect(log).toHaveAttribute("aria-busy", "true");
            await act(async () => {
                secondOlderPage.resolve({
                    messages: [],
                    providerPagesRead: 1,
                    sessionId: "provider-session-a",
                    sessionKey: gatewayPrimarySessionKey,
                    truncated: false,
                });
                await secondOlderPage.promise;
            });
            await waitFor(() => expect(log).toHaveAttribute("aria-busy", "false"));
        } finally {
            firstOlderPage.resolve({
                messages: [],
                providerPagesRead: 1,
                sessionId: "provider-session-a",
                sessionKey: gatewayPrimarySessionKey,
                truncated: false,
            });
            secondOlderPage.resolve({
                messages: [],
                providerPagesRead: 1,
                sessionId: "provider-session-a",
                sessionKey: gatewayPrimarySessionKey,
                truncated: false,
            });
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("selects a stable valid default without claiming connected before runtime proof", async () => {
        let resolveRuntime: ((value: unknown) => void) | undefined;
        let runtimeReady = false;
        const runtimePage = {
            cursor: "0",
            events: [],
            hasMore: false,
            resetRequired: false,
            runs: [],
            sessionKey: gatewayPrimarySessionKey,
        };
        const runtime = new Promise<unknown>((resolve) => {
            resolveRuntime = resolve;
        });
        const view = harness({
            mirrorSelection: true,
            query: (name) => {
                if (name !== "chat.runtime") return;
                return runtimeReady ? Promise.resolve(runtimePage) : runtime;
            },
            requestedSessionKey: "missing-session",
            sessionSnapshot: snapshot(),
        });
        try {
            expect(screen.getByTestId("chat-workspace")).toHaveAttribute(
                "data-connection",
                "reconnecting"
            );
            expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
            await waitFor(() =>
                expect(view.onSelectedSessionChange).toHaveBeenCalledWith(
                    gatewayPrimarySessionKey
                )
            );
            await act(async () => {
                runtimeReady = true;
                resolveRuntime?.(runtimePage);
                await runtime;
            });
            await waitForConnectedComposer();
        } finally {
            view.rendered.unmount();
            await view.queryClient.cancelQueries();
            view.queryClient.clear();
        }
    });

    test("retains a valid URL session while a last-known inventory is disconnected", async () => {
        const view = harness({
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot("stale"),
        });
        try {
            expect(screen.getByText(/Showing the latest saved history/iu)).toBeVisible();
            expect(view.onSelectedSessionChange).not.toHaveBeenCalled();
            expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("does not normalize a requested URL from an incomplete stale inventory", async () => {
        const emptyStaleSnapshot = snapshot("stale");
        const view = harness({
            requestedSessionKey: "agent:missing:main",
            sessionSnapshot: {
                ...emptyStaleSnapshot,
                sessions: [],
                stats: deriveGatewaySessionStats([], observedAtMs),
            },
        });
        try {
            expect(
                await screen.findByRole("heading", { name: "No chat sessions" })
            ).toBeVisible();
            expect(view.onSelectedSessionChange).not.toHaveBeenCalled();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("keeps a missing URL session unresolved until one complete fresh snapshot normalizes it", async () => {
        const sessionScopedReadNames = new Set([
            "chat.companionState",
            "chat.history",
            "chat.runtime",
            "openClawTasks.get",
            "openClawTasks.list",
        ]);
        const pendingSessionReads: Array<
            Readonly<{
                input: unknown;
                name: string;
                resolve: (value: unknown) => void;
            }>
        > = [];
        const view = harness({
            query: (name, input) =>
                sessionScopedReadNames.has(name)
                    ? new Promise((resolve) => {
                          pendingSessionReads.push({ input, name, resolve });
                      })
                    : undefined,
            requestedSessionKey: "agent:missing:main",
            sessionSnapshot: {
                ...snapshot(),
                projectionTruncated: true,
            },
        });
        const sessionScopedReads = () =>
            view.query.mock.calls.filter(([name]) =>
                sessionScopedReadNames.has(String(name))
            );
        try {
            expect(
                await screen.findByRole("heading", { name: "No chat sessions" })
            ).toBeVisible();
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            expect(view.onSelectedSessionChange).not.toHaveBeenCalled();
            expect(sessionScopedReads()).toHaveLength(0);
            expect(view.mutation).not.toHaveBeenCalled();
            expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();

            await act(async () => {
                view.queryClient.setQueryData(
                    gatewaySessionQueryKey,
                    snapshot("fresh", primarySession, observedAtMs + 1)
                );
                await Promise.resolve();
            });
            await waitFor(() =>
                expect(view.onSelectedSessionChange).toHaveBeenCalledTimes(1)
            );
            expect(view.onSelectedSessionChange).toHaveBeenCalledWith(
                gatewayPrimarySessionKey
            );
            await waitFor(() =>
                expect(
                    sessionScopedReads().some(([name]) => name === "chat.history")
                ).toBeTrue()
            );
            expect(
                sessionScopedReads().some(([name]) => name === "chat.runtime")
            ).toBeTrue();

            await act(async () => {
                view.queryClient.setQueryData(
                    gatewaySessionQueryKey,
                    snapshot("fresh", primarySession, observedAtMs + 2)
                );
                await Promise.resolve();
            });
            expect(view.onSelectedSessionChange).toHaveBeenCalledTimes(1);

            await act(async () => {
                for (const pending of pendingSessionReads) {
                    pending.resolve(await queryOutput(pending.name, pending.input));
                }
            });
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("keeps an unknown send reconciling and prevents duplicate dispatch", async () => {
        const view = harness({
            mutation: (name) =>
                name === "chat.send"
                    ? Promise.reject(
                          Object.assign(new Error("Unknown send outcome"), {
                              data: { reason: "operation_outcome_unknown" },
                          })
                      )
                    : Promise.reject(new Error("Unexpected mutation")),
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            expect(
                view.query.mock.calls.find((call) => call[0] === "chat.listModels")
            ).toEqual(["chat.listModels", { agentId: "main" }, expect.anything()]);
            const composer = screen.getByRole("textbox", { name: "Message" });
            await user.type(composer, "Send exactly once");
            await user.click(screen.getByRole("button", { name: "Send message" }));
            expect(
                await screen.findByText(
                    /could not confirm whether the message was sent/iu
                )
            ).toBeVisible();
            expect(composer).toHaveValue("");
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.send")
            ).toHaveLength(1);
            expect(
                view.mutation.mock.calls.find((call) => call[0] === "chat.send")?.[1]
            ).not.toHaveProperty("queueMode");
            expect(screen.queryByText(/queued/iu)).toBeNull();
            expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("shows Stop for provider-origin activity and aborts its exact provider run without a local run", async () => {
        let stopped = false;
        const providerRunId = "external-provider-stop";
        const view = harness({
            mutation: (name, input) => {
                if (name !== "chat.abort") {
                    return Promise.reject(new Error("Unexpected mutation"));
                }
                stopped = true;
                return Promise.resolve({
                    aborted: true,
                    abortAttemptId: (input as { abortAttemptId: string }).abortAttemptId,
                    providerRunId,
                });
            },
            query: (name) => {
                if (name !== "chat.runtime") return;
                return Promise.resolve(
                    stopped
                        ? {
                              ...externalRuntimePage(
                                  gatewayPrimarySessionKey,
                                  providerRunId
                              ),
                              externalRuns: [],
                          }
                        : externalRuntimePage(gatewayPrimarySessionKey, providerRunId)
                );
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await user.click(
                await screen.findByRole("button", { name: "Stop response" })
            );
            await waitFor(() =>
                expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull()
            );
            expect(
                view.mutation.mock.calls.find((call) => call[0] === "chat.abort")?.[1]
            ).toEqual({
                abortAttemptId: expect.stringMatching(/^[\da-f]{32}$/u),
                providerRunId,
                sessionKey: gatewayPrimarySessionKey,
            });
            expect(
                view.runtimeStore.state.sessions[gatewayPrimarySessionKey]?.runs
            ).toEqual({});
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("keeps a pending server abort boundary gated after reload even when observations advance", async () => {
        const providerRunId = "external-provider-reload-pending";
        const baselineObservationEpoch = 4;
        const baselineUpdatedAtMs = observedAtMs + 4;
        const attemptedAtMs = observedAtMs + 5;
        let settlement: "not-aborted" | "pending" = "pending";
        const view = harness({
            query: (name) =>
                name === "chat.runtime"
                    ? Promise.resolve(
                          externalRuntimePage(
                              gatewayPrimarySessionKey,
                              providerRunId,
                              baselineUpdatedAtMs + 1,
                              {
                                  attemptId: "server-attempt-pending",
                                  attemptedAtMs,
                                  baselineObservationEpoch,
                                  baselineUpdatedAtMs,
                                  settlement,
                              },
                              baselineObservationEpoch + 1,
                              attemptedAtMs + 1
                          )
                      )
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        try {
            await waitFor(() =>
                expect(
                    view.runtimeStore.state.sessions[gatewayPrimarySessionKey]
                        ?.externalRuns[providerRunId]?.abortBoundary?.settlement
                ).toBe("pending")
            );
            expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();

            settlement = "not-aborted";
            await act(async () => {
                await view.queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(gatewayPrimarySessionKey),
                });
            });
            expect(
                await screen.findByRole("button", { name: "Stop response" })
            ).toBeEnabled();
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.abort")
            ).toHaveLength(0);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("keeps an unknown server abort boundary gated after reload until every observation coordinate advances", async () => {
        const providerRunId = "external-provider-reload-unknown";
        const baselineObservationEpoch = 4;
        const baselineUpdatedAtMs = observedAtMs + 4;
        const attemptedAtMs = observedAtMs + 5;
        let runtimeObservationEpoch = baselineObservationEpoch;
        let runtimeObservedAtMs = attemptedAtMs;
        let runtimeUpdatedAtMs = baselineUpdatedAtMs;
        const abortBoundary = {
            attemptId: "server-attempt-unknown",
            attemptedAtMs,
            baselineObservationEpoch,
            baselineUpdatedAtMs,
            settlement: "unknown" as const,
        };
        const view = harness({
            query: (name) =>
                name === "chat.runtime"
                    ? Promise.resolve(
                          externalRuntimePage(
                              gatewayPrimarySessionKey,
                              providerRunId,
                              runtimeUpdatedAtMs,
                              abortBoundary,
                              runtimeObservationEpoch,
                              runtimeObservedAtMs
                          )
                      )
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const refreshRuntime = async () => {
            await act(async () => {
                await view.queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(gatewayPrimarySessionKey),
                });
            });
        };
        try {
            await waitFor(() =>
                expect(
                    view.runtimeStore.state.sessions[gatewayPrimarySessionKey]
                        ?.externalRuns[providerRunId]?.abortBoundary?.settlement
                ).toBe("unknown")
            );
            expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();

            runtimeObservationEpoch += 1;
            await refreshRuntime();
            expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();

            runtimeObservedAtMs += 1;
            await refreshRuntime();
            expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();

            runtimeUpdatedAtMs += 1;
            await refreshRuntime();
            expect(
                await screen.findByRole("button", { name: "Stop response" })
            ).toBeEnabled();
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.abort")
            ).toHaveLength(0);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("renders a retained provider plan explanation from a truncated runtime projection", async () => {
        const page = externalRuntimePage(
            gatewayPrimarySessionKey,
            "external-provider-plan"
        );
        const externalRun = page.externalRuns[0]!;
        const view = harness({
            query: (name) =>
                name === "chat.runtime"
                    ? Promise.resolve({
                          ...page,
                          externalRuns: [
                              {
                                  ...externalRun,
                                  hasUnprojectedActivity: true,
                                  plan: {
                                      explanation:
                                          "This explanation remains visible during catch-up.",
                                      phase: "update" as const,
                                      steps: [
                                          {
                                              status: "completed" as const,
                                              text: "Read stored snapshot",
                                          },
                                          {
                                              status: "in_progress" as const,
                                              text: "Inspect live state",
                                          },
                                          {
                                              status: "pending" as const,
                                              text: "Reconcile final history",
                                          },
                                      ],
                                  },
                                  projectionTruncated: true,
                              },
                          ],
                      })
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        try {
            expect(
                await screen.findByText(
                    "This explanation remains visible during catch-up."
                )
            ).toBeVisible();
            const completed = screen.getByRole("listitem", {
                name: "Read stored snapshot, completed",
            });
            const current = screen.getByRole("listitem", {
                name: "Inspect live state, in progress",
            });
            const pending = screen.getByRole("listitem", {
                name: "Reconcile final history, pending",
            });
            expect(completed.querySelector(".lucide-circle-check")).not.toBeNull();
            expect(current.querySelector(".lucide-circle-dot")).not.toBeNull();
            expect(pending.querySelector(".lucide-circle")).not.toBeNull();
            expect(current.querySelector("svg")).toHaveClass("text-accent-300");
            expect(pending.querySelector("svg")).toHaveClass("text-primary-400");
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("releases provider-origin Stop when OpenClaw reports that nothing was aborted", async () => {
        const providerRunId = "external-provider-not-aborted";
        const view = harness({
            mutation: (name, input) =>
                name === "chat.abort"
                    ? Promise.resolve({
                          aborted: false,
                          abortAttemptId: (input as { abortAttemptId: string })
                              .abortAttemptId,
                          providerRunId,
                      })
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) =>
                name === "chat.runtime"
                    ? Promise.resolve(
                          externalRuntimePage(gatewayPrimarySessionKey, providerRunId)
                      )
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await user.click(
                await screen.findByRole("button", { name: "Stop response" })
            );
            expect(
                await screen.findByRole("button", { name: "Stop response" })
            ).toBeEnabled();
            expect(await screen.findByText(/did not stop this response/iu)).toBeVisible();
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.abort")
            ).toHaveLength(1);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("keeps an uncertain provider Stop gated past a server-ahead event until its action boundary advances", async () => {
        const providerRunId = "external-provider-unknown-abort";
        const unknownOutcome = Object.assign(new Error("Unknown abort outcome"), {
            data: { reason: "operation_outcome_unknown" },
        });
        let abortAttempts = 0;
        let runtimeUpdatedAtMs = observedAtMs;
        let runtimeObservationEpoch = 1;
        let runtimeObservedAtMs = observedAtMs;
        let serverAbortAttemptId: string | undefined;
        let serverAbortAttemptedAtMs = observedAtMs + 2;
        let serverAbortBaselineEpoch = 2;
        let serverAbortBaselineMs = observedAtMs + 1;
        const view = harness({
            mutation: (name, input) => {
                if (name !== "chat.abort") {
                    return Promise.reject(new Error("Unexpected mutation"));
                }
                abortAttempts += 1;
                const abortAttemptId = (input as { abortAttemptId: string })
                    .abortAttemptId;
                serverAbortAttemptId = abortAttemptId;
                runtimeUpdatedAtMs = Math.max(runtimeUpdatedAtMs, serverAbortBaselineMs);
                runtimeObservationEpoch = Math.max(
                    runtimeObservationEpoch,
                    serverAbortBaselineEpoch
                );
                runtimeObservedAtMs = Math.max(
                    runtimeObservedAtMs,
                    serverAbortBaselineMs
                );
                serverAbortAttemptedAtMs = Math.max(
                    serverAbortAttemptedAtMs,
                    runtimeObservedAtMs + 1
                );
                serverAbortBaselineEpoch = runtimeObservationEpoch;
                serverAbortBaselineMs = runtimeUpdatedAtMs;
                return abortAttempts === 1
                    ? Promise.reject(unknownOutcome)
                    : Promise.resolve({
                          aborted: false,
                          abortAttemptId,
                          providerRunId,
                      });
            },
            query: (name) =>
                name === "chat.runtime"
                    ? Promise.resolve(
                          externalRuntimePage(
                              gatewayPrimarySessionKey,
                              providerRunId,
                              runtimeUpdatedAtMs,
                              serverAbortAttemptId === undefined
                                  ? undefined
                                  : {
                                        attemptId: serverAbortAttemptId,
                                        attemptedAtMs: serverAbortAttemptedAtMs,
                                        baselineObservationEpoch:
                                            serverAbortBaselineEpoch,
                                        baselineUpdatedAtMs: serverAbortBaselineMs,
                                        settlement:
                                            abortAttempts === 1
                                                ? "unknown"
                                                : "not-aborted",
                                    },
                              runtimeObservationEpoch,
                              runtimeObservedAtMs
                          )
                      )
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            const historyReadsBeforeStop = view.query.mock.calls.filter(
                (call) => call[0] === "chat.history"
            ).length;
            await user.click(
                await screen.findByRole("button", { name: "Stop response" })
            );
            expect(
                await screen.findByText(
                    /could not confirm whether the response stopped/iu
                )
            ).toBeVisible();
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.abort")
            ).toHaveLength(1);
            expect(
                view.query.mock.calls.filter((call) => call[0] === "chat.history")
            ).toHaveLength(historyReadsBeforeStop + 1);

            runtimeUpdatedAtMs = serverAbortAttemptedAtMs + 1;
            runtimeObservationEpoch = serverAbortBaselineEpoch + 1;
            runtimeObservedAtMs = serverAbortAttemptedAtMs + 1;
            await act(async () => {
                await view.queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(gatewayPrimarySessionKey),
                });
            });

            await user.click(
                await screen.findByRole("button", { name: "Stop response" })
            );
            expect(await screen.findByText(/did not stop this response/iu)).toBeVisible();
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.abort")
            ).toHaveLength(2);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("does not override provider queue mode while a run is active", async () => {
        const view = harness({
            mutation: (name, input) =>
                name === "chat.send"
                    ? Promise.resolve({
                          admission: "created",
                          run: {
                              id: (input as { clientRunId: string }).clientRunId,
                          },
                      })
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) =>
                name === "chat.runtime"
                    ? Promise.resolve(activeRuntimePage())
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await screen.findByRole("button", { name: "Stop response" });
            await user.type(
                screen.getByRole("textbox", { name: "Message" }),
                "Follow the configured provider behavior"
            );
            await user.click(screen.getByRole("button", { name: "Send message" }));
            await waitFor(() =>
                expect(
                    view.mutation.mock.calls.filter((call) => call[0] === "chat.send")
                ).toHaveLength(1)
            );
            expect(
                view.mutation.mock.calls.find((call) => call[0] === "chat.send")?.[1]
            ).not.toHaveProperty("queueMode");
            expect(screen.queryByText(/queued/iu)).toBeNull();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("does not reopen Stop from a delayed pre-abort runtime read", async () => {
        const unknownOutcome = Object.assign(new Error("Unknown abort outcome"), {
            data: { reason: "operation_outcome_unknown" },
        });
        const preActionRead =
            Promise.withResolvers<ReturnType<typeof activeRuntimePage>>();
        const postActionRead =
            Promise.withResolvers<ReturnType<typeof activeRuntimePage>>();
        let runtimeReads = 0;
        const view = harness({
            mutation: (name) =>
                name === "chat.abort"
                    ? Promise.reject(unknownOutcome)
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) => {
                if (name !== "chat.runtime") return;
                runtimeReads += 1;
                if (runtimeReads === 1) return Promise.resolve(activeRuntimePage());
                return runtimeReads === 2
                    ? preActionRead.promise
                    : postActionRead.promise;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await screen.findByRole("button", { name: "Stop response" });
            void view.queryClient.invalidateQueries({
                exact: true,
                queryKey: chatRuntimeQueryKey(gatewayPrimarySessionKey),
            });
            await waitFor(() => expect(runtimeReads).toBe(2));
            await user.click(screen.getByRole("button", { name: "Stop response" }));
            await waitFor(() => expect(runtimeReads).toBe(3));

            await act(async () => {
                preActionRead.resolve(activeRuntimePage(gatewayPrimarySessionKey, 2));
                await preActionRead.promise;
                await Promise.resolve();
            });
            expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();

            await act(async () => {
                postActionRead.resolve(activeRuntimePage(gatewayPrimarySessionKey, 2));
                await postActionRead.promise;
            });
            expect(
                await screen.findByRole("button", { name: "Stop response" })
            ).toBeEnabled();
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.abort")
            ).toHaveLength(1);
        } finally {
            preActionRead.resolve(activeRuntimePage(gatewayPrimarySessionKey, 2));
            postActionRead.resolve(activeRuntimePage(gatewayPrimarySessionKey, 2));
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("releases Stop after a definitive abort rejection", async () => {
        const view = harness({
            mutation: (name) =>
                name === "chat.abort"
                    ? Promise.reject(new Error("private abort failure"))
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) =>
                name === "chat.runtime"
                    ? Promise.resolve(activeRuntimePage())
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await user.click(
                await screen.findByRole("button", { name: "Stop response" })
            );
            expect(
                await screen.findByText("The request could not be completed. Try again.")
            ).toBeVisible();
            expect(screen.queryByText("private abort failure")).toBeNull();
            expect(screen.getByRole("button", { name: "Stop response" })).toBeEnabled();
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.abort")
            ).toHaveLength(1);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("restores an untouched draft after a definite send failure", async () => {
        const view = harness({
            mutation: (name) =>
                name === "chat.prepareAttachmentTicket"
                    ? Promise.reject(new Error("definite"))
                    : Promise.reject(new Error("Unexpected mutation")),
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            const attachment = new File(["attachment body"], "failure.txt", {
                type: "text/plain",
            });
            const input =
                view.rendered.container.querySelector<HTMLInputElement>(
                    'input[type="file"]'
                );
            expect(input).not.toBeNull();
            fireEvent.change(input as HTMLInputElement, {
                target: { files: [attachment] },
            });
            expect(await screen.findByText("failure.txt")).toBeVisible();
            const composer = screen.getByRole("textbox", { name: "Message" });
            await user.type(composer, "Restore me");
            await user.click(screen.getByRole("button", { name: "Send message" }));
            await waitFor(() => expect(composer).toHaveValue("Restore me"));
            expect(screen.getByText("failure.txt")).toBeVisible();
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "chat.prepareAttachmentTicket"
                )
            ).toHaveLength(1);
            expect(
                view.runtimeStore.state.sessions[gatewayPrimarySessionKey]
                    ?.optimisticSends ?? {}
            ).toEqual({});
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("renders slash-command guidance as a neutral notice instead of an attachment alert", async () => {
        const view = harness({
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            await user.type(screen.getByRole("textbox", { name: "Message" }), "/help");
            await user.click(screen.getByRole("button", { name: "Send message" }));
            const notice = screen.getByText(/Commands: \/compact/iu);
            expect(notice.tagName).toBe("OUTPUT");
            expect(notice).toHaveAttribute("aria-live", "polite");
            expect(screen.queryByRole("alert")).toBeNull();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("handles local slash-command validation without dispatching chat sends", async () => {
        const view = harness({
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        try {
            await waitForConnectedComposer();
            const composer = screen.getByRole("textbox", { name: "Message" });
            const send = screen.getByRole("button", { name: "Send message" });

            fireEvent.change(composer, { target: { value: "/reset" } });
            fireEvent.click(send);
            expect(
                screen.getByText(
                    "Open Chat settings and choose Reset chat history to continue."
                )
            ).toBeVisible();

            fireEvent.change(composer, {
                target: { value: "/model unavailable/model" },
            });
            fireEvent.click(send);
            expect(
                screen.getByText("That model is not available for this session.")
            ).toBeVisible();

            fireEvent.change(composer, { target: { value: "/thinking impossible" } });
            fireEvent.click(send);
            expect(
                screen.getByText("That thinking level is not available for this session.")
            ).toBeVisible();
            expect(view.mutation).not.toHaveBeenCalled();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("dispatches valid model, thinking, and compact slash commands once", async () => {
        let providerObservedAtMs = observedAtMs;
        let currentSession: GatewaySession = {
            ...primarySession,
            thinkingOptions: ["high", "low"],
        };
        const view = harness({
            mutation: (name, input) => {
                if (name === "chat.updateSessionSettings") {
                    const settings = input as {
                        fastMode?: boolean | "auto";
                        model: string | null;
                        thinkingLevel: string | null;
                    };
                    currentSession = {
                        ...currentSession,
                        effectiveFastMode: settings.fastMode,
                        ...(settings.model === null ? {} : { model: settings.model }),
                        ...(settings.thinkingLevel === null
                            ? {}
                            : { thinkingLevel: settings.thinkingLevel }),
                    };
                    return Promise.resolve({
                        fastMode: settings.fastMode,
                        model: settings.model,
                        sessionId: primarySession.sessionId,
                        sessionKey: gatewayPrimarySessionKey,
                        thinkingLevel: settings.thinkingLevel,
                    });
                }
                if (name === "gatewaySessions.compact") {
                    return Promise.resolve({ compacted: true });
                }
                return Promise.reject(new Error("Unexpected mutation"));
            },
            query: (name) =>
                name === "chat.listModels"
                    ? Promise.resolve({
                          models: [
                              {
                                  id: "openai/gpt-5.6-sol",
                                  label: "GPT-5.6 Sol",
                                  provider: "openai",
                                  supportsFastMode: true,
                                  thinkingLevels: ["high", "low"],
                              },
                              {
                                  id: "openai/gpt-4.1",
                                  label: "GPT-4.1",
                                  provider: "openai",
                                  supportsFastMode: false,
                                  thinkingLevels: ["high", "low"],
                              },
                          ],
                      })
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot("fresh", currentSession),
            sessionSnapshotQuery: () => {
                providerObservedAtMs += 1;
                return snapshot("fresh", currentSession, providerObservedAtMs);
            },
        });
        try {
            await waitForConnectedComposer();
            const composer = screen.getByRole("textbox", { name: "Message" });
            const send = screen.getByRole("button", { name: "Send message" });

            fireEvent.change(composer, {
                target: { value: "/model openai/gpt-4.1" },
            });
            fireEvent.click(send);
            await waitFor(() =>
                expect(
                    view.mutation.mock.calls.filter(
                        (call) => call[0] === "chat.updateSessionSettings"
                    )
                ).toHaveLength(1)
            );
            await waitFor(() => expect(composer).toHaveValue(""));

            fireEvent.change(composer, { target: { value: "/thinking low" } });
            fireEvent.click(send);
            await waitFor(() =>
                expect(
                    view.mutation.mock.calls.filter(
                        (call) => call[0] === "chat.updateSessionSettings"
                    )
                ).toHaveLength(2)
            );
            await waitFor(() => expect(composer).toHaveValue(""));

            fireEvent.change(composer, { target: { value: "/compact" } });
            fireEvent.click(send);
            await waitFor(() =>
                expect(
                    view.mutation.mock.calls.filter(
                        (call) => call[0] === "gatewaySessions.compact"
                    )
                ).toHaveLength(1)
            );
            expect(composer).toHaveValue("");
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("validates and removes attachments while toggling display settings", async () => {
        const view = harness({
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            const attachment = new File(["remove me"], "remove-me.txt", {
                type: "text/plain",
            });
            const fileInput =
                view.rendered.container.querySelector<HTMLInputElement>(
                    'input[type="file"]'
                );
            expect(fileInput).not.toBeNull();
            fireEvent.change(fileInput as HTMLInputElement, {
                target: { files: [attachment] },
            });
            expect(await screen.findByText("remove-me.txt")).toBeVisible();
            await user.click(
                screen.getByRole("button", { name: "Remove remove-me.txt" })
            );
            await waitFor(() => expect(screen.queryByText("remove-me.txt")).toBeNull());

            const rejectedVideo = new File(["video"], "blocked.mp4", {
                type: "video/mp4",
            });
            fireEvent.change(fileInput as HTMLInputElement, {
                target: { files: [rejectedVideo] },
            });
            expect(await screen.findByRole("alert")).toHaveTextContent(
                /Video attachments are not supported/iu
            );

            await user.click(screen.getByRole("button", { name: "Chat settings" }));
            const showThinking = screen.getByRole("button", {
                name: /Show thinking/iu,
            });
            const previousPressed = showThinking.getAttribute("aria-pressed");
            await user.click(showThinking);
            expect(showThinking).not.toHaveAttribute("aria-pressed", previousPressed);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("compacts and resets through newer provider observations", async () => {
        let providerObservedAtMs = observedAtMs;
        const view = harness({
            mutation: (name) => {
                if (name === "gatewaySessions.compact") {
                    return Promise.resolve({ compacted: true });
                }
                if (name === "gatewaySessions.reset") {
                    return Promise.resolve({ reset: true });
                }
                return Promise.reject(new Error("Unexpected mutation"));
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
            sessionSnapshotQuery: () => {
                providerObservedAtMs += 1;
                return snapshot("fresh", primarySession, providerObservedAtMs);
            },
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            await user.click(screen.getByRole("button", { name: "Chat settings" }));
            await user.click(screen.getByRole("button", { name: "Compact" }));
            await waitFor(() =>
                expect(
                    view.mutation.mock.calls.filter(
                        (call) => call[0] === "gatewaySessions.compact"
                    )
                ).toHaveLength(1)
            );
            await user.click(screen.getByRole("button", { name: "Chat settings" }));
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Compact" })).toBeEnabled()
            );

            await user.click(screen.getByRole("button", { name: "Reset" }));
            const confirmation = await screen.findByRole("dialog", {
                name: "Reset this chat?",
            });
            await user.click(
                within(confirmation).getByRole("button", {
                    name: "Reset chat history",
                })
            );
            await waitFor(() =>
                expect(
                    view.mutation.mock.calls.filter(
                        (call) => call[0] === "gatewaySessions.reset"
                    )
                ).toHaveLength(1)
            );
            await waitFor(() =>
                expect(
                    screen.getByRole("button", { name: "Chat settings" })
                ).toBeEnabled()
            );
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("releases settings controls after a definitive provider rejection", async () => {
        const view = harness({
            mutation: (name) =>
                name === "chat.updateSessionSettings"
                    ? Promise.reject(new Error("private provider rejection"))
                    : Promise.reject(new Error("Unexpected mutation")),
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            await user.click(screen.getByRole("button", { name: "Chat settings" }));
            await user.click(screen.getByRole("button", { name: /Response speed/iu }));
            await user.click(screen.getByRole("option", { name: "Fast" }));
            await waitFor(() =>
                expect(
                    view.mutation.mock.calls.filter(
                        (call) => call[0] === "chat.updateSessionSettings"
                    )
                ).toHaveLength(1)
            );
            await waitFor(() =>
                expect(
                    screen.getByRole("button", { name: /Response speed/iu })
                ).toBeEnabled()
            );
            expect(screen.queryByText("private provider rejection")).toBeNull();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("uses an initial page state when no session inventory exists", async () => {
        const view = harness({ sessionsFailure: true });
        const user = userEvent.setup();
        try {
            expect(
                await screen.findByRole("heading", { name: "Chat unavailable" })
            ).toBeVisible();
            await user.click(screen.getByRole("button", { name: "Try again" }));
            await waitFor(() =>
                expect(
                    view.query.mock.calls.filter(
                        ([name]) => name === "gatewaySessions.list"
                    )
                ).toHaveLength(2)
            );
            expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("uses normalized settings readback until a newer fresh snapshot wins", async () => {
        let resolveSnapshot: ((value: ListGatewaySessionsResult) => void) | undefined;
        const refreshedSnapshot = new Promise<ListGatewaySessionsResult>((resolve) => {
            resolveSnapshot = resolve;
        });
        const view = harness({
            mutation: (name) =>
                name === "chat.updateSessionSettings"
                    ? Promise.resolve({
                          fastMode: false,
                          model: "openai/gpt-5.6-sol",
                          sessionId: primarySession.sessionId,
                          sessionKey: gatewayPrimarySessionKey,
                          thinkingLevel: "high",
                      })
                    : Promise.reject(new Error("Unexpected mutation")),
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
            sessionSnapshotQuery: () => refreshedSnapshot,
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            await user.click(screen.getByRole("button", { name: "Chat settings" }));
            await user.click(screen.getByRole("button", { name: /Response speed/iu }));
            await user.click(screen.getByRole("option", { name: "Fast" }));
            await waitFor(() =>
                expect(
                    view.mutation.mock.calls.some(
                        (call) =>
                            call[0] === "chat.updateSessionSettings" &&
                            typeof call[1] === "object" &&
                            call[1] !== null &&
                            "fastMode" in call[1] &&
                            call[1].fastMode === true
                    )
                ).toBe(true)
            );
            await waitFor(() =>
                expect(
                    view.query.mock.calls.filter(
                        (call) => call[0] === "gatewaySessions.list"
                    )
                ).toHaveLength(1)
            );
            await waitFor(() =>
                expect(
                    screen.getByRole("button", { name: /Response speed/iu })
                ).toHaveTextContent("Standard")
            );

            await act(async () => {
                resolveSnapshot?.(
                    snapshot(
                        "fresh",
                        { ...primarySession, effectiveFastMode: true },
                        observedAtMs + 1
                    )
                );
                await refreshedSnapshot;
            });
            await waitFor(() =>
                expect(
                    screen.getByRole("button", { name: /Response speed/iu })
                ).toHaveTextContent("Fast")
            );
            await waitFor(() =>
                expect(
                    screen.getByRole("button", { name: /Response speed/iu })
                ).toBeEnabled()
            );
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("does not settle settings from a delayed pre-action inventory read", async () => {
        const preActionRead = Promise.withResolvers<ListGatewaySessionsResult>();
        const postActionRead = Promise.withResolvers<ListGatewaySessionsResult>();
        let inventoryReads = 0;
        const unknownOutcome = Object.assign(new Error("Unknown settings outcome"), {
            data: { reason: "operation_outcome_unknown" },
        });
        const view = harness({
            mutation: (name) =>
                name === "chat.updateSessionSettings"
                    ? Promise.reject(unknownOutcome)
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) => {
                if (name !== "gatewaySessions.list") return;
                inventoryReads += 1;
                return inventoryReads === 1
                    ? preActionRead.promise
                    : postActionRead.promise;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            void view.queryClient.invalidateQueries({
                exact: true,
                queryKey: gatewaySessionQueryKey,
            });
            await waitFor(() => expect(inventoryReads).toBe(1));
            await user.click(screen.getByRole("button", { name: "Chat settings" }));
            await user.click(screen.getByRole("button", { name: /Response speed/iu }));
            await user.click(screen.getByRole("option", { name: "Fast" }));
            await waitFor(() => expect(inventoryReads).toBe(2));

            await act(async () => {
                preActionRead.resolve(
                    snapshot(
                        "fresh",
                        { ...primarySession, effectiveFastMode: true },
                        observedAtMs + 100
                    )
                );
                await preActionRead.promise;
                await Promise.resolve();
            });
            expect(
                screen.getByRole("button", { name: /Response speed/iu })
            ).toBeDisabled();

            await act(async () => {
                postActionRead.resolve(
                    snapshot(
                        "fresh",
                        { ...primarySession, effectiveFastMode: true },
                        observedAtMs + 1
                    )
                );
                await postActionRead.promise;
            });
            await waitFor(() =>
                expect(
                    screen.getByRole("button", { name: /Response speed/iu })
                ).toBeEnabled()
            );
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "chat.updateSessionSettings"
                )
            ).toHaveLength(1);
        } finally {
            preActionRead.resolve(snapshot());
            postActionRead.resolve(snapshot("fresh", primarySession, observedAtMs + 1));
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("hydrates only an explicitly opened task and lets the selected row close it", async () => {
        const task: OpenClawTaskSummary = {
            id: "task-default-detail",
            progressSummary: "Summary",
            status: "running",
            title: "Default task detail",
            updatedAtMs: observedAtMs,
        };
        const view = harness({
            query: (name, input) => {
                if (name === "openClawTasks.list") {
                    const statuses =
                        typeof input === "object" &&
                        input !== null &&
                        "statuses" in input &&
                        Array.isArray(input.statuses)
                            ? input.statuses
                            : [];
                    return Promise.resolve({
                        tasks: statuses.includes("running") ? [task] : [],
                    });
                }
                if (name === "openClawTasks.get") {
                    return Promise.resolve({
                        task: {
                            ...task,
                            progressSummary: "Hydrated exact detail",
                        },
                    });
                }
                return;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await screen.findByRole("button", {
                name: "Default task detail Running",
            });
            const taskButton = () =>
                screen.getByRole("button", {
                    name: "Default task detail Running",
                });
            expect(taskButton()).toHaveAttribute("aria-expanded", "false");
            expect(
                view.query.mock.calls.filter((call) => call[0] === "openClawTasks.get")
            ).toHaveLength(0);

            await user.click(taskButton());
            const hydratedDetails = await screen.findAllByText("Hydrated exact detail");
            expect(hydratedDetails.length).toBeGreaterThanOrEqual(1);
            expect(taskButton()).toHaveAttribute("aria-expanded", "true");
            expect(
                view.query.mock.calls.filter((call) => call[0] === "openClawTasks.get")
            ).toHaveLength(1);
            expect(
                view.query.mock.calls.find((call) => call[0] === "openClawTasks.get")?.[1]
            ).toEqual({ taskId: task.id });

            await user.click(taskButton());
            await waitFor(() =>
                expect(
                    screen.queryByRole("region", {
                        name: "Task detail: Default task detail",
                    })
                ).toBeNull()
            );
            expect(taskButton()).toHaveFocus();
            expect(
                view.query.mock.calls.filter((call) => call[0] === "openClawTasks.get")
            ).toHaveLength(1);

            await user.click(taskButton());
            await screen.findByRole("region", {
                name: "Task detail: Default task detail",
            });
            await user.click(taskButton());
            await waitFor(() =>
                expect(
                    screen.queryByRole("region", {
                        name: "Task detail: Default task detail",
                    })
                ).toBeNull()
            );
            expect(taskButton()).toHaveAttribute("aria-expanded", "false");
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("retains selected authoritative task detail through a transient list omission", async () => {
        const task: OpenClawTaskSummary = {
            id: "task-transient-list-gap",
            progressSummary: "Review in progress",
            status: "running",
            title: "Stable active task",
            updatedAtMs: observedAtMs,
        };
        let listed = true;
        let detailUnavailable = false;
        const view = harness({
            query: (name, input) => {
                if (name === "openClawTasks.list") {
                    const statuses =
                        typeof input === "object" &&
                        input !== null &&
                        "statuses" in input &&
                        Array.isArray(input.statuses)
                            ? input.statuses
                            : [];
                    return Promise.resolve({
                        tasks: listed && statuses.includes("running") ? [task] : [],
                    });
                }
                if (name === "openClawTasks.get") {
                    if (detailUnavailable) {
                        return Promise.reject(
                            Object.assign(new Error("temporarily unavailable"), {
                                data: { code: "SERVICE_UNAVAILABLE" },
                            })
                        );
                    }
                    return Promise.resolve({
                        task: {
                            ...task,
                            progressSummary: "Authoritative live progress",
                            prompt: "Keep this task explanation visible.",
                        },
                    });
                }
                return;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await user.click(
                await screen.findByRole("button", {
                    name: "Stable active task Running",
                })
            );
            expect(
                await screen.findByText(/Keep this task explanation visible\./u)
            ).toBeVisible();
            listed = false;
            detailUnavailable = true;

            await act(async () => {
                await Promise.all([
                    view.queryClient.invalidateQueries({
                        queryKey: openClawTaskListSessionQueryKey(
                            gatewayPrimarySessionKey
                        ),
                    }),
                    view.queryClient.invalidateQueries({
                        exact: true,
                        queryKey: openClawTaskDetailQueryKey(task.id),
                    }),
                ]);
            });

            expect(
                screen.getByRole("button", { name: "Stable active task Running" })
            ).toHaveAttribute("aria-expanded", "true");
            expect(
                screen.getAllByText(/Authoritative live progress/u).length
            ).toBeGreaterThanOrEqual(1);
            expect(
                screen.getByText(/Keep this task explanation visible\./u)
            ).toBeVisible();
            expect(
                view.query.mock.calls.filter((call) => call[0] === "openClawTasks.get")
            ).toHaveLength(2);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("removes cached selected task detail after an authoritative not-found read", async () => {
        const task: OpenClawTaskSummary = {
            id: "task-authoritatively-deleted",
            status: "running",
            title: "Deleted active task",
            updatedAtMs: observedAtMs,
        };
        let deleted = false;
        const view = harness({
            query: (name, input) => {
                if (name === "openClawTasks.list") {
                    const statuses =
                        typeof input === "object" &&
                        input !== null &&
                        "statuses" in input &&
                        Array.isArray(input.statuses)
                            ? input.statuses
                            : [];
                    return Promise.resolve({
                        tasks: !deleted && statuses.includes("running") ? [task] : [],
                    });
                }
                if (name === "openClawTasks.get") {
                    return deleted
                        ? Promise.reject(
                              Object.assign(new Error("task deleted"), {
                                  data: { code: "NOT_FOUND" },
                              })
                          )
                        : Promise.resolve({
                              task: {
                                  ...task,
                                  prompt: "This prompt must not remain after deletion.",
                              },
                          });
                }
                return;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await user.click(
                await screen.findByRole("button", {
                    name: "Deleted active task Running",
                })
            );
            expect(
                await screen.findByText(/must not remain after deletion/iu)
            ).toBeVisible();
            deleted = true;

            await act(async () => {
                await Promise.allSettled([
                    view.queryClient.invalidateQueries({
                        queryKey: openClawTaskListSessionQueryKey(
                            gatewayPrimarySessionKey
                        ),
                    }),
                    view.queryClient.invalidateQueries({
                        exact: true,
                        queryKey: openClawTaskDetailQueryKey(task.id),
                    }),
                ]);
            });

            await waitFor(() =>
                expect(screen.queryByText("Deleted active task")).toBeNull()
            );
            expect(screen.queryByText(/must not remain after deletion/iu)).toBeNull();
            expect(
                view.queryClient.getQueryData(openClawTaskDetailQueryKey(task.id))
            ).toBeUndefined();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("loads each unfinished task ledger once near the virtual task-list end", async () => {
        const view = harness({
            query: (name, input) => {
                if (name !== "openClawTasks.list") return;
                const record =
                    typeof input === "object" && input !== null
                        ? (input as Readonly<Record<string, unknown>>)
                        : {};
                const statuses = Array.isArray(record.statuses) ? record.statuses : [];
                const active = statuses.includes("running");
                const cursor =
                    typeof record.cursor === "string" ? record.cursor : undefined;
                if (cursor === undefined) {
                    return Promise.resolve({
                        nextCursor: "1",
                        tasks: [
                            {
                                id: active ? "task-active-1" : "task-finished-1",
                                status: active ? "running" : "completed",
                                title: active ? "Active task" : "Finished task",
                            },
                        ],
                    });
                }
                return Promise.resolve(
                    active
                        ? { nextCursor: cursor, tasks: [] }
                        : {
                              tasks: [
                                  {
                                      id: "task-finished-2",
                                      status: "failed",
                                      title: "Older finished task",
                                  },
                              ],
                          }
                );
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const taskListReads = () =>
            view.query.mock.calls.filter((call) => call[0] === "openClawTasks.list");
        try {
            const taskList = await screen.findByRole("list", {
                name: "Background tasks",
            });
            const taskScroller = taskList.parentElement!;
            expect(taskListReads()).toHaveLength(2);
            Object.defineProperties(taskScroller, {
                clientHeight: { configurable: true, value: 400 },
                scrollHeight: { configurable: true, value: 1000 },
                scrollTop: { configurable: true, value: 400, writable: true },
            });
            taskScroller.scrollTop = 441;
            fireEvent.scroll(taskScroller);

            expect(await screen.findByText("Older finished task")).toBeVisible();
            expect(taskListReads()).toHaveLength(4);
            expect(
                taskListReads().filter((call) => {
                    const input = call[1];
                    return (
                        typeof input === "object" && input !== null && "cursor" in input
                    );
                })
            ).toHaveLength(2);

            await Promise.resolve();
            expect(taskListReads()).toHaveLength(4);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("waits for the finished task ledger before declaring the session empty", async () => {
        const finished = Promise.withResolvers<{
            tasks: readonly OpenClawTaskSummary[];
        }>();
        const view = harness({
            query: (name, input) => {
                if (name !== "openClawTasks.list") return;
                const statuses =
                    typeof input === "object" &&
                    input !== null &&
                    Array.isArray((input as Readonly<Record<string, unknown>>).statuses)
                        ? ((input as Readonly<Record<string, unknown>>)
                              .statuses as readonly unknown[])
                        : [];
                return statuses.includes("running")
                    ? Promise.resolve({ tasks: [] })
                    : finished.promise;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        try {
            expect(
                await screen.findByLabelText("Loading background tasks…")
            ).toBeVisible();
            expect(
                screen.queryByText("No background tasks for this session.")
            ).toBeNull();

            finished.resolve({
                tasks: [
                    {
                        id: "finished-after-active-ledger",
                        status: "completed",
                        title: "Finished after active ledger",
                    },
                ],
            });
            expect(await screen.findByText("Finished after active ledger")).toBeVisible();
            expect(
                screen.queryByText("No background tasks for this session.")
            ).toBeNull();
        } finally {
            finished.resolve({ tasks: [] });
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("deduplicates unknown task cancellation until a newer terminal task arrives", async () => {
        let task: OpenClawTaskSummary = {
            id: "task-1",
            status: "running" as const,
            title: "Background review",
            updatedAtMs: observedAtMs,
        };
        const unknownOutcome = Object.assign(new Error("Unknown cancel outcome"), {
            data: { reason: "operation_outcome_unknown" },
        });
        const view = harness({
            mutation: (name) =>
                name === "openClawTasks.cancel"
                    ? Promise.reject(unknownOutcome)
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) =>
                name === "openClawTasks.list"
                    ? Promise.resolve({ tasks: [task] })
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await screen.findAllByText("Background review");
            await user.click(
                screen.getByRole("button", { name: "Background review Running" })
            );
            await user.dblClick(screen.getByRole("button", { name: "Cancel task" }));
            expect(
                await screen.findByText(/newer task observation is required/iu)
            ).toBeVisible();
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "openClawTasks.cancel"
                )
            ).toHaveLength(1);
            expect(screen.getByRole("button", { name: "Stopping task…" })).toBeDisabled();

            task = {
                ...task,
                status: "completed",
                updatedAtMs: observedAtMs + 1,
            };
            await view.queryClient.invalidateQueries({
                queryKey: ["openclaw-tasks", "list", gatewayPrimarySessionKey],
            });
            await waitFor(() =>
                expect(screen.queryByRole("button", { name: "Cancel task" })).toBeNull()
            );
            expect(screen.getByText("Completed")).toBeVisible();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("does not settle task cancellation from delayed pre-action task reads", async () => {
        const task: OpenClawTaskSummary = {
            id: "task-delayed-read",
            status: "running",
            title: "Delayed task reconciliation",
            updatedAtMs: observedAtMs,
        };
        const preActiveRead = Promise.withResolvers<{ tasks: OpenClawTaskSummary[] }>();
        const postActiveRead = Promise.withResolvers<{ tasks: OpenClawTaskSummary[] }>();
        const preDetailRead = Promise.withResolvers<{ task: OpenClawTaskSummary }>();
        const postDetailRead = Promise.withResolvers<{ task: OpenClawTaskSummary }>();
        const unknownOutcome = Object.assign(new Error("Unknown cancel outcome"), {
            data: { reason: "operation_outcome_unknown" },
        });
        let activeReads = 0;
        let detailReads = 0;
        const view = harness({
            mutation: (name) =>
                name === "openClawTasks.cancel"
                    ? Promise.reject(unknownOutcome)
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name, input) => {
                if (name === "openClawTasks.list") {
                    const statuses =
                        typeof input === "object" &&
                        input !== null &&
                        "statuses" in input &&
                        Array.isArray(input.statuses)
                            ? input.statuses
                            : [];
                    if (!statuses.includes("running")) {
                        return Promise.resolve({ tasks: [] });
                    }
                    activeReads += 1;
                    if (activeReads === 1) return Promise.resolve({ tasks: [task] });
                    return activeReads === 2
                        ? preActiveRead.promise
                        : postActiveRead.promise;
                }
                if (name === "openClawTasks.get") {
                    detailReads += 1;
                    if (detailReads === 1) return Promise.resolve({ task });
                    return detailReads === 2
                        ? preDetailRead.promise
                        : postDetailRead.promise;
                }
                return;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        const preTask = { ...task, updatedAtMs: observedAtMs + 1 };
        const postTask = { ...task, updatedAtMs: observedAtMs + 2 };
        try {
            await screen.findAllByText("Delayed task reconciliation");
            await user.click(
                screen.getByRole("button", {
                    name: "Delayed task reconciliation Running",
                })
            );
            await waitFor(() => expect(detailReads).toBe(1));
            void Promise.all([
                view.queryClient.invalidateQueries({
                    queryKey: openClawTaskListSessionQueryKey(gatewayPrimarySessionKey),
                }),
                view.queryClient.invalidateQueries({
                    exact: true,
                    queryKey: openClawTaskDetailQueryKey(task.id),
                }),
            ]);
            await waitFor(() => {
                expect(activeReads).toBe(2);
                expect(detailReads).toBe(2);
            });
            await user.click(screen.getByRole("button", { name: "Cancel task" }));
            await waitFor(() => {
                expect(activeReads).toBe(3);
                expect(detailReads).toBe(3);
            });

            await act(async () => {
                preActiveRead.resolve({ tasks: [preTask] });
                preDetailRead.resolve({ task: preTask });
                await Promise.all([preActiveRead.promise, preDetailRead.promise]);
                await Promise.resolve();
            });
            expect(screen.getByRole("button", { name: "Stopping task…" })).toBeDisabled();

            await act(async () => {
                postActiveRead.resolve({ tasks: [postTask] });
                postDetailRead.resolve({ task: postTask });
                await Promise.all([postActiveRead.promise, postDetailRead.promise]);
            });
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Cancel task" })).toBeEnabled()
            );
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "openClawTasks.cancel"
                )
            ).toHaveLength(1);
        } finally {
            preActiveRead.resolve({ tasks: [preTask] });
            postActiveRead.resolve({ tasks: [postTask] });
            preDetailRead.resolve({ task: preTask });
            postDetailRead.resolve({ task: postTask });
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("settles a definitive absent-task cancellation without retaining its lock", async () => {
        const task: OpenClawTaskSummary = {
            id: "task-missing",
            status: "running",
            title: "Vanishing task",
            updatedAtMs: observedAtMs,
        };
        const view = harness({
            mutation: (name) =>
                name === "openClawTasks.cancel"
                    ? Promise.resolve({ cancelled: false, found: false })
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) =>
                name === "openClawTasks.list"
                    ? Promise.resolve({ tasks: [task] })
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await screen.findAllByText("Vanishing task");
            await user.click(
                screen.getByRole("button", { name: "Vanishing task Running" })
            );
            await user.click(screen.getByRole("button", { name: "Cancel task" }));
            await waitFor(() => expect(screen.queryByText("Vanishing task")).toBeNull());
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "openClawTasks.cancel"
                )
            ).toHaveLength(1);
            expect(screen.queryByText("Reconciling task…")).toBeNull();
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("uses an exact task read when an unknown cancel removes the default list row", async () => {
        let listReads = 0;
        let detailReads = 0;
        const task: OpenClawTaskSummary = {
            id: "task-exact",
            status: "running",
            title: "Exact reconciliation",
            updatedAtMs: observedAtMs,
        };
        const unknownOutcome = Object.assign(new Error("Unknown cancel outcome"), {
            data: { reason: "operation_outcome_unknown" },
        });
        const view = harness({
            mutation: (name) =>
                name === "openClawTasks.cancel"
                    ? Promise.reject(unknownOutcome)
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name, input) => {
                if (name === "openClawTasks.list") {
                    listReads += 1;
                    return Promise.resolve({ tasks: listReads === 1 ? [task] : [] });
                }
                if (name === "openClawTasks.get") {
                    detailReads += 1;
                    if (detailReads === 1) return Promise.resolve({ task });
                    return Promise.reject(
                        Object.assign(new Error("not found"), {
                            data: { code: "NOT_FOUND" },
                        })
                    );
                }
                return queryOutput(name, input);
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await screen.findAllByText("Exact reconciliation");
            await user.click(
                screen.getByRole("button", { name: "Exact reconciliation Running" })
            );
            await user.click(screen.getByRole("button", { name: "Cancel task" }));
            await waitFor(() =>
                expect(screen.queryByText("Exact reconciliation")).toBeNull()
            );
            expect(
                view.query.mock.calls.some((call) => call[0] === "openClawTasks.get")
            ).toBe(true);
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "openClawTasks.cancel"
                )
            ).toHaveLength(1);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("uses reset as a single-flight escape hatch that supersedes ask", async () => {
        const pendingAsk = Promise.withResolvers<{
            answer: string;
            timestampMs: number;
        }>();
        const pendingReset = Promise.withResolvers<{ reset: true }>();
        let askSignal: AbortSignal | undefined;
        const view = harness({
            mutation: (name, _input, options) => {
                if (name === "chat.companionAsk") {
                    askSignal = options?.signal;
                    return pendingAsk.promise;
                }
                if (name === "chat.companionReset") return pendingReset.promise;
                return Promise.reject(new Error("Unexpected mutation"));
            },
            query: (name) =>
                name === "chat.runtime"
                    ? Promise.resolve(activeRuntimePage())
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await screen.findByRole("button", { name: "Stop response" });
            await revealCompanionControls();
            await user.type(
                screen.getByRole("textbox", { name: "Ask about this chat" }),
                "What changed?"
            );
            await user.click(screen.getByRole("button", { name: "Ask chat companion" }));
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Asking…" })).toBeDisabled()
            );
            expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
            await user.click(screen.getByRole("button", { name: "Reset" }));
            expect(askSignal?.aborted).toBeTrue();
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "chat.companionReset"
                )
            ).toHaveLength(1);
            expect(
                await screen.findByRole("button", {
                    name: "Resetting…",
                })
            ).toBeDisabled();
            await user.click(screen.getByRole("button", { name: "Resetting…" }));
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "chat.companionReset"
                )
            ).toHaveLength(1);
            await act(async () => {
                pendingAsk.resolve({
                    answer: "Stale answer",
                    timestampMs: observedAtMs + 1,
                });
                await pendingAsk.promise;
            });
            expect(screen.queryByText("Stale answer")).toBeNull();
            expect(
                screen.getByRole("textbox", { name: "Ask about this chat" })
            ).toBeDisabled();
            await user.click(screen.getByRole("button", { name: "Ask chat companion" }));
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.companionAsk")
            ).toHaveLength(1);
            await act(async () => {
                pendingReset.resolve({ reset: true });
                await pendingReset.promise;
            });
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled()
            );
        } finally {
            pendingAsk.resolve({ answer: "Stale answer", timestampMs: observedAtMs });
            pendingReset.resolve({ reset: true });
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("allows a companion ask while the selected session has no active run", async () => {
        const view = harness({
            mutation: (name, input) =>
                name === "chat.companionAsk"
                    ? Promise.resolve({
                          answer: `Answered: ${String(
                              (input as { question?: unknown }).question
                          )}`,
                          timestampMs: observedAtMs + 1,
                      })
                    : Promise.reject(new Error("Unexpected mutation")),
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            await revealCompanionControls();
            await user.type(
                screen.getByRole("textbox", { name: "Ask about this chat" }),
                "What changed?"
            );
            await user.click(screen.getByRole("button", { name: "Ask chat companion" }));
            await waitFor(() =>
                expect(
                    view.mutation.mock.calls.filter(
                        (call) => call[0] === "chat.companionAsk"
                    )
                ).toHaveLength(1)
            );
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("gates an unknown companion reset until a newer exact state read", async () => {
        const unknownOutcome = Object.assign(new Error("Unknown reset outcome"), {
            data: { reason: "operation_outcome_unknown" },
        });
        const reconciliation = Promise.withResolvers<{ exchanges: [] }>();
        let companionReads = 0;
        const view = harness({
            mutation: (name) =>
                name === "chat.companionReset"
                    ? Promise.reject(unknownOutcome)
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) => {
                if (name === "chat.runtime") return Promise.resolve(activeRuntimePage());
                if (name === "chat.companionState") {
                    companionReads += 1;
                    return companionReads === 1
                        ? Promise.resolve({ exchanges: [] })
                        : reconciliation.promise;
                }
                return;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            await revealCompanionControls();
            await user.dblClick(screen.getByRole("button", { name: "Reset" }));
            expect(
                await screen.findByText(
                    /could not confirm whether the chat companion was reset/iu
                )
            ).toBeVisible();
            expect(screen.getByRole("button", { name: "Resetting…" })).toBeDisabled();
            expect(
                screen.getByRole("textbox", { name: "Ask about this chat" })
            ).toBeDisabled();
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "chat.companionReset"
                )
            ).toHaveLength(1);

            await act(async () => {
                reconciliation.resolve({ exchanges: [] });
                await reconciliation.promise;
            });
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled()
            );
            expect(
                screen.queryByText(
                    /could not confirm whether the chat companion was reset/iu
                )
            ).toBeNull();
        } finally {
            reconciliation.resolve({ exchanges: [] });
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("does not join a delayed pre-reset companion read from an empty state", async () => {
        const unknownOutcome = Object.assign(new Error("Unknown reset outcome"), {
            data: { reason: "operation_outcome_unknown" },
        });
        const preActionRead = Promise.withResolvers<{ exchanges: [] }>();
        const postActionRead = Promise.withResolvers<{ exchanges: [] }>();
        let companionReads = 0;
        const view = harness({
            mutation: (name) =>
                name === "chat.companionReset"
                    ? Promise.reject(unknownOutcome)
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) => {
                if (name === "chat.companionState") {
                    companionReads += 1;
                    if (companionReads === 1) return Promise.resolve({ exchanges: [] });
                    return companionReads === 2
                        ? preActionRead.promise
                        : postActionRead.promise;
                }
                return;
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await waitForConnectedComposer();
            await revealCompanionControls();
            void view.queryClient.invalidateQueries({
                exact: true,
                queryKey: chatCompanionQueryKey(gatewayPrimarySessionKey),
            });
            await waitFor(() => expect(companionReads).toBe(2));
            await user.click(screen.getByRole("button", { name: "Reset" }));
            await waitFor(() => expect(companionReads).toBe(3));

            await act(async () => {
                preActionRead.resolve({ exchanges: [] });
                await preActionRead.promise;
                await Promise.resolve();
            });
            expect(screen.getByRole("button", { name: "Resetting…" })).toBeDisabled();

            await act(async () => {
                postActionRead.resolve({ exchanges: [] });
                await postActionRead.promise;
            });
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled()
            );
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "chat.companionReset"
                )
            ).toHaveLength(1);
        } finally {
            preActionRead.resolve({ exchanges: [] });
            postActionRead.resolve({ exchanges: [] });
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("does not publish an expired reset across an auth and session switch", async () => {
        const otherSession: GatewaySession = {
            ...primarySession,
            displayName: "Mira other",
            key: "agent:other:main",
            sessionId: "session-generation-2",
        };
        const twoSessionSnapshot = snapshot();
        const sessions = [primarySession, otherSession];
        const pendingReset = Promise.withResolvers<{ reset: true }>();
        const view = harness({
            mirrorSelection: true,
            mutation: (name) =>
                name === "chat.companionReset"
                    ? pendingReset.promise
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name, input) => {
                if (name !== "chat.companionState") return;
                const sessionKey =
                    typeof input === "object" && input !== null && "sessionKey" in input
                        ? String(input.sessionKey)
                        : "";
                return Promise.resolve({
                    exchanges:
                        sessionKey === gatewayPrimarySessionKey
                            ? [
                                  {
                                      answer: "Existing A answer",
                                      question: "Existing A question",
                                      timestampMs: observedAtMs - 1,
                                  },
                              ]
                            : [],
                });
            },
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: {
                ...twoSessionSnapshot,
                sessions,
                stats: deriveGatewaySessionStats(sessions, observedAtMs),
            },
        });
        const user = userEvent.setup();
        try {
            await revealCompanionControls();
            expect(await screen.findByText("Existing A answer")).toBeVisible();
            view.queryClient.setQueryData(authStatusQueryKey, {
                state: "bootstrap-required",
            } satisfies AuthStatus);
            await user.click(screen.getByRole("button", { name: "Reset" }));
            expect(
                await screen.findByRole("button", {
                    name: "Resetting…",
                })
            ).toBeDisabled();

            await user.click(screen.getByRole("button", { name: "Agent" }));
            await user.click(screen.getByRole("option", { name: /other 1 session/iu }));
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent(
                    "other"
                )
            );
            expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();

            view.queryClient.setQueryData(authStatusQueryKey, {
                state: "anonymous",
            } satisfies AuthStatus);
            await act(async () => {
                pendingReset.resolve({ reset: true });
                await pendingReset.promise;
                await Promise.resolve();
            });

            await user.click(screen.getByRole("button", { name: "Agent" }));
            await user.click(screen.getByRole("option", { name: /main 1 session/iu }));
            expect(await screen.findByText("Existing A answer")).toBeVisible();
            expect(screen.getByRole("button", { name: "Resetting…" })).toBeDisabled();
            expect(
                view.mutation.mock.calls.filter(
                    (call) => call[0] === "chat.companionReset"
                )
            ).toHaveLength(1);
        } finally {
            pendingReset.resolve({ reset: true });
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });

    test("keeps an unknown companion ask gated pending exact state reconciliation", async () => {
        const unknownOutcome = Object.assign(new Error("Unknown ask outcome"), {
            data: { reason: "operation_outcome_unknown" },
        });
        const view = harness({
            mutation: (name) =>
                name === "chat.companionAsk"
                    ? Promise.reject(unknownOutcome)
                    : Promise.reject(new Error("Unexpected mutation")),
            query: (name) =>
                name === "chat.runtime"
                    ? Promise.resolve(activeRuntimePage())
                    : undefined,
            requestedSessionKey: gatewayPrimarySessionKey,
            sessionSnapshot: snapshot(),
        });
        const user = userEvent.setup();
        try {
            await screen.findByRole("button", { name: "Stop response" });
            await revealCompanionControls();
            const question = screen.getByRole("textbox", {
                name: "Ask about this chat",
            });
            await user.type(question, "Do not duplicate");
            await user.dblClick(
                screen.getByRole("button", { name: "Ask chat companion" })
            );
            expect(
                await screen.findByText(
                    /could not confirm whether the chat companion received the question/iu
                )
            ).toBeVisible();
            expect(question).toBeDisabled();
            expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
            expect(
                view.mutation.mock.calls.filter((call) => call[0] === "chat.companionAsk")
            ).toHaveLength(1);
        } finally {
            await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
            view.rendered.unmount();
            view.queryClient.clear();
        }
    });
});
