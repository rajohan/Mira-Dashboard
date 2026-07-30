import type { OpenClawRuntimeEnvelope } from "../../../contracts/chat.ts";
import {
    isConversationContinuationEvent,
    isMetadataOnlyCompletionEnvelope,
    type RuntimeSessionInstance,
} from "./openClawChatLifecycle.ts";
import {
    asRecord,
    runtimePayloadView,
    sessionMessageActiveRunIds,
    sessionMessageRole,
    sessionMessageStopReason,
    stringField,
} from "./openClawChatProviderAdapter.ts";
import {
    firstSequence,
    isCompactionOnlyRun,
    lastSequence,
    type RetainedRun,
} from "./openClawChatRetention.ts";

/** Minimal provider session shape used to recover missing runtime identities. */
export interface OpenClawChatSessionIdentity {
    id: string;
    key: string;
    runId?: string;
    activeRunId?: string;
    currentRunId?: string;
}

export interface RepairedInterruptedRun {
    interruptedRunIds: string[];
    providerRunId: string;
}

const MAX_RUN_ASSOCIATIONS = 200;
export const INTERRUPTED_RUN_PROMOTION_WINDOW_MS = 15 * 60_000;
const SESSION_ECHO_WINDOW_MS = 60_000;

/** Owns bounded run/session associations and runtime-session identity state. */
export class OpenClawChatIdentityRegistry {
    readonly #runtimeSessionBySession = new Map<string, RuntimeSessionInstance>();
    readonly #sessionsByRun = new Map<string, Set<string>>();

