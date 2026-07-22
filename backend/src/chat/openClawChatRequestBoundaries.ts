export interface OpenClawChatRequestBoundaryMetadata {
    acknowledgedRequestIds?: string[];
    pendingRequestBoundaries?: Record<string, number>;
    requestBoundary?: number;
}

interface RequestBoundaryState {
    acknowledged: Set<string>;
    pending: Map<string, number>;
    settled?: number;
}

export const MAX_OPENCLAW_PENDING_REQUEST_BOUNDARIES = 100;
const SYNTHETIC_REQUEST_ID_PREFIX = "request:";

function fallbackPendingEntry(
    pending: ReadonlyMap<string, number>,
    fallbackBoundary: number | undefined
): [string, number] | undefined {
    if (fallbackBoundary === undefined) {
        return undefined;
    }
    return pending
        .entries()
        .find(
            ([pendingRequestId, boundary]) =>
                boundary === fallbackBoundary &&
                pendingRequestId.startsWith(SYNTHETIC_REQUEST_ID_PREFIX)
        );
}

function mergeRequestBoundaryMetadata(
    left: OpenClawChatRequestBoundaryMetadata,
    right: OpenClawChatRequestBoundaryMetadata
): OpenClawChatRequestBoundaryMetadata {
    const pending = new Map(Object.entries(left.pendingRequestBoundaries || {}));
    const rightPending = Object.entries(right.pendingRequestBoundaries || {});
    for (const [requestId, boundary] of rightPending) {
        pending.set(requestId, Math.max(pending.get(requestId) ?? -1, boundary));
    }
    const acknowledged = new Set([
        ...(left.acknowledgedRequestIds || []),
        ...(right.acknowledgedRequestIds || []),
    ]);
    const acknowledgedRequestIds = [...acknowledged].filter((requestId) =>
        pending.has(requestId)
    );
    return {
        ...(acknowledgedRequestIds.length > 0 && {
            acknowledgedRequestIds,
        }),
        ...(pending.size > 0 && {
            pendingRequestBoundaries: Object.fromEntries(pending),
        }),
        requestBoundary:
            left.requestBoundary === undefined
                ? right.requestBoundary
                : right.requestBoundary === undefined
                  ? left.requestBoundary
                  : Math.max(left.requestBoundary, right.requestBoundary),
    };
}

function requestBoundaryStateMetadata(
    state: RequestBoundaryState | undefined
): OpenClawChatRequestBoundaryMetadata {
    if (!state) {
        return {};
    }
    return {
        ...(state.acknowledged.size > 0 && {
            acknowledgedRequestIds: [...state.acknowledged],
        }),
        ...(state.pending.size > 0 && {
            pendingRequestBoundaries: Object.fromEntries(state.pending),
        }),
        ...(state.settled !== undefined && { requestBoundary: state.settled }),
    };
}

export class OpenClawChatRequestBoundaries {
    readonly #states = new Map<string, RequestBoundaryState>();

    constructor(
        private readonly normalizeSessionKey: (sessionKey: string) => string,
        private readonly isSameSessionKey: (left: string, right: string) => boolean
    ) {}

    clear(): void {
        this.#states.clear();
    }

    forget(sessionKey: string): void {
        for (const candidateSessionKey of this.#states.keys()) {
            if (this.isSameSessionKey(candidateSessionKey, sessionKey)) {
                this.#states.delete(candidateSessionKey);
            }
        }
    }

    forgetExact(sessionKey: string): void {
        this.#states.delete(this.normalizeSessionKey(sessionKey));
    }

    metadata(sessionKey: string): OpenClawChatRequestBoundaryMetadata {
        const acknowledged = new Set<string>();
        const pending = new Map<string, number>();
        let settled: number | undefined;
        for (const [candidateSessionKey, state] of this.#states) {
            if (!this.isSameSessionKey(candidateSessionKey, sessionKey)) {
                continue;
            }
            if (state.settled !== undefined) {
                settled = Math.max(settled ?? -1, state.settled);
            }
            for (const requestId of state.acknowledged) {
                acknowledged.add(requestId);
            }
            for (const [requestId, boundary] of state.pending) {
                pending.set(requestId, Math.max(pending.get(requestId) ?? -1, boundary));
            }
        }
        const acknowledgedRequestIds = [...acknowledged].filter((requestId) =>
            pending.has(requestId)
        );
        return {
            ...(acknowledgedRequestIds.length > 0 && {
                acknowledgedRequestIds,
            }),
            ...(pending.size > 0 && {
                pendingRequestBoundaries: Object.fromEntries(pending),
            }),
            ...(settled !== undefined && { requestBoundary: settled }),
        };
    }

