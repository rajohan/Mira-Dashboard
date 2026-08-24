import type { GatewaySessionTranscriptLifecyclePort } from "../gatewaySessions/transcriptLifecycle.ts";

export type ChatTranscriptBoundaryAction =
    | "compact"
    | "delete"
    | "new"
    | "reset"
    | "transport";

export interface ChatTranscriptLifecycleEvent {
    readonly compacted?: boolean;
    readonly occurredAtMs: number;
    readonly reason: Extract<
        ChatTranscriptBoundaryAction,
        "compact" | "delete" | "new" | "reset"
    >;
    readonly sessionId?: string;
    readonly sessionKey?: string;
    readonly updatedAtMs?: number;
}

export interface ChatTranscriptGenerationChange {
    readonly currentGeneration: number;
    readonly previousGeneration: number;
    readonly reason: ChatTranscriptBoundaryAction;
    readonly retiredRunIds: readonly string[];
    readonly sessionKey: string;
    readonly status: "absent" | "ready";
}

export interface ChatTranscriptSessionState {
    readonly currentGeneration: number;
    readonly providerSessionId?: string;
    readonly sessionKey: string;
    readonly status: "absent" | "control-pending" | "ready" | "reconciling";
}

export interface ChatTranscriptLifecycleStore {
    readonly beginTranscriptControl: GatewaySessionTranscriptLifecyclePort["beginControl"];
    readonly failTranscriptControl: GatewaySessionTranscriptLifecyclePort["failControl"];
    readonly listReconcilingTranscripts: () => readonly ChatTranscriptSessionState[];
    readonly markTranscriptTransportBoundary: (
        occurredAtMs?: number
    ) => Promise<readonly ChatTranscriptGenerationChange[]>;
    readonly observeTranscriptLifecycleEvent: (
        event: ChatTranscriptLifecycleEvent
    ) => Promise<readonly ChatTranscriptGenerationChange[]>;
    readonly observeTranscriptSnapshot: (
        snapshot: Parameters<GatewaySessionTranscriptLifecyclePort["observeSnapshot"]>[0]
    ) => Promise<readonly ChatTranscriptGenerationChange[]>;
    readonly reconcileTranscript: (input: {
        readonly providerSessionId?: string;
        readonly providerUpdatedAtMs?: number;
        readonly represented: boolean;
        readonly sessionKey: string;
        readonly observedAtMs: number;
    }) => Promise<readonly ChatTranscriptGenerationChange[]>;
    readonly readTranscriptState: (sessionKey: string) => ChatTranscriptSessionState;
    readonly settleUnchangedTranscriptControl: GatewaySessionTranscriptLifecyclePort["settleUnchangedControl"];
}

export interface ChatTranscriptLifecycleCoordinator extends GatewaySessionTranscriptLifecyclePort {
    readonly markTransportBoundary: (
        occurredAtMs?: number
    ) => Promise<readonly ChatTranscriptGenerationChange[]>;
    readonly observeLifecycleEvent: (
        event: ChatTranscriptLifecycleEvent
    ) => Promise<readonly ChatTranscriptGenerationChange[]>;
    readonly reconcile: ChatTranscriptLifecycleStore["reconcileTranscript"];
    readonly subscribe: (
        listener: (change: ChatTranscriptGenerationChange) => void | Promise<void>
    ) => () => void;
}

/**
 * Serializes lifecycle notifications after each durable pointer transaction commits.
 * @param store Durable transcript-generation boundary.
 * @returns A process-scoped serialized lifecycle coordinator.
 */
export function createChatTranscriptLifecycleCoordinator(
    store: ChatTranscriptLifecycleStore
): ChatTranscriptLifecycleCoordinator {
    const listeners = new Set<
        (change: ChatTranscriptGenerationChange) => void | Promise<void>
    >();
    let lane: Promise<unknown> = Promise.resolve();
    const publish = async (
        changes: readonly ChatTranscriptGenerationChange[]
    ): Promise<readonly ChatTranscriptGenerationChange[]> => {
        for (const change of changes) {
            for (const listener of listeners) await listener(change);
        }
        return changes;
    };
    const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = lane.then(operation, operation);
        lane = result.then(
            () => null,
            () => null
        );
        return result;
    };
    const coordinator: ChatTranscriptLifecycleCoordinator = {
        beginControl: (input) => serialized(() => store.beginTranscriptControl(input)),
        failControl: (input) => serialized(() => store.failTranscriptControl(input)),
        markTransportBoundary: (occurredAtMs) =>
            serialized(async () =>
                publish(await store.markTranscriptTransportBoundary(occurredAtMs))
            ),
        observeLifecycleEvent: (event) =>
            serialized(async () =>
                publish(await store.observeTranscriptLifecycleEvent(event))
            ),
        observeSnapshot: (snapshot) =>
            serialized(async () => {
                await publish(await store.observeTranscriptSnapshot(snapshot));
            }),
        reconcile: (input) =>
            serialized(async () => publish(await store.reconcileTranscript(input))),
        settleUnchangedControl: (input) =>
            serialized(() => store.settleUnchangedTranscriptControl(input)),
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return Object.freeze(coordinator);
}
