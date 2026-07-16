/** A minimal session shape used to recover missing session keys on runtime events. */
export interface OpenClawChatSessionIdentity {
    id: string;
    key: string;
    runId?: string;
    activeRunId?: string;
    currentRunId?: string;
}

/** A sequenced OpenClaw runtime envelope forwarded to Dashboard clients. */
export interface OpenClawRuntimeEnvelope {
    type: "event";
    event: unknown;
    payload: unknown;
    runtimeSequence: number;
}

export interface OpenClawRuntimeSnapshot {
    completed: boolean;
    events: OpenClawRuntimeEnvelope[];
    throughSequence: number;
}

interface RetainedRun {
    completed: boolean;
    eventBytes: number[];
    events: OpenClawRuntimeEnvelope[];
    runId: string;
    totalBytes: number;
    updatedAt: number;
}

const COMPLETED_RUN_TTL_MS = 15 * 60_000;
const ACTIVE_RUN_TTL_MS = 6 * 60 * 60_000;
const MAX_EVENTS_PER_RUN = 500;
const MAX_BYTES_PER_RUN = 1_000_000;
const MAX_RUNS_PER_SESSION = 4;
const MAX_SESSIONS = 50;
const MAX_RUN_ASSOCIATIONS = 200;
const RETAINED_EVENTS = new Set([
    "agent",
    "chat",
    "model.completed",
    "session.ended",
    "session.message",
    "session.tool",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function stringField(
    record: Record<string, unknown> | undefined,
    key: string
): string | undefined {
    const value = record?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
}

function hasRunIdentifier(session: OpenClawChatSessionIdentity, runId: string): boolean {
    return [
        session.id,
        session.key,
        session.runId,
        session.activeRunId,
        session.currentRunId,
    ].includes(runId);
}

function isTerminalEvent(event: unknown, payload: unknown): boolean {
    if (event === "model.completed" || event === "session.ended") {
        return true;
    }

    const record = asRecord(payload);
    return (
        event === "chat" &&
        typeof record?.state === "string" &&
        ["aborted", "error", "final"].includes(record.state)
    );
}

function isProvisionalRunId(runId: string): boolean {
    return (
        runId === "runless" ||
        runId.startsWith("dashboard-chat-") ||
        runId.startsWith("dashboard-compact-")
    );
}

function hasChatFinal(run: RetainedRun): boolean {
    return run.events.some((envelope) => {
        const payload = asRecord(envelope.payload);
        return envelope.event === "chat" && payload?.state === "final";
    });
}

function lastSequence(run: RetainedRun): number {
    return run.events.at(-1)?.runtimeSequence ?? -1;
}

/**
 * Quarantines the OpenClaw-specific runtime replay contract behind one backend
 * boundary. Dashboard chat code consumes this bridge instead of owning cache,
 * alias, retention, and request-cleanup rules inside the generic Gateway relay.
 */
export class OpenClawChatBridge {
    readonly #runsBySession = new Map<string, Map<string, RetainedRun>>();
    readonly #sessionByRun = new Map<string, string | undefined>();
    #sequence = 0;

    #clearCompletedRuns(sessionKey: string, preservedRunId?: string): void {
        const runs = this.#runsBySession.get(sessionKey);
        if (!runs) {
            return;
        }
        for (const [runId, run] of runs) {
            if (run.completed && runId !== preservedRunId) {
                runs.delete(runId);
            }
        }
        if (runs.size === 0) {
            this.#runsBySession.delete(sessionKey);
        }
    }

    #enrichPayload(
        event: unknown,
        payload: unknown,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): unknown {
        if (typeof event !== "string" || !RETAINED_EVENTS.has(event)) {
            return payload;
        }

        const record = asRecord(payload);
        if (!record || stringField(record, "sessionKey")) {
            return payload;
        }

        const runId = stringField(record, "runId");
        if (!runId) {
            return payload;
        }

        const hasRememberedRun = this.#sessionByRun.has(runId);
        const rememberedSessionKey = this.#sessionByRun.get(runId);
        const sessionKey =
            hasRememberedRun && !rememberedSessionKey
                ? undefined
                : rememberedSessionKey ||
                  sessions.find((session) => hasRunIdentifier(session, runId))?.key;

        return sessionKey ? { ...record, sessionKey } : payload;
    }

    #rememberRunSession(runId: string, sessionKey: string): void {
        const previousSessionKey = this.#sessionByRun.get(runId);
        const isAmbiguous =
            this.#sessionByRun.has(runId) && previousSessionKey !== sessionKey;
        this.#sessionByRun.delete(runId);
        this.#sessionByRun.set(runId, isAmbiguous ? undefined : sessionKey);

        while (this.#sessionByRun.size > MAX_RUN_ASSOCIATIONS) {
            const oldestRunId = this.#sessionByRun.keys().next().value;
            if (!oldestRunId) {
                break;
            }
            this.#sessionByRun.delete(oldestRunId);
        }
    }

    #prune(now = Date.now()): void {
        for (const [sessionKey, runs] of this.#runsBySession) {
            for (const [runId, snapshot] of runs) {
                const ttl = snapshot.completed ? COMPLETED_RUN_TTL_MS : ACTIVE_RUN_TTL_MS;
                if (now - snapshot.updatedAt > ttl) {
                    runs.delete(runId);
                }
            }
            if (runs.size === 0) {
                this.#runsBySession.delete(sessionKey);
            }
        }
    }

    #retain(envelope: OpenClawRuntimeEnvelope): void {
        if (typeof envelope.event !== "string" || !RETAINED_EVENTS.has(envelope.event)) {
            return;
        }

        const payload = asRecord(envelope.payload);
        const sessionKey = stringField(payload, "sessionKey");
        if (!sessionKey) {
            return;
        }

        const isTerminal = isTerminalEvent(envelope.event, envelope.payload);
        const explicitRunId = stringField(payload, "runId");
        const serializedBytes = Buffer.byteLength(JSON.stringify(envelope));
        const retainedEnvelope =
            serializedBytes <= MAX_BYTES_PER_RUN
                ? envelope
                : isTerminal
                  ? {
                        ...envelope,
                        payload: {
                            runId: explicitRunId,
                            sessionKey,
                            state: payload?.state,
                        },
                    }
                  : undefined;
        if (!retainedEnvelope) {
            return;
        }

        const retainedBytes =
            retainedEnvelope === envelope
                ? serializedBytes
                : Buffer.byteLength(JSON.stringify(retainedEnvelope));

        this.#prune();
        const runs = this.#runsBySession.get(sessionKey) || new Map();
        const activeRuns = runs
            .values()
            .filter((snapshot) => !snapshot.completed)
            .toArray();
        const runId =
            explicitRunId ||
            (activeRuns.length === 1 ? activeRuns[0]?.runId : undefined) ||
            "runless";
        let snapshot = runs.get(runId);

        if (!snapshot && explicitRunId && activeRuns.length === 1) {
            const provisional = activeRuns[0];
            if (provisional && isProvisionalRunId(provisional.runId)) {
                runs.delete(provisional.runId);
                provisional.runId = explicitRunId;
                runs.set(explicitRunId, provisional);
                snapshot = provisional;
            }
        }

        if (!snapshot) {
            snapshot = {
                completed: false,
                eventBytes: [],
                events: [],
                runId,
                totalBytes: 0,
                updatedAt: Date.now(),
            };
            runs.set(runId, snapshot);
        }

        snapshot.events.push(retainedEnvelope);
        snapshot.eventBytes.push(retainedBytes);
        snapshot.totalBytes += retainedBytes;
        while (
            snapshot.events.length > 1 &&
            (snapshot.events.length > MAX_EVENTS_PER_RUN ||
                snapshot.totalBytes > MAX_BYTES_PER_RUN)
        ) {
            snapshot.events.shift();
            snapshot.totalBytes -= snapshot.eventBytes.shift() || 0;
        }
        snapshot.completed ||= isTerminal;
        snapshot.updatedAt = Date.now();

        while (runs.size > MAX_RUNS_PER_SESSION) {
            const oldestRunId = runs
                .values()
                .toArray()
                .toSorted((left, right) => left.updatedAt - right.updatedAt)[0]?.runId;
            if (!oldestRunId) {
                break;
            }
            runs.delete(oldestRunId);
        }

        this.#runsBySession.set(sessionKey, runs);
        while (this.#runsBySession.size > MAX_SESSIONS) {
            const oldestSessionKey = this.#runsBySession
                .keys()
                .map((key) => ({
                    key,
                    updatedAt: Math.max(
                        ...this.#runsBySession
                            .get(key)!
                            .values()
                            .map((entry) => entry.updatedAt)
                    ),
                }))
                .toArray()
                .toSorted((left, right) => left.updatedAt - right.updatedAt)[0]?.key;
            if (!oldestSessionKey) {
                break;
            }
            this.#runsBySession.delete(oldestSessionKey);
        }
    }

    /** Clears all ephemeral replay state, for example after credentials change. */
    clear(): void {
        this.#runsBySession.clear();
        this.#sessionByRun.clear();
        this.#sequence = 0;
    }

    /** Clears replay state associated with one reset, aborted, or deleted session. */
    clearSession(sessionKey: string): void {
        this.#runsBySession.delete(sessionKey);
        for (const [runId, mappedSessionKey] of this.#sessionByRun) {
            if (mappedSessionKey === sessionKey) {
                this.#sessionByRun.delete(runId);
            }
        }
    }

    /** Updates run associations and replay cleanup after successful RPCs. */
    handleSuccessfulRequest(
        method: string,
        parameters: Record<string, unknown>,
        payload: unknown
    ): void {
        if (method === "chat.abort") {
            const sessionKey = stringField(parameters, "sessionKey");
            if (sessionKey) {
                this.clearSession(sessionKey);
            }
            return;
        }
        if (method === "sessions.delete") {
            const sessionKey = stringField(parameters, "key");
            if (sessionKey) {
                this.clearSession(sessionKey);
            }
            return;
        }
        if (method !== "chat.send") {
            return;
        }

        const sessionKey = stringField(parameters, "sessionKey");
        const message = stringField(parameters, "message");
        if (sessionKey && message && /^\/(?:new|reset)(?:\s|$)/i.test(message)) {
            this.clearSession(sessionKey);
            return;
        }
        const runId = stringField(asRecord(payload), "runId");
        if (sessionKey) {
            this.#clearCompletedRuns(sessionKey, runId);
            if (runId) {
                this.#rememberRunSession(runId, sessionKey);
            }
        }
    }

    /**
     * Records one Gateway event and returns the exact sequenced envelope to
     * broadcast. Events without a session remain live-only and are not cached.
     */
    recordEvent(
        event: unknown,
        payload: unknown,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): OpenClawRuntimeEnvelope {
        const envelope: OpenClawRuntimeEnvelope = {
            type: "event",
            event,
            payload: this.#enrichPayload(event, payload, sessions),
            runtimeSequence: ++this.#sequence,
        };
        this.#retain(envelope);
        return envelope;
    }

    /** Returns active runs or the latest completed run for one session. */
    snapshot(sessionKey: string): OpenClawRuntimeSnapshot {
        this.#prune();
        const snapshots = [...(this.#runsBySession.get(sessionKey)?.values() || [])];
        const active = snapshots.filter((snapshot) => !snapshot.completed);
        const completed = snapshots
            .filter((snapshot) => snapshot.completed)
            .toSorted((left, right) => lastSequence(right) - lastSequence(left));
        const newestCompleted = completed[0];
        const concreteCompleted =
            newestCompleted?.runId === "runless" && !hasChatFinal(newestCompleted)
                ? completed.find((snapshot) => snapshot.runId !== "runless") ||
                  newestCompleted
                : newestCompleted;
        const selected =
            active.length > 0 ? active : concreteCompleted ? [concreteCompleted] : [];

        return {
            completed: active.length === 0 && selected.length > 0,
            events: selected
                .flatMap((snapshot) => snapshot.events)
                .toSorted((left, right) => left.runtimeSequence - right.runtimeSequence),
            throughSequence: this.#sequence,
        };
    }
}
