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

function deferred<T>() {
    return Promise.withResolvers<T>();
}

function fakeTransport(snapshotPromise: Promise<ChatRuntimeSnapshot>, generation = 1) {
    const listeners = new Set<(event: ChatRuntimeEvent) => void>();
    const transport: ChatTransport = {
        abort: jest.fn(async () => {}),
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

    it("drops selected-session events covered by the snapshot cutoff", async () => {
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

        expect(result.current.state.sessions[SELECTED]).toBeUndefined();
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
        const { result } = renderHook(() =>
            useChatRuntime({ selectedSessionKey: SELECTED, transport: fake.transport })
        );

        act(() => fake.emit(assistant(SELECTED, 16, "fallback")));
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
    });
});
