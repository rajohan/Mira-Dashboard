import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";

import type { ChatRuntimeEvent } from "../components/features/chat/domain/chatState";
import type {
    ChatRuntimeSnapshot,
    ChatTransport,
} from "../components/features/chat/transport/chatTransport";
import { useChatRuntime } from "../components/features/chat/useChatRuntime";

const SELECTED = "agent:main:main";
const OFFSCREEN = "agent:other:main";

function assistant(
    sessionKey: string,
    sequence: number,
    text: string,
    mode: "append" | "merge" | "replace" = "append"
): ChatRuntimeEvent {
    return {
        kind: "assistant",
        message: { content: text, role: "assistant", text },
        mode,
        runId: "run-1",
        sequence,
        sessionKey,
        source: "chat",
        timestamp: "2026-07-16T12:00:00.000Z",
    };
}

function user(
    sessionKey: string,
    sequence: number,
    text: string,
    timestamp: string
): ChatRuntimeEvent {
    return {
        kind: "user",
        message: { content: text, role: "user", text, timestamp },
        runId: "run-1",
        sequence,
        sessionKey,
        timestamp,
    };
}

function finish(
    sessionKey: string,
    sequence: number,
    error?: string,
    timestamp = new Date().toISOString()
): Extract<ChatRuntimeEvent, { kind: "finish" }> {
    return {
        error,
        kind: "finish",
        outcome: error ? "error" : "completed",
        runId: "run-1",
        sequence,
        sessionKey,
        timestamp,
    };
}

function deferred<T>() {
    return Promise.withResolvers<T>();
}