    merge(
        sourceSessionKey: string,
        canonicalSessionKey: string
    ): OpenClawChatRequestBoundaryMetadata {
        return mergeRequestBoundaryMetadata(
            this.metadata(sourceSessionKey),
            this.metadata(canonicalSessionKey)
        );
    }

    restore(sessionKey: string, metadata: OpenClawChatRequestBoundaryMetadata): void {
        const storageSessionKey = this.normalizeSessionKey(sessionKey);
        const merged = mergeRequestBoundaryMetadata(
            requestBoundaryStateMetadata(this.#states.get(storageSessionKey)),
            metadata
        );
        if (
            merged.requestBoundary === undefined &&
            Object.keys(merged.pendingRequestBoundaries || {}).length === 0
        ) {
            return;
        }
        this.#states.set(storageSessionKey, {
            acknowledged: new Set(
                (merged.acknowledgedRequestIds || []).filter((requestId) =>
                    Object.hasOwn(merged.pendingRequestBoundaries || {}, requestId)
                )
            ),
            pending: new Map(Object.entries(merged.pendingRequestBoundaries || {})),
            settled: merged.requestBoundary,
        });
    }

    latest(sessionKey: string): number | undefined {
        const metadata = this.metadata(sessionKey);
        const boundaries = [
            metadata.requestBoundary,
            ...Object.values(metadata.pendingRequestBoundaries || {}),
        ].filter((boundary): boundary is number => boundary !== undefined);
        return boundaries.length > 0 ? Math.max(...boundaries) : undefined;
    }

    blocking(sessionKey: string): number | undefined {
        const metadata = this.metadata(sessionKey);
        const acknowledged = new Set(metadata.acknowledgedRequestIds || []);
        const boundaries = [
            metadata.requestBoundary,
            ...Object.entries(metadata.pendingRequestBoundaries || {}).flatMap(
                ([requestId, boundary]) => (acknowledged.has(requestId) ? [] : [boundary])
            ),
        ].filter((boundary): boundary is number => boundary !== undefined);
        return boundaries.length > 0 ? Math.max(...boundaries) : undefined;
    }

    clearSettledWithinRun(sessionKey: string, firstSequence: number): string[] {
        const changedSessionKeys: string[] = [];
        for (const [candidateSessionKey, state] of this.#states) {
            if (
                !this.isSameSessionKey(candidateSessionKey, sessionKey) ||
                state.settled === undefined ||
                state.settled < firstSequence
            ) {
                continue;
            }
            state.settled = undefined;
            changedSessionKeys.push(candidateSessionKey);
            if (state.pending.size === 0) {
                this.#states.delete(candidateSessionKey);
            }
        }
        return changedSessionKeys;
    }

    pending(
        sessionKey: string,
        requestId: string | undefined,
        fallbackBoundary?: number
    ): number | undefined {
        let exactBoundary: number | undefined;
        let fallbackBoundaryMatch: number | undefined;
        for (const [candidateSessionKey, state] of this.#states) {
            if (!this.isSameSessionKey(candidateSessionKey, sessionKey)) {
                continue;
            }
            const exact = requestId ? state.pending.get(requestId) : undefined;
            if (exact !== undefined) {
                exactBoundary = Math.max(exactBoundary ?? -1, exact);
            }
            const fallbackEntry = fallbackPendingEntry(state.pending, fallbackBoundary);
            if (fallbackEntry) {
                fallbackBoundaryMatch = Math.max(
                    fallbackBoundaryMatch ?? -1,
                    fallbackEntry[1]
                );
            }
        }
        return exactBoundary ?? fallbackBoundaryMatch;
    }

    canCapture(sessionKey: string, requestId: string | undefined): boolean {
        const state = this.#states.get(this.normalizeSessionKey(sessionKey));
        if (!state) {
            return true;
        }
        const pendingRequestId = requestId?.trim();
        return (
            state.pending.size < MAX_OPENCLAW_PENDING_REQUEST_BOUNDARIES ||
            (pendingRequestId !== undefined && state.pending.has(pendingRequestId))
        );
    }

    capture(sessionKey: string, requestId: string | undefined, boundary: number): void {
        const storageSessionKey = this.normalizeSessionKey(sessionKey);
        const state = this.#states.get(storageSessionKey) || {
            acknowledged: new Set<string>(),
            pending: new Map<string, number>(),
        };
        let pendingRequestId = requestId?.trim();
        if (!pendingRequestId) {
            let suffix = state.pending.size;
            do {
                pendingRequestId = `${SYNTHETIC_REQUEST_ID_PREFIX}${boundary}:${suffix++}`;
            } while (state.pending.has(pendingRequestId));
        }
        if (!this.canCapture(storageSessionKey, pendingRequestId)) {
            throw new Error("Too many pending chat requests for one session");
        }
        state.acknowledged.delete(pendingRequestId);
        state.pending.set(pendingRequestId, boundary);
        this.#states.set(storageSessionKey, state);
    }

    acknowledge(
        sessionKey: string,
        requestId: string | undefined,
        fallbackBoundary?: number
    ): string[] {
        const requestBoundary = this.pending(sessionKey, requestId, fallbackBoundary);
        if (requestBoundary === undefined) {
            return [];
        }
        const changedSessionKeys: string[] = [];
        for (const [candidateSessionKey, state] of this.#states) {
            if (!this.isSameSessionKey(candidateSessionKey, sessionKey)) {
                continue;
            }
            const acknowledgedRequestId =
                requestId && state.pending.has(requestId)
                    ? requestId
                    : requestId
                      ? undefined
                      : fallbackPendingEntry(state.pending, requestBoundary)?.[0];
            if (!acknowledgedRequestId || state.acknowledged.has(acknowledgedRequestId)) {
                continue;
            }
            state.acknowledged.add(acknowledgedRequestId);
            changedSessionKeys.push(candidateSessionKey);
        }
        return changedSessionKeys;
    }

    settle(
        sessionKey: string,
        requestId: string | undefined,
        fallbackBoundary: number | undefined,
        isContinuation: boolean
    ): string[] {
        const requestBoundary = this.pending(sessionKey, requestId, fallbackBoundary);
        if (requestBoundary === undefined) {
            return [];
        }
        const changedSessionKeys = new Set<string>();
        for (const [candidateSessionKey, state] of this.#states) {
            if (!this.isSameSessionKey(candidateSessionKey, sessionKey)) {
                continue;
            }
            const hasExact = Boolean(requestId && state.pending.has(requestId));
            const fallbackEntry = hasExact
                ? undefined
                : fallbackPendingEntry(state.pending, requestBoundary);
            if (hasExact && requestId) {
                state.pending.delete(requestId);
                state.acknowledged.delete(requestId);
            } else if (fallbackEntry) {
                state.pending.delete(fallbackEntry[0]);
                state.acknowledged.delete(fallbackEntry[0]);
            } else {
                continue;
            }
            changedSessionKeys.add(candidateSessionKey);
        }
        if (!isContinuation) {
            const owners =
                changedSessionKeys.size > 0
                    ? [...changedSessionKeys]
                    : [this.normalizeSessionKey(sessionKey)];
            for (const owner of owners) {
                const state = this.#states.get(owner) || {
                    acknowledged: new Set<string>(),
                    pending: new Map<string, number>(),
                };
                state.settled = Math.max(state.settled ?? -1, requestBoundary);
                this.#states.set(owner, state);
                changedSessionKeys.add(owner);
            }
        }
        for (const candidateSessionKey of changedSessionKeys) {
            const state = this.#states.get(candidateSessionKey);
            if (state && state.pending.size === 0 && state.settled === undefined) {
                this.#states.delete(candidateSessionKey);
            }
        }
        return [...changedSessionKeys];
    }
}
