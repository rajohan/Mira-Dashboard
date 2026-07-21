export interface OpenClawChatRequestBoundaryMetadata {
    pendingRequestBoundaries?: Record<string, number>;
    requestBoundary?: number;
}

interface RequestBoundaryState {
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
    return {
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
        let settlementSessionKey: string | undefined;
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
            } else if (fallbackEntry) {
                state.pending.delete(fallbackEntry[0]);
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
