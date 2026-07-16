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
    runtimeRecordedAt: number;
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
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    const data = asRecord(record?.data);
    return (
        (event === "chat" &&
            typeof record?.state === "string" &&
            ["aborted", "error", "final"].includes(record.state)) ||
        (stringField(record, "stream") === "lifecycle" &&
            ["end", "error"].includes(stringField(data, "phase") || ""))
    );
}

function compactTerminalPayload(
    payload: Record<string, unknown> | undefined,
    runId: string | undefined,
    sessionKey: string
): Record<string, unknown> {
    const data = asRecord(payload?.data);
    const compactData = {
        aborted: data?.aborted === true ? true : undefined,
        error: stringField(data, "error"),
        errorMessage: stringField(data, "errorMessage"),
        phase: stringField(data, "phase"),
        promptError: stringField(data, "promptError"),
        status: stringField(data, "status"),
    };
    const hasCompactData = Object.values(compactData).some(
        (value) => value !== undefined
    );
    return {
        aborted: payload?.aborted === true ? true : undefined,
        data: hasCompactData ? compactData : undefined,
        error: stringField(payload, "error"),
        errorMessage: stringField(payload, "errorMessage"),
        runId,
        sessionKey,
        state: stringField(payload, "state"),
        status: stringField(payload, "status"),
        stream: stringField(payload, "stream"),
    };
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
    readonly #sessionsByRun = new Map<string, Set<string>>();
    #sequence = 0;

    #clearCompletedRuns(sessionKey: string, preservedRunId?: string): void {
        const runs = this.#runsBySession.get(sessionKey);
        if (!runs) {
            return;
        }
        for (const [runId, run] of runs) {
            if (!run.completed || runId === preservedRunId) {
                continue;
            }
            runs.delete(runId);
            this.#forgetRunSession(runId, sessionKey);
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

        const candidateSessionKeys = new Set(this.#sessionsByRun.get(runId));
        for (const session of sessions) {
            if (hasRunIdentifier(session, runId)) {
                candidateSessionKeys.add(session.key);
            }
        }
        const sessionKey =
            candidateSessionKeys.size === 1
                ? candidateSessionKeys.values().next().value
                : undefined;

        return sessionKey ? { ...record, sessionKey } : payload;
    }

    #rememberRunSession(runId: string, sessionKey: string): void {
        const sessionKeys = new Set(this.#sessionsByRun.get(runId));
        sessionKeys.add(sessionKey);
        this.#sessionsByRun.delete(runId);
        this.#sessionsByRun.set(runId, sessionKeys);

        while (this.#sessionsByRun.size > MAX_RUN_ASSOCIATIONS) {
            const oldestRunId = this.#sessionsByRun.keys().next().value;
            if (!oldestRunId) {
                break;
            }
            this.#sessionsByRun.delete(oldestRunId);
        }
    }

    #forgetRunSession(runId: string, sessionKey: string): void {
        const sessionKeys = this.#sessionsByRun.get(runId);
        if (!sessionKeys) {
            return;
        }
        sessionKeys.delete(sessionKey);
        if (sessionKeys.size === 0) {
            this.#sessionsByRun.delete(runId);
        }
    }

    #promoteProvisionalRun(sessionKey: string, providerRunId: string): void {
        const runs = this.#runsBySession.get(sessionKey);
        if (!runs || runs.has(providerRunId)) {
            return;
        }
        const provisionalEntries = [...runs].filter(([, run]) =>
            isProvisionalRunId(run.runId)
        );
        if (provisionalEntries.length !== 1) {
            return;
        }

        const [provisionalRunId, provisionalRun] = provisionalEntries[0]!;
        runs.delete(provisionalRunId);
        this.#forgetRunSession(provisionalRunId, sessionKey);
        provisionalRun.runId = providerRunId;
        runs.set(providerRunId, provisionalRun);
    }

    #prune(now = Date.now()): void {
        for (const [sessionKey, runs] of this.#runsBySession) {
            for (const [runId, snapshot] of runs) {
                const ttl = snapshot.completed ? COMPLETED_RUN_TTL_MS : ACTIVE_RUN_TTL_MS;
                if (now - snapshot.updatedAt > ttl) {
                    runs.delete(runId);
                    this.#forgetRunSession(runId, sessionKey);
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

        const explicitRunId = stringField(payload, "runId");
        const isTerminal = isTerminalEvent(envelope.event, envelope.payload);
        this.#prune();
        const associationBytes = explicitRunId
            ? Buffer.byteLength(JSON.stringify({ runId: explicitRunId, sessionKey }))
            : 0;
        if (explicitRunId && associationBytes <= MAX_BYTES_PER_RUN) {
            this.#rememberRunSession(explicitRunId, sessionKey);
        }
        const serializedBytes = Buffer.byteLength(JSON.stringify(envelope));
        const retainedEnvelope =
            serializedBytes <= MAX_BYTES_PER_RUN
                ? envelope
                : isTerminal
                  ? {
                        ...envelope,
                        payload: compactTerminalPayload(
                            payload,
                            explicitRunId,
                            sessionKey
                        ),
                    }
                  : undefined;
        if (!retainedEnvelope) {
            return;
        }

        const retainedBytes =
            retainedEnvelope === envelope
                ? serializedBytes
                : Buffer.byteLength(JSON.stringify(retainedEnvelope));
        if (retainedBytes > MAX_BYTES_PER_RUN) {
            return;
        }

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
                this.#forgetRunSession(provisional.runId, sessionKey);
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
            this.#forgetRunSession(oldestRunId, sessionKey);
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
            this.clearSession(oldestSessionKey);
        }
    }

    /** Clears all ephemeral replay state, for example after credentials change. */
    clear(): void {
        this.#runsBySession.clear();
        this.#sessionsByRun.clear();
    }

    /** Clears replay state associated with one reset, aborted, or deleted session. */
    clearSession(sessionKey: string): void {
        this.#runsBySession.delete(sessionKey);
        for (const runId of this.#sessionsByRun.keys()) {
            this.#forgetRunSession(runId, sessionKey);
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
            if (runId) {
                this.#promoteProvisionalRun(sessionKey, runId);
            }
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
            runtimeRecordedAt: Date.now(),
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