function fakeTransport(snapshotPromise: Promise<ChatRuntimeSnapshot>, generation = 1) {
    const listeners = new Set<(event: ChatRuntimeEvent) => void>();
    const transport: ChatTransport = {
        abort: jest.fn(async () => {}),
        compact: jest.fn(async () => {}),
        connectionGeneration: generation,
        history: jest.fn(async () => []),
        isConnected: true,
        models: jest.fn(async () => []),
        patchSession: jest.fn(async () => {}),
        send: jest.fn(async () => ({})),
        snapshot: jest.fn(() => snapshotPromise),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return {
        emit: (event: ChatRuntimeEvent) => {
            for (const listener of listeners) {
                listener(event);
            }
        },
        transport,
    };
}

describe("chat runtime controller", () => {
    it("gates only the selected session and reconciles snapshot/live events", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => {
            fake.emit(assistant(SELECTED, 32, "lo"));
            fake.emit(assistant(OFFSCREEN, 16, "other"));
        });

        expect(result.current.state.sessions[SELECTED]).toBeUndefined();
        expect(
            result.current.state.sessions[OFFSCREEN]?.runs["run-1"]?.assistant?.text
        ).toBe("other");

        await act(async () => {
            snapshot.resolve({
                completed: false,
                events: [assistant(SELECTED, 16, "Hel")],
                throughSequence: 16,
            });
            await snapshot.promise;
        });

        expect(
            result.current.state.sessions[SELECTED]?.runs["run-1"]?.assistant?.text
        ).toBe("Hello");
    });

    it("deduplicates a live event that is also returned by the snapshot", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );
        const live = assistant(SELECTED, 32, "Hello", "replace");

        act(() => fake.emit(live));
        await act(async () => {
            snapshot.resolve({
                completed: false,
                events: [assistant(SELECTED, 16, "Hel"), live],
                throughSequence: 32,
            });
            await snapshot.promise;
        });

        expect(
            result.current.state.sessions[SELECTED]?.runs["run-1"]?.assistant?.text
        ).toBe("Hello");
    });

    it("preserves queued live events absent from the snapshot replay", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => fake.emit(assistant(SELECTED, 32, "stale")));
        await act(async () => {
            snapshot.resolve({ completed: false, events: [], throughSequence: 32 });
            await snapshot.promise;
        });

        expect(
            result.current.state.sessions[SELECTED]?.runs["run-1"]?.assistant?.text
        ).toBe("stale");
    });

    it("preserves active diagnostics across a backend reconnect", async () => {
        const thinking: ChatRuntimeEvent = {
            kind: "thinking",
            message: {
                content: [{ text: "reasoning", type: "thinking" }],
                role: "assistant",
                text: "",
                thinking: [{ text: "reasoning" }],
            },
            runId: "run-1",
            sequence: 16,
            sessionKey: SELECTED,
            timestamp: "2026-07-16T12:00:00.000Z",
        };
        const tool: ChatRuntimeEvent = {
            kind: "tool",
            message: {
                content: "",
                role: "assistant",
                text: "",
                toolCalls: [{ id: "call-1", name: "exec" }],
            },
            runId: "run-1",
            sequence: 32,
            sessionKey: SELECTED,
            timestamp: "2026-07-16T12:00:01.000Z",
            toolKey: "tool:call-1",
        };
        const first = fakeTransport(
            Promise.resolve({
                completed: false,
                events: [thinking, tool],
                runtimeGeneration: "backend-1",
                throughSequence: 32,
            }),
            1
        );
        const reconnectSnapshot = deferred<ChatRuntimeSnapshot>();
        const second = fakeTransport(reconnectSnapshot.promise, 2);
        const { result, rerender } = renderHook(
            ({ transport }) =>
                useChatRuntime({ selectedSessionKey: SELECTED, transport }),
            { initialProps: { transport: first.transport } }
        );

        await waitFor(() =>
            expect(
                result.current.state.sessions[SELECTED]?.runs["run-1"]?.diagnostics
            ).toHaveLength(2)
        );

        rerender({ transport: second.transport });
        await waitFor(() => expect(result.current.state.generation).toBe(2));
        await waitFor(() => expect(second.transport.snapshot).toHaveBeenCalled());
        await act(async () => {
            reconnectSnapshot.resolve({
                completed: false,
                events: [],
                runtimeGeneration: "backend-2",
                throughSequence: 0,
            });
            await reconnectSnapshot.promise;
        });

        expect(
            result.current.state.sessions[SELECTED]?.runs["run-1"]?.diagnostics
        ).toHaveLength(2);

        act(() => second.emit(assistant(SELECTED, 1, "continued", "replace")));
        expect(
            result.current.state.sessions[SELECTED]?.runs["run-1"]?.assistant?.text
        ).toBe("continued");
    });

    it("rebuilds from a persisted completed snapshot after a backend restart", async () => {
        const first = fakeTransport(
            Promise.resolve({
                completed: false,
                events: [assistant(SELECTED, 16, "working", "replace")],
                runtimeGeneration: "backend-1",
                throughSequence: 16,
            }),
            1
        );
        const restartSnapshot = deferred<ChatRuntimeSnapshot>();
        const second = fakeTransport(restartSnapshot.promise, 2);
        const { result, rerender } = renderHook(
            ({ transport }) =>
                useChatRuntime({ selectedSessionKey: SELECTED, transport }),
            { initialProps: { transport: first.transport } }
        );

        await waitFor(() =>
            expect(
                result.current.state.sessions[SELECTED]?.runs["run-1"]?.assistant?.text
            ).toBe("working")
        );
        rerender({ transport: second.transport });
        await act(async () => {
            restartSnapshot.resolve({
                completed: true,
                events: [
                    assistant(SELECTED, 16, "working", "replace"),
                    finish(SELECTED, 32),
                ],
                runtimeGeneration: "backend-2",
                throughSequence: 32,
            });
            await restartSnapshot.promise;
        });

        expect(Object.keys(result.current.state.sessions[SELECTED]?.runs || {})).toEqual([
            "run-1",
        ]);
        expect(result.current.state.sessions[SELECTED]?.runs["run-1"]).toMatchObject({
            assistant: { text: "working" },
            phase: "completed",
        });
    });

    it("accepts a reused user-event sequence after a backend restart", async () => {
        const firstTimestamp = "2026-07-16T12:00:00.000Z";
        const secondTimestamp = "2026-07-16T12:01:00.000Z";
        const first = fakeTransport(
            Promise.resolve({
                completed: false,
                events: [user(SELECTED, 16, "first steer", firstTimestamp)],
                runtimeGeneration: "backend-1",
                throughSequence: 16,
            }),
            1
        );
        const restartSnapshot = deferred<ChatRuntimeSnapshot>();
        const second = fakeTransport(restartSnapshot.promise, 2);
        const { result, rerender } = renderHook(
            ({ transport }) =>
                useChatRuntime({ selectedSessionKey: SELECTED, transport }),
            { initialProps: { transport: first.transport } }
        );

        await waitFor(() =>
            expect(
                result.current.state.sessions[SELECTED]?.runs["run-1"]?.userMessages
            ).toHaveLength(1)
        );
        rerender({ transport: second.transport });
        await act(async () => {
            restartSnapshot.resolve({
                completed: false,
                events: [],
                runtimeGeneration: "backend-2",
                throughSequence: 0,
            });
            await restartSnapshot.promise;
        });
        act(() => second.emit(user(SELECTED, 16, "second steer", secondTimestamp)));

        expect(
            result.current.state.sessions[SELECTED]?.runs["run-1"]?.userMessages.map(
                (entry) => entry.message.text
            )
        ).toEqual(["first steer", "second steer"]);
    });

    it("rebuilds replayed deltas when reconnecting to the same backend", async () => {
        const first = fakeTransport(
            Promise.resolve({
                completed: false,
                events: [assistant(SELECTED, 16, "Hel")],
                runtimeGeneration: "backend-1",
                throughSequence: 16,
            }),
            1
        );
        const second = fakeTransport(
            Promise.resolve({
                completed: false,
                events: [assistant(SELECTED, 16, "Hel"), assistant(SELECTED, 32, "lo")],
                runtimeGeneration: "backend-1",
                throughSequence: 32,
            }),
            2
        );
        const { result, rerender } = renderHook(
            ({ transport }) =>
                useChatRuntime({ selectedSessionKey: SELECTED, transport }),
            { initialProps: { transport: first.transport } }
        );

        await waitFor(() =>
            expect(
                result.current.state.sessions[SELECTED]?.runs["run-1"]?.assistant?.text
            ).toBe("Hel")
        );

        rerender({ transport: second.transport });

        await waitFor(() =>
            expect(
                result.current.state.sessions[SELECTED]?.runs["run-1"]?.assistant?.text
            ).toBe("Hello")
        );
    });

    it("replays an earlier live-only event before a later snapshot finish", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => fake.emit(assistant(SELECTED, 16, "live-only")));
        await act(async () => {
            snapshot.resolve({
                completed: true,
                events: [finish(SELECTED, 32)],
                throughSequence: 32,
            });
            await snapshot.promise;
        });

        expect(result.current.state.sessions[SELECTED]?.runs["run-1"]).toMatchObject({
            assistant: { text: "live-only" },
            phase: "completed",
        });
    });

    it("replaces stale selected-session runtime with an authoritative snapshot", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result, rerender } = renderHook(
            ({ selectedSessionKey }) =>
                useChatRuntime({ selectedSessionKey, transport: fake.transport }),
            { initialProps: { selectedSessionKey: "" } }
        );

        act(() => fake.emit(assistant(SELECTED, 16, "stale")));
        expect(result.current.state.sessions[SELECTED]).toBeDefined();
        rerender({ selectedSessionKey: SELECTED });
        await act(async () => {
            snapshot.resolve({ completed: false, events: [], throughSequence: 16 });
            await snapshot.promise;
        });

        expect(result.current.state.sessions[SELECTED]).toBeUndefined();
    });

    it("preserves a locally optimistic run created before the snapshot gate", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result, rerender } = renderHook(
            ({ selectedSessionKey }) =>
                useChatRuntime({ selectedSessionKey, transport: fake.transport }),
            { initialProps: { selectedSessionKey: "" } }
        );

        act(() => result.current.beginRun(SELECTED, "dashboard-chat-pre-gate"));
        rerender({ selectedSessionKey: SELECTED });
        await act(async () => {
            snapshot.resolve({ completed: false, events: [], throughSequence: 0 });
            await snapshot.promise;
        });

        expect(
            result.current.state.sessions[SELECTED]?.runs["dashboard-chat-pre-gate"]
        ).toMatchObject({ phase: "active" });
    });

    it("preserves an acknowledged compact run created before the snapshot gate", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result, rerender } = renderHook(
            ({ selectedSessionKey }) =>
                useChatRuntime({ selectedSessionKey, transport: fake.transport }),
            { initialProps: { selectedSessionKey: "" } }
        );

        act(() => {
            result.current.beginRun(SELECTED, "dashboard-compact-pre-gate", {
                operation: "compact",
            });
            result.current.acknowledgeRun(
                SELECTED,
                "dashboard-compact-pre-gate",
                "provider-compact-pre-gate"
            );
        });
        rerender({ selectedSessionKey: SELECTED });
        await act(async () => {
            snapshot.resolve({ completed: false, events: [], throughSequence: 0 });
            await snapshot.promise;
        });

        expect(
            result.current.state.sessions[SELECTED]?.runs["provider-compact-pre-gate"]
        ).toMatchObject({
            aliases: expect.arrayContaining([
                "dashboard-compact-pre-gate",
                "provider-compact-pre-gate",
            ]),
            operation: "compact",
            phase: "active",
        });
    });

    it("does not restore a stale acknowledged run after a completed snapshot", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result, rerender } = renderHook(
            ({ selectedSessionKey }) =>
                useChatRuntime({ selectedSessionKey, transport: fake.transport }),
            { initialProps: { selectedSessionKey: "" } }
        );

        act(() => {
            result.current.beginRun(SELECTED, "dashboard-chat-stale");
            result.current.acknowledgeRun(
                SELECTED,
                "dashboard-chat-stale",
                "provider-stale"
            );
        });
        rerender({ selectedSessionKey: SELECTED });
        await act(async () => {
            snapshot.resolve({ completed: true, events: [], throughSequence: 16 });
            await snapshot.promise;
        });

        expect(result.current.state.sessions[SELECTED]).toBeUndefined();
    });

    it("clears a completed optimistic run with an authoritative empty snapshot", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result, rerender } = renderHook(
            ({ selectedSessionKey }) =>
                useChatRuntime({ selectedSessionKey, transport: fake.transport }),
            { initialProps: { selectedSessionKey: "" } }
        );

        act(() => {
            result.current.beginRun(SELECTED, "dashboard-chat-completed");
            fake.emit({
                ...finish(SELECTED, 16),
                runId: "dashboard-chat-completed",
            });
        });
        rerender({ selectedSessionKey: SELECTED });
        await act(async () => {
            snapshot.resolve({ completed: false, events: [], throughSequence: 16 });
            await snapshot.promise;
        });

        expect(result.current.state.sessions[SELECTED]).toBeUndefined();
    });

    it("preserves a new local run started during a completed snapshot", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => result.current.beginRun(SELECTED, "dashboard-chat-new"));
        await act(async () => {
            snapshot.resolve({ completed: true, events: [], throughSequence: 0 });
            await snapshot.promise;
        });

        expect(
            result.current.state.sessions[SELECTED]?.runs["dashboard-chat-new"]?.phase
        ).toBe("active");
    });

    it("reconciles a snapshot run whose send acknowledgement arrives later", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => result.current.beginRun(SELECTED, "dashboard-chat-new"));
        await act(async () => {
            snapshot.resolve({
                completed: false,
                events: [
                    {
                        ...assistant(SELECTED, 16, "working"),
                        runId: "provider-new",
                    },
                ],
                throughSequence: 16,
            });
            await snapshot.promise;
        });
        expect(Object.keys(result.current.state.sessions[SELECTED]?.runs || {})).toEqual([
            "provider-new",
            "dashboard-chat-new",
        ]);

        act(() =>
            result.current.acknowledgeRun(SELECTED, "dashboard-chat-new", "provider-new")
        );
        expect(Object.keys(result.current.state.sessions[SELECTED]?.runs || {})).toEqual([
            "provider-new",
        ]);
        expect(
            result.current.state.sessions[SELECTED]?.runs["provider-new"]?.assistant?.text
        ).toBe("working");
    });

    it("retains optimistic operation metadata when snapshot already has the run", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => {
            result.current.beginRun(SELECTED, "dashboard-compact-new", {
                operation: "compact",
            });
            result.current.acknowledgeRun(
                SELECTED,
                "dashboard-compact-new",
                "provider-compact"
            );
        });
        await act(async () => {
            snapshot.resolve({
                completed: false,
                events: [
                    {
                        ...assistant(SELECTED, 16, "compacting"),
                        runId: "provider-compact",
                    },
                ],
                throughSequence: 16,
            });
            await snapshot.promise;
        });

        expect(
            result.current.state.sessions[SELECTED]?.runs["provider-compact"]
        ).toMatchObject({
            aliases: expect.arrayContaining([
                "dashboard-compact-new",
                "provider-compact",
            ]),
            assistant: { text: "compacting" },
            operation: "compact",
        });
    });

    it("merges a runless snapshot into the pending acknowledged send", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => {
            result.current.beginRun(SELECTED, "dashboard-chat-new");
            result.current.acknowledgeRun(SELECTED, "dashboard-chat-new", "provider-new");
        });
        await act(async () => {
            snapshot.resolve({
                completed: false,
                events: [
                    {
                        ...assistant(SELECTED, 16, "working"),
                        runId: undefined,
                    },
                ],
                throughSequence: 16,
            });
            await snapshot.promise;
        });

        expect(Object.keys(result.current.state.sessions[SELECTED]?.runs || {})).toEqual([
            "provider-new",
        ]);
        act(() =>
            fake.emit({
                ...finish(SELECTED, 32),
                runId: "provider-new",
            })
        );

        const runs = result.current.state.sessions[SELECTED]?.runs || {};
        expect(Object.keys(runs)).toEqual(["provider-new"]);
        expect(runs["provider-new"]).toMatchObject({
            assistant: { text: "working" },
            phase: "completed",
        });
    });

    it("runs finish side effects for replayed and queued terminal events", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const onError = jest.fn();
        const onSettled = jest.fn();
        renderHook(() =>
            useChatRuntime({
                onError,
                onSettled,
                selectedSessionKey: SELECTED,
                transport: fake.transport,
            })
        );

        act(() => fake.emit(finish(SELECTED, 32, "queued failure")));
        await act(async () => {
            snapshot.resolve({
                completed: true,
                events: [finish(SELECTED, 16, "snapshot failure")],
                throughSequence: 16,
            });
            await snapshot.promise;
        });

        expect(onError).toHaveBeenNthCalledWith(1, "snapshot failure");
        expect(onError).toHaveBeenNthCalledWith(2, "queued failure");
        expect(onSettled).toHaveBeenCalledTimes(2);
    });

    it("does not let an offscreen finish consume the selected sequence", async () => {
        const fake = fakeTransport(
            Promise.resolve({ completed: false, events: [], throughSequence: 0 })
        );
        const onError = jest.fn();
        const onSettled = jest.fn();
        renderHook(() =>
            useChatRuntime({
                onError,
                onSettled,
                selectedSessionKey: SELECTED,
                transport: fake.transport,
            })
        );
        await waitFor(() => expect(fake.transport.snapshot).toHaveBeenCalled());

        act(() => {
            fake.emit(finish(OFFSCREEN, 16, "offscreen failure"));
            fake.emit(finish(SELECTED, 16, "selected failure"));
        });

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith("selected failure");
        expect(onSettled).toHaveBeenCalledTimes(1);
        expect(onSettled).toHaveBeenCalledWith(SELECTED);
    });

    it("gates aliased selected-session events and settles the canonical session", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const onError = jest.fn();
        const onSettled = jest.fn();
        const { result } = renderHook(() =>
            useChatRuntime({
                onError,
                onSettled,
                selectedSessionKey: SELECTED,
                transport: fake.transport,
            })
        );

        act(() => fake.emit(finish("main", 16, "alias failure")));
        expect(result.current.state.sessions.main).toBeUndefined();
        await act(async () => {
            snapshot.resolve({ completed: false, events: [], throughSequence: 16 });
            await snapshot.promise;
        });

        expect(result.current.state.sessions.main?.runs["run-1"]?.phase).toBe("error");
        expect(onError).toHaveBeenCalledWith("alias failure");
        expect(onSettled).toHaveBeenCalledWith(SELECTED);
    });

    it("reconciles an aliased queued run with the selected optimistic run", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => {
            result.current.beginRun(SELECTED, "dashboard-chat-alias");
            result.current.acknowledgeRun(
                SELECTED,
                "dashboard-chat-alias",
                "provider-alias"
            );
            fake.emit({
                ...assistant("main", 16, "working"),
                runId: undefined,
            });
        });
        await act(async () => {
            snapshot.resolve({ completed: false, events: [], throughSequence: 16 });
            await snapshot.promise;
        });

        expect(result.current.state.sessions.main).toBeUndefined();
        expect(Object.keys(result.current.state.sessions[SELECTED]?.runs || {})).toEqual([
            "provider-alias",
        ]);
        expect(
            result.current.state.sessions[SELECTED]?.runs["provider-alias"]?.assistant
                ?.text
        ).toBe("working");
    });

    it("uses tool rows before falling back to the global error surface", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const onError = jest.fn();
        const onSettled = jest.fn();
        const { result } = renderHook(() =>
            useChatRuntime({
                onError,
                onSettled,
                selectedSessionKey: SELECTED,
                transport: fake.transport,
            })
        );

        await act(async () => {
            snapshot.resolve({ completed: false, events: [], throughSequence: 0 });
            await snapshot.promise;
        });

        act(() => {
            fake.emit({
                kind: "tool",
                message: {
                    content: "failed",
                    role: "tool",
                    text: "failed",
                    toolResult: {
                        content: "failed",
                        id: "tool-1",
                        isError: true,
                        name: "exec",
                    },
                },
                runId: "run-1",
                sequence: 16,
                sessionKey: SELECTED,
                timestamp: "2026-07-16T12:00:00.000Z",
                toolKey: "tool:tool-1",
            });
            fake.emit({
                ...finish(SELECTED, 32, "tool execution failed: exec"),
                outcome: "error",
                toolFailure: true,
            });
        });

        expect(onError).not.toHaveBeenCalled();
        expect(onSettled).toHaveBeenCalledWith(SELECTED);
        expect(result.current.state.sessions[SELECTED]?.runs["run-1"]?.error).toBe(
            undefined
        );

        act(() => {
            result.current.clearSession(SELECTED);
            fake.emit({
                ...finish(SELECTED, 48, "tool execution failed: missing diagnostic"),
                toolFailure: true,
            });
        });
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith("tool execution failed: missing diagnostic");
        expect(result.current.state.sessions[SELECTED]?.runs["run-1"]?.error).toBe(
            "tool execution failed: missing diagnostic"
        );

        act(() => fake.emit(finish(SELECTED, 64)));
        expect(onError).toHaveBeenCalledTimes(1);

        act(() => {
            result.current.clearSession(SELECTED);
            fake.emit({
                kind: "tool",
                message: {
                    content: "failed",
                    role: "tool",
                    text: "failed",
                    toolResult: {
                        content: "failed",
                        id: "tool-2",
                        isError: true,
                        name: "exec",
                    },
                },
                runId: "run-1",
                sequence: 80,
                sessionKey: SELECTED,
                timestamp: "2026-07-16T12:00:01.000Z",
                toolKey: "tool:tool-2",
            });
            fake.emit({
                ...finish(SELECTED, 96, "model crashed"),
                outcome: "error",
            });
        });
        expect(onError).toHaveBeenCalledWith("model crashed");
        expect(onError).toHaveBeenCalledTimes(2);
    });

    it("retains an old completed snapshot until a new run begins", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );
        const oldTimestamp = new Date(Date.now() - 16 * 60_000).toISOString();

        await act(async () => {
            snapshot.resolve({
                completed: true,
                events: [finish(SELECTED, 16, undefined, oldTimestamp)],
                throughSequence: 16,
            });
            await snapshot.promise;
        });

        expect(result.current.state.sessions[SELECTED]?.runs["run-1"]?.phase).toBe(
            "completed"
        );

        act(() => result.current.beginRun(SELECTED, "dashboard-chat-next"));
        expect(result.current.state.sessions[SELECTED]?.runs["run-1"]).toBeUndefined();
        expect(
            result.current.state.sessions[SELECTED]?.runs["dashboard-chat-next"]?.phase
        ).toBe("active");
    });

    it("restores a completed replay when the optimistic send fails", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        await act(async () => {
            snapshot.resolve({
                completed: true,
                events: [
                    assistant(SELECTED, 16, "previous answer", "replace"),
                    finish(SELECTED, 32),
                ],
                throughSequence: 32,
            });
            await snapshot.promise;
        });

        act(() => result.current.beginRun(SELECTED, "dashboard-chat-failed"));
        expect(result.current.state.sessions[SELECTED]?.runs["run-1"]).toBeUndefined();

        act(() => result.current.failRun(SELECTED, "dashboard-chat-failed"));
        expect(
            result.current.state.sessions[SELECTED]?.runs["dashboard-chat-failed"]
        ).toBeUndefined();
        expect(result.current.state.sessions[SELECTED]?.runs["run-1"]).toMatchObject({
            assistant: { text: "previous answer" },
            phase: "completed",
        });
    });

    it("does not restore a failed optimistic run from an in-flight snapshot", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => {
            result.current.beginRun(SELECTED, "dashboard-chat-failed");
            result.current.failRun(SELECTED, "dashboard-chat-failed");
        });
        await act(async () => {
            snapshot.resolve({ completed: false, events: [], throughSequence: 0 });
            await snapshot.promise;
        });

        expect(
            result.current.state.sessions[SELECTED]?.runs["dashboard-chat-failed"]
        ).toBeUndefined();
    });

    it("does not restore displaced replay after a concurrent send is acknowledged", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        await act(async () => {
            snapshot.resolve({
                completed: true,
                events: [
                    assistant(SELECTED, 16, "previous answer", "replace"),
                    finish(SELECTED, 32),
                ],
                throughSequence: 32,
            });
            await snapshot.promise;
        });

        act(() => {
            result.current.beginRun(SELECTED, "dashboard-chat-first");
            result.current.beginRun(SELECTED, "dashboard-chat-second");
            result.current.acknowledgeRun(
                SELECTED,
                "dashboard-chat-second",
                "provider-second"
            );
            result.current.failRun(SELECTED, "dashboard-chat-first");
        });

        const runs = result.current.state.sessions[SELECTED]?.runs || {};
        expect(runs["run-1"]).toBeUndefined();
        expect(runs["dashboard-chat-first"]).toBeUndefined();
        expect(runs["provider-second"]?.phase).toBe("active");
    });

    it("replaces projection-hidden status runs before routing a new unscoped reply", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        await act(async () => {
            snapshot.resolve({
                completed: false,
                events: [
                    {
                        kind: "status",
                        runId: "stale-status-run",
                        sequence: 16,
                        sessionKey: SELECTED,
                        text: "Thinking",
                        timestamp: "2026-07-16T12:00:00.000Z",
                    },
                ],
                throughSequence: 16,
            });
            await snapshot.promise;
        });

        act(() =>
            result.current.beginRun(SELECTED, "dashboard-chat-current", {
                replaceStatusOnlyRuns: true,
            })
        );
        act(() =>
            fake.emit({
                ...assistant(SELECTED, 32, "current answer"),
                runId: undefined,
            })
        );

        expect(
            result.current.state.sessions[SELECTED]?.runs["stale-status-run"]
        ).toBeUndefined();
        expect(
            result.current.state.sessions[SELECTED]?.runs["dashboard-chat-current"]
                ?.assistant?.text
        ).toBe("current answer");
    });

    it("retains an unscoped finish after a delayed event advances the run", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );
        const oldTimestamp = new Date(Date.now() - 16 * 60_000).toISOString();

        await act(async () => {
            snapshot.resolve({
                completed: true,
                events: [
                    assistant(SELECTED, 8, "partial"),
                    {
                        ...finish(SELECTED, 16, undefined, oldTimestamp),
                        runId: undefined,
                    },
                    assistant(SELECTED, 32, "late"),
                ],
                throughSequence: 32,
            });
            await snapshot.promise;
        });

        expect(result.current.state.sessions[SELECTED]?.runs["run-1"]).toMatchObject({
            assistant: { text: "partiallate" },
            phase: "completed",
        });
    });

    it("processes live events immediately when no session is selected", () => {
        const fake = fakeTransport(
            Promise.resolve({
                completed: false,
                events: [],
                throughSequence: 0,
            })
        );
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: "", transport: fake.transport })
        );

        act(() => fake.emit(assistant(OFFSCREEN, 16, "visible")));

        expect(
            result.current.state.sessions[OFFSCREEN]?.runs["run-1"]?.assistant?.text
        ).toBe("visible");
        expect(fake.transport.snapshot).not.toHaveBeenCalled();
    });

    it("flushes queued events if snapshot recovery fails", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const onSettled = jest.fn();
        const { result } = renderHook(() =>
            useChatRuntime({
                onSettled,
                selectedSessionKey: SELECTED,
                transport: fake.transport,
            })
        );

        act(() => {
            fake.emit(assistant(SELECTED, 16, "fallback"));
            fake.emit(finish(SELECTED, 32));
        });
        await act(async () => {
            snapshot.reject(new Error("offline"));
            try {
                await snapshot.promise;
            } catch {
                // Expected recovery failure.
            }
        });

        await waitFor(() =>
            expect(
                result.current.state.sessions[SELECTED]?.runs["run-1"]?.assistant?.text
            ).toBe("fallback")
        );
        expect(onSettled).toHaveBeenCalledWith(SELECTED);
    });

    it("does not restore a snapshot captured before the session was cleared", async () => {
        const snapshot = deferred<ChatRuntimeSnapshot>();
        const fake = fakeTransport(snapshot.promise);
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => {
            fake.emit(assistant(SELECTED, 32, "queued"));
            result.current.clearSession(SELECTED);
        });
        await act(async () => {
            snapshot.resolve({
                completed: false,
                events: [assistant(SELECTED, 16, "stale")],
                throughSequence: 32,
            });
            await snapshot.promise;
        });

        expect(result.current.state.sessions[SELECTED]).toBeUndefined();
    });
});
