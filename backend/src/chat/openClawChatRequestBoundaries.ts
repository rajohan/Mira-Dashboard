export interface OpenClawChatRequestBoundaryMetadata {
    pendingRequestBoundaries?: Record<string, number>;
    requestBoundary?: number;
}

interface RequestBoundaryState {
    pending: Map<string, number>;
    settled?: number;
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

    metadata(sessionKey: string): OpenClawChatRequestBoundaryMetadata {
        const pending = new Map<string, number>();
        let settled: number | undefined;
        for (const [candidateSessionKey, state] of this.#states) {
            if (!this.isSameSessionKey(candidateSessionKey, sessionKey)) {
                continue;
            }
            if (state.settled !== undefined) {
                settled = Math.max(settled ?? -1, state.settled);
            }
            for (const [requestId, boundary] of state.pending) {
                pending.set(requestId, Math.max(pending.get(requestId) ?? -1, boundary));
            }
        }
        return {
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
        const source = this.metadata(sourceSessionKey);
        const canonical = this.metadata(canonicalSessionKey);
        const pending = new Map(Object.entries(source.pendingRequestBoundaries || {}));
        const canonicalPending = Object.entries(canonical.pendingRequestBoundaries || {});
        for (const [requestId, boundary] of canonicalPending) {
            pending.set(requestId, Math.max(pending.get(requestId) ?? -1, boundary));
        }
        return {
            ...(pending.size > 0 && {
                pendingRequestBoundaries: Object.fromEntries(pending),
            }),
            requestBoundary:
                source.requestBoundary === undefined
                    ? canonical.requestBoundary
                    : canonical.requestBoundary === undefined
                      ? source.requestBoundary
                      : Math.max(source.requestBoundary, canonical.requestBoundary),
        };
    }

    restore(sessionKey: string, metadata: OpenClawChatRequestBoundaryMetadata): void {
        if (
            metadata.requestBoundary === undefined &&
            Object.keys(metadata.pendingRequestBoundaries || {}).length === 0
        ) {
            return;
        }
        this.forget(sessionKey);
        this.#states.set(this.normalizeSessionKey(sessionKey), {
            pending: new Map(Object.entries(metadata.pendingRequestBoundaries || {})),
            settled: metadata.requestBoundary,
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

    pending(
        sessionKey: string,
        requestId: string | undefined,
        fallbackBoundary?: number
    ): number | undefined {
        for (const [candidateSessionKey, state] of this.#states) {
            if (!this.isSameSessionKey(candidateSessionKey, sessionKey)) {
                continue;
            }
            const exact = requestId ? state.pending.get(requestId) : undefined;
            if (exact !== undefined) {
                return exact;
            }
            if (
                !requestId &&
                fallbackBoundary !== undefined &&
                state.pending.values().toArray().includes(fallbackBoundary)
            ) {
                return fallbackBoundary;
            }
        }
        return undefined;
    }

    capture(sessionKey: string, requestId: string | undefined, boundary: number): void {
        const storageSessionKey = this.normalizeSessionKey(sessionKey);
        const state = this.#states.get(storageSessionKey) || {
            pending: new Map<string, number>(),
        };
        let pendingRequestId = requestId?.trim();
        if (!pendingRequestId) {
            let suffix = state.pending.size;
            do {
                pendingRequestId = `request:${boundary}:${suffix++}`;
            } while (state.pending.has(pendingRequestId));
        }
        state.pending.set(pendingRequestId, boundary);
        this.#states.set(storageSessionKey, state);
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
        let hasRemovedFallback = false;
        let settlementSessionKey: string | undefined;
        for (const [candidateSessionKey, state] of this.#states) {
            if (!this.isSameSessionKey(candidateSessionKey, sessionKey)) {
                continue;
            }
            const hasExact = Boolean(requestId && state.pending.has(requestId));
            const fallbackEntry =
                hasExact || requestId
                    ? undefined
                    : state.pending
                          .entries()
                          .find(([, boundary]) => boundary === requestBoundary);
            if (hasExact && requestId) {
                state.pending.delete(requestId);
            } else if (!hasRemovedFallback && fallbackEntry) {
                state.pending.delete(fallbackEntry[0]);
                hasRemovedFallback = true;
            } else {
                continue;
            }
            settlementSessionKey ||= candidateSessionKey;
            changedSessionKeys.add(candidateSessionKey);
        }
        if (!isContinuation) {
            const owner = settlementSessionKey || this.normalizeSessionKey(sessionKey);
            const state = this.#states.get(owner) || {
                pending: new Map<string, number>(),
            };
            state.settled = Math.max(state.settled ?? -1, requestBoundary);
            this.#states.set(owner, state);
            changedSessionKeys.add(owner);
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
