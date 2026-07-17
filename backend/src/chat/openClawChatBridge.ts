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
    terminalSequence: number;
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
const SESSION_ECHO_WINDOW_MS = 60_000;
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

function isAgentSessionKey(sessionKey: string): boolean {
    return /^agent:[^:]+:.+$/iu.test(sessionKey.trim());
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

function matchingSessionKeys(
    sessionKey: string,
    sessions: readonly OpenClawChatSessionIdentity[]
): Map<string, string> {
    const matches = new Map<string, string>();
    for (const session of sessions) {
        if (isSameSessionKey(session.key, sessionKey)) {
            matches.set(session.key.toLowerCase(), session.key);
        }
    }
    return matches;
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
        isRunlessRunId(runId) ||
        runId.startsWith("dashboard-chat-") ||
        runId.startsWith("dashboard-compact-")
    );
}

function isRunlessRunId(runId: string): boolean {
    return runId === "runless" || /^runless:\d+$/u.test(runId);
}

function isMetadataOnlyCompletionEnvelope(envelope: OpenClawRuntimeEnvelope): boolean {
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
        payload?.message === undefined &&
        payload?.content === undefined &&
        payload?.text === undefined &&
        terminalStates.every((value) => !TERMINAL_FAILURE_STATES.has(value || ""))
    );
}

function isMetadataOnlyRunlessCompletion(run: RetainedRun): boolean {
    return (
        isRunlessRunId(run.runId) &&
        run.events.length > 0 &&
        run.events.every((event) => isMetadataOnlyCompletionEnvelope(event))
    );
}

function lastSequence(run: RetainedRun): number {
    return run.events.at(-1)?.runtimeSequence ?? -1;
}