    /**
     * Combines provider-index and learned run associations without guessing.
     * @param providedSessionKey Session key present on the runtime payload.
     * @param runId Optional provider run identifier.
     * @param sessions Provider session index.
     * @returns Canonical session candidates keyed by normalized identity.
     */
    sessionCandidates(
        providedSessionKey: string,
        runId: string | undefined,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): Map<string, string> {
        const indexedCandidates = matchingSessionKeys(providedSessionKey, sessions);
        const associatedCandidates = new Map<string, string>();
        if (runId) {
            const normalizedProvidedKey = normalizedSessionKey(providedSessionKey);
            const associatedSessionKeys = this.#sessionsByRun.get(runId) || [];
            for (const associatedSessionKey of associatedSessionKeys) {
                if (
                    normalizedSessionKey(associatedSessionKey) !==
                        normalizedProvidedKey &&
                    isSameSessionKey(associatedSessionKey, providedSessionKey)
                ) {
                    associatedCandidates.set(
                        normalizedSessionKey(associatedSessionKey),
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

    /**
     * Resolves an unscoped run only when learned and provider-index identities agree.
     * @param runId Provider run identifier.
     * @param sessions Provider session index.
     * @returns The sole session candidate, or undefined when absent or ambiguous.
     */
    sessionKeyForRun(
        runId: string,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): string | undefined {
        const candidateSessionKeys = new Set(this.#sessionsByRun.get(runId));
        for (const session of sessions) {
            if (hasRunIdentifier(session, runId)) {
                candidateSessionKeys.add(session.key);
            }
        }
        return candidateSessionKeys.size === 1
            ? candidateSessionKeys.values().next().value
            : undefined;
    }

    /**
     * Learns one bounded run-to-session association and refreshes its LRU position.
     * @param runId Provider run identifier.
     * @param sessionKey Associated session key.
     */
    rememberRunSession(runId: string, sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const sessionKeys = new Set([
            ...(this.#sessionsByRun.get(runId) ?? []),
            storageSessionKey,
        ]);
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

    /**
     * Forgets one run-to-session association.
     * @param runId Provider run identifier.
     * @param sessionKey Associated session key.
     */
    forgetRunSession(runId: string, sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const sessionKeys = this.#sessionsByRun.get(runId);
        if (!sessionKeys) {
            return;
        }
        sessionKeys.delete(storageSessionKey);
        if (sessionKeys.size === 0) {
            this.#sessionsByRun.delete(runId);
        }
    }

    /**
     * Forgets every learned identity associated with one evicted session.
     * @param sessionKey Session key evicted from process memory.
     */
    forgetSession(sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        this.#runtimeSessionBySession.delete(storageSessionKey);
        for (const runId of this.#sessionsByRun.keys()) {
            this.forgetRunSession(runId, storageSessionKey);
        }
    }

    /**
     * Returns the latest OpenClaw runtime-session boundary for one chat session.
     * @param sessionKey Chat session key.
     * @returns Runtime-session identity when observed.
     */
    runtimeSession(sessionKey: string): RuntimeSessionInstance | undefined {
        return this.#runtimeSessionBySession.get(normalizedSessionKey(sessionKey));
    }

    /**
     * Records the latest OpenClaw runtime-session boundary for one chat session.
     * @param sessionKey Chat session key.
     * @param runtimeSession Runtime-session identity.
     */
    setRuntimeSession(sessionKey: string, runtimeSession: RuntimeSessionInstance): void {
        this.#runtimeSessionBySession.set(
            normalizedSessionKey(sessionKey),
            runtimeSession
        );
    }

    /**
     * Moves the freshest runtime-session identity during alias promotion.
     * @param sourceSessionKey Source alias key.
     * @param canonicalSessionKey Canonical destination key.
     * @param retainSource Whether replay remains under the source alias.
     */
    promoteRuntimeSession(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        retainSource: boolean
    ): void {
        const sourceStorageKey = normalizedSessionKey(sourceSessionKey);
        const canonicalStorageKey = normalizedSessionKey(canonicalSessionKey);
        const sourceRuntimeSession = this.#runtimeSessionBySession.get(sourceStorageKey);
        const canonicalRuntimeSession =
            this.#runtimeSessionBySession.get(canonicalStorageKey);
        if (
            sourceRuntimeSession &&
            (!canonicalRuntimeSession ||
                sourceRuntimeSession.id === canonicalRuntimeSession.id ||
                sourceRuntimeSession.startedAt >= canonicalRuntimeSession.startedAt)
        ) {
            this.#runtimeSessionBySession.set(canonicalStorageKey, sourceRuntimeSession);
        }
        if (!retainSource) {
            this.#runtimeSessionBySession.delete(sourceStorageKey);
        }
    }

    /** Clears every process-local identity association. */
    clear(): void {
        this.#runtimeSessionBySession.clear();
        this.#sessionsByRun.clear();
    }
}

export function latestOptionalTimestamp(
    left: number | undefined,
    right: number | undefined
): number | undefined {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.max(left, right);
}

export function hasRunIdentifier(
    session: OpenClawChatSessionIdentity,
    runId: string
): boolean {
    return [
        session.id,
        session.key,
        session.runId,
        session.activeRunId,
        session.currentRunId,
    ].includes(runId);
}

export function isAgentSessionKey(sessionKey: string): boolean {
    return /^agent:[^:]+:.+$/iu.test(sessionKey.trim());
}

export function normalizedSessionKey(sessionKey: string): string {
    return sessionKey.trim().toLowerCase();
}

export function isExactSessionKey(left: string, right: string): boolean {
    return normalizedSessionKey(left) === normalizedSessionKey(right);
}

export function isSameSessionKey(left: string, right: string): boolean {
    const normalizedLeft = normalizedSessionKey(left);
    const normalizedRight = normalizedSessionKey(right);
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

export function matchingSessionKeys(
    sessionKey: string,
    sessions: readonly OpenClawChatSessionIdentity[]
): Map<string, string> {
    const matches = new Map<string, string>();
    for (const session of sessions) {
        if (isSameSessionKey(session.key, sessionKey)) {
            matches.set(normalizedSessionKey(session.key), session.key);
        }
    }
    return matches;
}

export function isProvisionalRunId(runId: string): boolean {
    return (
        isRunlessRunId(runId) ||
        runId.startsWith("dashboard-chat-") ||
        runId.startsWith("dashboard-compact-")
    );
}

export function isRunlessRunId(runId: string): boolean {
    return runId === "runless" || /^runless:\d+$/u.test(runId);
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
    const record = runtimePayloadView(payload);
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

export function sessionMessageRunId(
    event: unknown,
    payload: unknown
): string | undefined {
    if (event !== "session.message" || sessionMessageRole(payload) !== "user") {
        return undefined;
    }
    const record = runtimePayloadView(payload);
    const activeRunIds = sessionMessageActiveRunIds(payload);
    const providerRunIds = [...new Set(activeRunIds)].filter(
        (runId) => !isProvisionalRunId(runId)
    );
    if (providerRunIds.length === 1) {
        return providerRunIds[0];
    }
    const idempotencyKey =
        stringField(asRecord(record?.message), "idempotencyKey") ||
        stringField(record, "idempotencyKey");
    return idempotencyKey?.match(/^(dashboard-chat-.+):user$/u)?.[1];
}

export function sessionMessageRequestId(
    event: unknown,
    payload: unknown
): string | undefined {
    if (event !== "session.message" || sessionMessageRole(payload) !== "user") {
        return undefined;
    }
    const record = runtimePayloadView(payload);
    const idempotencyKey =
        stringField(asRecord(record?.message), "idempotencyKey") ||
        stringField(record, "idempotencyKey");
    return idempotencyKey?.match(/^(.+):user$/u)?.[1];
}

export function isPromotableRunlessUserLedRun(
    run: RetainedRun,
    envelope: OpenClawRuntimeEnvelope,
    runs: ReadonlyMap<string, RetainedRun>
): boolean {
    const firstEvent = run.events[0];
    const isRunlessUserLedRun =
        !run.completed &&
        isRunlessRunId(run.runId) &&
        firstEvent?.event === "session.message" &&
        sessionMessageRole(firstEvent.payload) === "user";
    if (isRunlessUserLedRun) {
        return true;
    }
    const terminalEvent = run.events.find(
        (event) => event.runtimeSequence === run.terminalSequence
    );
    const isLatestSessionRun = runs
        .values()
        .every((candidate) => lastSequence(candidate) <= lastSequence(run));
    const isLatestCompletedSyntheticTurn = Boolean(
        isLatestSessionRun &&
        run.completed &&
        isRunlessRunId(run.runId) &&
        firstEvent?.event === "session.message" &&
        sessionMessageRole(firstEvent.payload) === "user" &&
        terminalEvent?.event === "session.message" &&
        sessionMessageRole(terminalEvent.payload) === "assistant" &&
        sessionMessageStopReason(terminalEvent.payload) === "stop" &&
        envelope.runtimeSequence > run.terminalSequence
    );
    if (!isLatestCompletedSyntheticTurn || !terminalEvent) {
        return false;
    }
    if (isMetadataOnlyCompletionEnvelope(envelope)) {
        return true;
    }
    const terminalSignature = messageSignature(terminalEvent.payload);
    return Boolean(
        terminalSignature && terminalSignature === messageSignature(envelope.payload)
    );
}

function isPromotableInterruptedConversationRun(
    run: RetainedRun,
    envelope: OpenClawRuntimeEnvelope,
    requestBoundary?: number
): boolean {
    const providerRunId = stringField(runtimePayloadView(envelope.payload), "runId");
    const resumeDelay = envelope.runtimeRecordedAt - (run.interruptedAt ?? run.updatedAt);
    return (
        providerRunId !== undefined &&
        providerRunId.length > 0 &&
        resumeDelay >= -5000 &&
        resumeDelay <= INTERRUPTED_RUN_PROMOTION_WINDOW_MS &&
        !run.completed &&
        run.interruptionEligible &&
        !isProvisionalRunId(providerRunId) &&
        isConversationContinuationEvent(envelope.event, envelope.payload) &&
        envelope.runtimeSequence > lastSequence(run) &&
        !(
            requestBoundary !== undefined &&
            requestBoundary < envelope.runtimeSequence &&
            firstSequence(run) <= requestBoundary
        )
    );
}

export function promotableInterruptedConversationRuns(
    envelope: OpenClawRuntimeEnvelope,
    runs: ReadonlyMap<string, RetainedRun>,
    requestBoundary?: number,
    providerRun?: RetainedRun
): RetainedRun[] {
    const candidates = runs
        .values()
        .filter(
            (run) =>
                run !== providerRun &&
                isPromotableInterruptedConversationRun(run, envelope, requestBoundary)
        )
        .toArray();
    if (candidates.length === 0) {
        return [];
    }
    if (
        candidates.length > 1 &&
        candidates.some((run) => run.interruptedAt === undefined)
    ) {
        return [];
    }
    const candidateSet = new Set(candidates);
    const coversEveryActiveConversation = runs
        .values()
        .every(
            (run) =>
                run === providerRun ||
                run.completed ||
                isCompactionOnlyRun(run) ||
                candidateSet.has(run)
        );
    return coversEveryActiveConversation
        ? candidates.toSorted(
              (left, right) =>
                  firstSequence(left) - firstSequence(right) ||
                  left.runId.localeCompare(right.runId)
          )
        : [];
}

export function isActiveConversationAtBoundary(
    run: RetainedRun,
    requestBoundary: number
): boolean {
    return (
        !run.completed &&
        !isCompactionOnlyRun(run) &&
        firstSequence(run) <= requestBoundary
    );
}

export function isMatchingSessionEcho(
    run: RetainedRun,
    envelope: OpenClawRuntimeEnvelope
): boolean {
    const role = sessionMessageRole(envelope.payload);
    if (role && role !== "assistant") {
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
                (
                    stringField(runtimePayloadView(candidate.payload), "state") || ""
                ).toLowerCase() === "final" &&
                messageSignature(candidate.payload) === signature
        )
    );
}
