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
const TERMINAL_FAILURE_STATES = new Set(["aborted", "error", "failed"]);
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

function isSameSessionKey(left: string, right: string): boolean {
    const normalizedLeft = left.trim().toLowerCase();
    const normalizedRight = right.trim().toLowerCase();
    if (normalizedLeft === normalizedRight) {
        return true;
    }
    const leftMatch = normalizedLeft.match(/^agent:([^:]+):(.+)$/u);
    const rightMatch = normalizedRight.match(/^agent:([^:]+):(.+)$/u);
    if (leftMatch && rightMatch) {
        return leftMatch[1] === rightMatch[1] && leftMatch[2] === rightMatch[2];
    }
    return leftMatch
        ? leftMatch[2] === normalizedRight
        : rightMatch?.[2] === normalizedLeft;
}

function canonicalSessionKey(
    sessionKey: string,
    sessions: readonly OpenClawChatSessionIdentity[]
): string | undefined {
    const exact = sessions.find(
        (session) => session.key.toLowerCase() === sessionKey.toLowerCase()
    );
    if (exact) {
        return exact.key;
    }
    const matches = sessions.filter((session) =>
        isSameSessionKey(session.key, sessionKey)
    );
    return matches.length === 1 ? matches[0]?.key : undefined;
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

function isMetadataOnlyRunlessCompletion(run: RetainedRun): boolean {
    if (run.runId !== "runless" || run.events.length === 0) {
        return false;
    }
    return run.events.every((envelope) => {
        if (envelope.event !== "session.ended" && envelope.event !== "model.completed") {
            return false;
        }
        const payload = asRecord(envelope.payload);
        const data = asRecord(payload?.data);
        const terminalStates = [
            stringField(payload, "state"),
            stringField(payload, "status"),
            stringField(data, "phase"),
            stringField(data, "status"),
        ].map((value) => value?.toLowerCase());
        return (
            payload?.aborted !== true &&
            data?.aborted !== true &&
            !stringField(payload, "error") &&
            !stringField(payload, "errorMessage") &&
            !stringField(payload, "promptError") &&
            !stringField(data, "error") &&
            !stringField(data, "errorMessage") &&
            !stringField(data, "promptError") &&
            terminalStates.every((value) => !TERMINAL_FAILURE_STATES.has(value || ""))
        );
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
        if (!record) {
            return payload;
        }

        const providedSessionKey = stringField(record, "sessionKey");
        if (providedSessionKey) {
            const canonical = canonicalSessionKey(providedSessionKey, sessions);
            return canonical && canonical !== providedSessionKey
                ? { ...record, sessionKey: canonical }
                : payload;
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

    #replaceRunEvents(run: RetainedRun, events: OpenClawRuntimeEnvelope[]): void {
        const uniqueEvents = new Map<number, OpenClawRuntimeEnvelope>();
        for (const event of events) {
            uniqueEvents.set(event.runtimeSequence, event);
        }
        run.events = uniqueEvents
            .values()
            .toArray()
            .toSorted((left, right) => left.runtimeSequence - right.runtimeSequence);
        run.eventBytes = run.events.map((event) =>
            Buffer.byteLength(JSON.stringify(event))
        );
        run.totalBytes = run.eventBytes.reduce((total, bytes) => total + bytes, 0);
        while (
            run.events.length > 1 &&
            (run.events.length > MAX_EVENTS_PER_RUN || run.totalBytes > MAX_BYTES_PER_RUN)
        ) {
            run.events.shift();
            run.totalBytes -= run.eventBytes.shift() || 0;
        }
    }

    #rewriteProvisionalPayloads(
        sessionKey: string,
        run: RetainedRun,
        provisionalRunId: string,
        providerRunId: string
    ): void {
        const events = run.events.flatMap((envelope) => {
            const payload = asRecord(envelope.payload);
            const payloadRunId = stringField(payload, "runId");
            if (
                !payload ||
                (payloadRunId &&
                    payloadRunId !== provisionalRunId &&
                    !isProvisionalRunId(payloadRunId))
            ) {
                return [envelope];
            }

            const rewritten = {
                ...envelope,
                payload: { ...payload, runId: providerRunId },
            };
            if (Buffer.byteLength(JSON.stringify(rewritten)) <= MAX_BYTES_PER_RUN) {
                return [rewritten];
            }
            if (!isTerminalEvent(envelope.event, rewritten.payload)) {
                return [];
            }
            const compact = {
                ...envelope,
                payload: compactTerminalPayload(
                    asRecord(rewritten.payload),
                    providerRunId,
                    sessionKey
                ),
            };
            return Buffer.byteLength(JSON.stringify(compact)) <= MAX_BYTES_PER_RUN
                ? [compact]
                : [];
        });
        this.#replaceRunEvents(run, events);
    }

    #promoteRunEntry(
        sessionKey: string,
        runs: Map<string, RetainedRun>,
        provisionalRunId: string,
        providerRunId: string
    ): RetainedRun | undefined {
        const provisional = runs.get(provisionalRunId);
        if (!provisional || provisionalRunId === providerRunId) {
            return provisional;
        }

        this.#rewriteProvisionalPayloads(
            sessionKey,
            provisional,
            provisionalRunId,
            providerRunId
        );
        runs.delete(provisionalRunId);
        this.#forgetRunSession(provisionalRunId, sessionKey);
        const existing = runs.get(providerRunId);
        if (existing) {
            this.#replaceRunEvents(existing, [...provisional.events, ...existing.events]);
            existing.completed ||= provisional.completed;
            existing.updatedAt = Math.max(existing.updatedAt, provisional.updatedAt);
            return existing;
        }

        provisional.runId = providerRunId;
        runs.set(providerRunId, provisional);
        return provisional;
    }

    #promoteProvisionalRun(
        sessionKey: string,
        providerRunId: string,
        preferredProvisionalRunId?: string,
        requestBoundary?: number
    ): void {
        const runs = this.#runsBySession.get(sessionKey);
        if (!runs) {
            return;
        }

        const preferred = preferredProvisionalRunId
            ? runs.get(preferredProvisionalRunId)
            : undefined;
        if (
            preferredProvisionalRunId &&
            preferred &&
            isProvisionalRunId(preferred.runId)
        ) {
            this.#promoteRunEntry(
                sessionKey,
                runs,
                preferredProvisionalRunId,
                providerRunId
            );
            return;
        }

        const provisionalEntries = [...runs].filter(([runId, run]) => {
            const isCurrentRequest =
                requestBoundary === undefined || lastSequence(run) > requestBoundary;
            return (
                runId !== providerRunId &&
                isProvisionalRunId(run.runId) &&
                isCurrentRequest &&
                (!run.completed || run.runId === "runless")
            );
        });
        if (provisionalEntries.length !== 1) {
            return;
        }

        this.#promoteRunEntry(sessionKey, runs, provisionalEntries[0]![0], providerRunId);
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
                snapshot = this.#promoteRunEntry(
                    sessionKey,
                    runs,
                    provisional.runId,
                    explicitRunId
                );
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

    /** Captures the runtime cutoff immediately before a Gateway request starts. */
    captureRequestBoundary(): number {
        return this.#sequence;
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
        payload: unknown,
        requestBoundary?: number
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
        const provisionalRunId = stringField(parameters, "idempotencyKey");
        if (sessionKey) {
            const acknowledgedRunId = runId || provisionalRunId;
            if (acknowledgedRunId) {
                this.#promoteProvisionalRun(
                    sessionKey,
                    acknowledgedRunId,
                    provisionalRunId,
                    requestBoundary
                );
            }
            this.#clearCompletedRuns(sessionKey, acknowledgedRunId);
            if (acknowledgedRunId) {
                this.#rememberRunSession(acknowledgedRunId, sessionKey);
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
        const completedToReplay =
            newestCompleted && isMetadataOnlyRunlessCompletion(newestCompleted)
                ? completed.find((snapshot) => snapshot.runId !== "runless") ||
                  newestCompleted
                : newestCompleted;
        const selected =
            active.length > 0 ? active : completedToReplay ? [completedToReplay] : [];

        return {
            completed: active.length === 0 && selected.length > 0,
            events: selected
                .flatMap((snapshot) => snapshot.events)
                .toSorted((left, right) => left.runtimeSequence - right.runtimeSequence),
            throughSequence: this.#sequence,
        };
    }
}