function normalizedMessageText(value: unknown): string {
    if (typeof value === "string") {
        return value.trim();
    }
    if (!Array.isArray(value)) {
        return "";
    }
    return value
        .map((block) => {
            if (typeof block === "string") {
                return block;
            }
            const record = asRecord(block);
            if (["thinking", "toolCall"].includes(String(record?.type))) {
                return "";
            }
            return typeof record?.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

function messageSignature(payload: unknown): string | undefined {
    const record = asRecord(payload);
    if (!record) {
        return undefined;
    }
    const message = asRecord(record.message);
    const candidates = message
        ? [message.text, message.content]
        : [record.message, record.content, record.text];
    for (const candidate of candidates) {
        const text = normalizedMessageText(candidate);
        if (text) {
            return `text:${text}`;
        }
    }
    for (const candidate of candidates) {
        if (
            candidate === undefined ||
            candidate === null ||
            candidate === "" ||
            (Array.isArray(candidate) && candidate.length === 0)
        ) {
            continue;
        }
        try {
            const serialized = JSON.stringify(candidate);
            if (serialized) {
                return `content:${serialized}`;
            }
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function hasChatFinal(run: RetainedRun): boolean {
    return run.events.some(
        (candidate) =>
            candidate.event === "chat" && asRecord(candidate.payload)?.state === "final"
    );
}

function isMatchingSessionEcho(
    run: RetainedRun,
    envelope: OpenClawRuntimeEnvelope
): boolean {
    const payload = asRecord(envelope.payload);
    const nestedMessage = asRecord(payload?.message);
    const role = stringField(payload, "role") || stringField(nestedMessage, "role");
    if (role && role.toLowerCase() !== "assistant") {
        return false;
    }
    const elapsedMilliseconds = envelope.runtimeRecordedAt - run.updatedAt;
    if (elapsedMilliseconds < -5000 || elapsedMilliseconds > SESSION_ECHO_WINDOW_MS) {
        return false;
    }
    const signature = messageSignature(envelope.payload);
    return Boolean(
        signature &&
        run.events.some(
            (candidate) =>
                candidate.event === "chat" &&
                asRecord(candidate.payload)?.state === "final" &&
                messageSignature(candidate.payload) === signature
        )
    );
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

    #promoteSessionEntry(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        preferredRunId?: string
    ): void {
        if (sourceSessionKey === canonicalSessionKey) {
            return;
        }
        const sourceRuns = this.#runsBySession.get(sourceSessionKey);
        if (!sourceRuns || (preferredRunId && !sourceRuns.has(preferredRunId))) {
            return;
        }

        const canonicalRuns = this.#runsBySession.get(canonicalSessionKey) || new Map();
        const runIds: Iterable<string> = preferredRunId
            ? [preferredRunId]
            : sourceRuns.keys();
        for (const runId of runIds) {
            const sourceRun = sourceRuns.get(runId);
            if (!sourceRun) {
                continue;
            }
            const rewrittenEvents = sourceRun.events.flatMap((envelope) => {
                const payload = asRecord(envelope.payload);
                if (stringField(payload, "sessionKey") !== sourceSessionKey) {
                    return [envelope];
                }
                const rewritten = {
                    ...envelope,
                    payload: { ...payload, sessionKey: canonicalSessionKey },
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
                        stringField(payload, "runId"),
                        canonicalSessionKey
                    ),
                };
                return Buffer.byteLength(JSON.stringify(compact)) <= MAX_BYTES_PER_RUN
                    ? [compact]
                    : [];
            });
            this.#replaceRunEvents(sourceRun, rewrittenEvents);
            if (sourceRun.events.length === 0) {
                sourceRuns.delete(runId);
                this.#forgetRunSession(runId, sourceSessionKey);
                continue;
            }
            const existing = canonicalRuns.get(runId);
            if (existing) {
                this.#replaceRunEvents(existing, [
                    ...existing.events,
                    ...sourceRun.events,
                ]);
                existing.completed ||= sourceRun.completed;
                existing.terminalSequence = Math.max(
                    existing.terminalSequence,
                    sourceRun.terminalSequence
                );
                existing.updatedAt = Math.max(existing.updatedAt, sourceRun.updatedAt);
            } else {
                canonicalRuns.set(runId, sourceRun);
            }
            sourceRuns.delete(runId);
            this.#forgetRunSession(runId, sourceSessionKey);
            this.#rememberRunSession(runId, canonicalSessionKey);
        }

        if (sourceRuns.size === 0) {
            this.#runsBySession.delete(sourceSessionKey);
        }
        while (canonicalRuns.size > MAX_RUNS_PER_SESSION) {
            const oldestRunId = canonicalRuns
                .values()
                .toArray()
                .toSorted((left, right) => left.updatedAt - right.updatedAt)[0]?.runId;
            if (!oldestRunId) {
                break;
            }
            canonicalRuns.delete(oldestRunId);
            this.#forgetRunSession(oldestRunId, canonicalSessionKey);
        }
        if (canonicalRuns.size === 0) {
            this.#runsBySession.delete(canonicalSessionKey);
        } else {
            this.#runsBySession.set(canonicalSessionKey, canonicalRuns);
        }
        this.#enforceSessionLimit();
    }

    #enforceSessionLimit(): void {
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

    #sessionCandidates(
        providedSessionKey: string,
        runId: string | undefined,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): Map<string, string> {
        const indexedCandidates = matchingSessionKeys(providedSessionKey, sessions);
        const associatedCandidates = new Map<string, string>();
        if (runId) {
            const normalizedProvidedKey = providedSessionKey.toLowerCase();
            const associatedSessionKeys = this.#sessionsByRun.get(runId) || [];
            for (const associatedSessionKey of associatedSessionKeys) {
                if (
                    associatedSessionKey.toLowerCase() !== normalizedProvidedKey &&
                    isSameSessionKey(associatedSessionKey, providedSessionKey)
                ) {
                    associatedCandidates.set(
                        associatedSessionKey.toLowerCase(),
                        associatedSessionKey
                    );
                }
            }
        }
        if (indexedCandidates.size > 1 && associatedCandidates.size > 0) {
            const indexedAssociations = new Map<string, string>();
            for (const [normalizedKey, candidate] of associatedCandidates) {
                if (indexedCandidates.has(normalizedKey)) {
                    indexedAssociations.set(normalizedKey, candidate);
                }
            }
            if (indexedAssociations.size > 0) {
                return indexedAssociations;
            }
        }
        return new Map([...indexedCandidates, ...associatedCandidates]);
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

        this.reconcileSessions(sessions);

        const runId = stringField(record, "runId");
        const providedSessionKey = stringField(record, "sessionKey");
        if (providedSessionKey) {
            const candidates = this.#sessionCandidates(
                providedSessionKey,
                runId,
                sessions
            );
            if (candidates.size === 1) {
                const canonical = candidates.values().next().value;
                return canonical && canonical !== providedSessionKey
                    ? { ...record, sessionKey: canonical }
                    : payload;
            }
            if (candidates.size > 1 && !isAgentSessionKey(providedSessionKey)) {
                const unscoped = { ...record };
                delete unscoped.sessionKey;
                return unscoped;
            }
            return payload;
        }

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
            existing.terminalSequence = Math.max(
                existing.terminalSequence,
                provisional.terminalSequence
            );
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
        let runs = this.#runsBySession.get(sessionKey);
        if (
            preferredProvisionalRunId &&
            !runs?.has(preferredProvisionalRunId) &&
            isAgentSessionKey(sessionKey)
        ) {
            const aliasEntries = [...this.#runsBySession].filter(
                ([candidateSessionKey, candidateRuns]) =>
                    !isAgentSessionKey(candidateSessionKey) &&
                    isSameSessionKey(candidateSessionKey, sessionKey) &&
                    candidateRuns.has(preferredProvisionalRunId)
            );
            if (aliasEntries.length === 1) {
                this.#promoteSessionEntry(
                    aliasEntries[0]![0],
                    sessionKey,
                    preferredProvisionalRunId
                );
                runs = this.#runsBySession.get(sessionKey);
            }
        }
        if (!runs) {
            return;
        }

        const preferred = preferredProvisionalRunId
            ? runs.get(preferredProvisionalRunId)
            : undefined;
        if (preferredProvisionalRunId && preferred) {
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
                (!run.completed || isRunlessRunId(run.runId))
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
        const activeRunlessRuns = activeRuns.filter((run) => isRunlessRunId(run.runId));
        const compatibleActiveRun =
            activeRuns.length === 1
                ? activeRuns[0]
                : activeRunlessRuns.length === 1
                  ? activeRunlessRuns[0]
                  : undefined;
        const isMetadataOnlyCompletion =
            !explicitRunId && isMetadataOnlyCompletionEnvelope(retainedEnvelope);
        const completedRuns =
            !explicitRunId &&
            (envelope.event === "session.message" || isMetadataOnlyCompletion)
                ? runs
                      .values()
                      .filter((run) => run.completed)
                      .toArray()
                      .toSorted(
                          (left, right) => right.terminalSequence - left.terminalSequence
                      )
                : [];
        const latestMeaningfulCompletion = completedRuns.find(
            (run) => !isMetadataOnlyRunlessCompletion(run)
        );
        const hasNewerActiveRunlessWork = Boolean(
            compatibleActiveRun &&
            isRunlessRunId(compatibleActiveRun.runId) &&
            lastSequence(compatibleActiveRun) >
                (latestMeaningfulCompletion?.terminalSequence ?? -1)
        );
        if (
            isMetadataOnlyCompletion &&
            latestMeaningfulCompletion &&
            !hasNewerActiveRunlessWork
        ) {
            return;
        }
        const metadataCompletionRun = isMetadataOnlyCompletion
            ? completedRuns.find((run) => isMetadataOnlyRunlessCompletion(run))
            : undefined;
        const completedEchoRun =
            !explicitRunId &&
            envelope.event === "session.message" &&
            latestMeaningfulCompletion &&
            hasChatFinal(latestMeaningfulCompletion) &&
            isMatchingSessionEcho(latestMeaningfulCompletion, envelope)
                ? latestMeaningfulCompletion
                : undefined;
        const runId =
            explicitRunId ||
            completedEchoRun?.runId ||
            compatibleActiveRun?.runId ||
            metadataCompletionRun?.runId ||
            `runless:${envelope.runtimeSequence}`;
        let snapshot = runs.get(runId);

        if (!snapshot) {
            snapshot = {
                completed: false,
                eventBytes: [],
                events: [],
                runId,
                terminalSequence: -1,
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
        if (isTerminal) {
            snapshot.terminalSequence = envelope.runtimeSequence;
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
        this.#enforceSessionLimit();
    }

    /** Clears all ephemeral replay state, for example after credentials change. */
    clear(): void {
        this.#runsBySession.clear();
        this.#sessionsByRun.clear();
    }

    /** Canonicalizes quarantined short session keys after the session index loads. */
    reconcileSessions(sessions: readonly OpenClawChatSessionIdentity[]): void {
        for (const sessionKey of this.#runsBySession.keys()) {
            if (isAgentSessionKey(sessionKey)) {
                continue;
            }
            const runs = this.#runsBySession.get(sessionKey);
            if (!runs) {
                continue;
            }
            for (const runId of runs.keys()) {
                const candidates = this.#sessionCandidates(sessionKey, runId, sessions);
                if (candidates.size === 1) {
                    const canonical = candidates.values().next().value;
                    if (canonical && canonical !== sessionKey) {
                        this.#promoteSessionEntry(sessionKey, canonical, runId);
                    }
                }
            }
        }
    }

    /** Captures the runtime cutoff immediately before a Gateway request starts. */
    captureRequestBoundary(): number {
        return this.#sequence;
    }

    /** Clears replay state associated with one reset, aborted, or deleted session. */
    clearSession(sessionKey: string): void {
        const sessionKeys = new Set([sessionKey]);
        if (isAgentSessionKey(sessionKey)) {
            for (const candidateSessionKey of this.#runsBySession.keys()) {
                if (
                    !isAgentSessionKey(candidateSessionKey) &&
                    isSameSessionKey(candidateSessionKey, sessionKey)
                ) {
                    sessionKeys.add(candidateSessionKey);
                }
            }
        }
        for (const matchingSessionKey of sessionKeys) {
            this.#runsBySession.delete(matchingSessionKey);
            for (const runId of this.#sessionsByRun.keys()) {
                this.#forgetRunSession(runId, matchingSessionKey);
            }
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
            .toSorted((left, right) => right.terminalSequence - left.terminalSequence);
        const newestCompleted = completed[0];
        const completedToReplay =
            newestCompleted && isMetadataOnlyRunlessCompletion(newestCompleted)
                ? completed.find(
                      (snapshot) => !isMetadataOnlyRunlessCompletion(snapshot)
                  ) || newestCompleted
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
