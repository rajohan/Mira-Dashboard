import type { RuntimeSessionInstance } from "./openClawChatLifecycle.ts";

/** Minimal provider session shape used to recover missing runtime identities. */
export interface OpenClawChatSessionIdentity {
    id: string;
    key: string;
    runId?: string;
    activeRunId?: string;
    currentRunId?: string;
}

const MAX_RUN_ASSOCIATIONS = 200;

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
        const candidateSessionKeys = new Set(
            [...(this.#sessionsByRun.get(runId) ?? [])].map((sessionKey) =>
                normalizedSessionKey(sessionKey)
            )
        );
        for (const session of sessions) {
            if (hasRunIdentifier(session, runId)) {
                candidateSessionKeys.add(normalizedSessionKey(session.key));
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
