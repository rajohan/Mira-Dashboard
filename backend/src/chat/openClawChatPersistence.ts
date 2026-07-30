import type { OpenClawRuntimeSnapshot } from "../../../contracts/chat.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import {
    isExactSessionKey,
    isSameSessionKey,
    normalizedSessionKey,
} from "./openClawChatIdentity.ts";
import type { OpenClawChatRuntimeMetricsRecorder } from "./openClawChatMetrics.ts";

const logger = createStructuredLogger("openclaw-chat");

/** Maximum number of persisted runtime sessions retained per Gateway scope. */
export const MAX_CHAT_RUNTIME_SESSIONS = 50;

/** Debounce applied to non-terminal runtime snapshot writes. */
export const OPENCLAW_CHAT_PERSIST_DEBOUNCE_MS = 250;

/** Storage boundary for the latest bounded replay of each chat session. */
export interface OpenClawChatSnapshotStore {
    clear(): void;
    delete(sessionKey: string): void;
    keys(): string[];
    load(sessionKey: string): OpenClawRuntimeSnapshot | undefined;
    maximumSequence(): number;
    promote(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        sourceSnapshot: OpenClawRuntimeSnapshot,
        canonicalSnapshot: OpenClawRuntimeSnapshot
    ): void;
    save(sessionKey: string, snapshot: OpenClawRuntimeSnapshot): void;
}

interface OpenClawChatPersistenceCoordinatorOptions {
    ensureSessionLoaded: (sessionKey: string) => boolean;
    metrics: OpenClawChatRuntimeMetricsRecorder;
    snapshotFromMemory: (sessionKey: string) => OpenClawRuntimeSnapshot;
}

export type OpenClawChatSnapshotLoadResult =
    | {
          ok: true;
          snapshot: OpenClawRuntimeSnapshot | undefined;
      }
    | {
          ok: false;
      };

/**
 * Owns resilient snapshot-store state: hydration indexes, tombstones,
 * coalesced writes, retries, and atomic alias promotion.
 */
export class OpenClawChatPersistenceCoordinator {
    readonly #hydratedSessionLookups = new Set<string>();
    readonly #loadedStoreKeys = new Set<string>();
    readonly #pendingDeleteKeys = new Set<string>();
    readonly #pendingPersistence = new Set<string>();
    readonly #pendingSessionClears = new Set<string>();
    readonly #store: OpenClawChatSnapshotStore | undefined;
    readonly #ensureSessionLoaded: (sessionKey: string) => boolean;
    readonly #metrics: OpenClawChatRuntimeMetricsRecorder;
    readonly #snapshotFromMemory: (sessionKey: string) => OpenClawRuntimeSnapshot;
    #persistenceTimer: ReturnType<typeof setTimeout> | undefined;
    #storeClearPending = false;
    #storeFailureReported = false;

    constructor(
        store: OpenClawChatSnapshotStore | undefined,
        options: OpenClawChatPersistenceCoordinatorOptions
    ) {
        this.#store = store;
        this.#ensureSessionLoaded = options.ensureSessionLoaded;
        this.#metrics = options.metrics;
        this.#snapshotFromMemory = options.snapshotFromMemory;
    }

    /**
     * Whether a durable snapshot store is configured.
     * @returns True when persistence is enabled.
     */
    get enabled(): boolean {
        return Boolean(this.#store);
    }

    #reportStoreFailure(error: unknown): void {
        if (this.#storeFailureReported) {
            return;
        }
        this.#storeFailureReported = true;
        logger.warn("openclaw_chat.snapshot_persistence_failed", { error });
    }

    #recordStoreSuccess(): void {
        this.#storeFailureReported = false;
    }

    #cancelPersistenceTimer(): void {
        if (!this.#persistenceTimer) {
            return;
        }
        clearTimeout(this.#persistenceTimer);
        this.#persistenceTimer = undefined;
    }

    #writeStore(operation: (store: OpenClawChatSnapshotStore) => void): void {
        const store = this.#store;
        if (!store) {
            throw new Error("OpenClaw chat snapshot store is unavailable");
        }
        try {
            operation(store);
            this.#metrics.recordPersistenceWrite(true);
        } catch (error) {
            this.#metrics.recordPersistenceWrite(false);
            throw error;
        }
    }

    #retryStoreClear(): boolean {
        if (!this.#store || !this.#storeClearPending) {
            return true;
        }
        try {
            this.#writeStore((store) => store.clear());
            this.#storeClearPending = false;
            this.#pendingDeleteKeys.clear();
            this.#pendingSessionClears.clear();
            this.#loadedStoreKeys.clear();
            this.#recordStoreSuccess();
            return true;
        } catch (error) {
            this.#reportStoreFailure(error);
            return false;
        }
    }

    #hasPendingExactDelete(sessionKey: string): boolean {
        return this.#pendingDeleteKeys
            .values()
            .some((candidate) => isExactSessionKey(candidate, sessionKey));
    }

    #retryExactDelete(sessionKey: string): boolean {
        if (!this.#store || !this.#hasPendingExactDelete(sessionKey)) {
            return true;
        }
        let hasFailed = false;
        for (const pendingKey of this.#pendingDeleteKeys) {
            if (!isExactSessionKey(pendingKey, sessionKey)) {
                continue;
            }
            try {
                this.#writeStore((store) => store.delete(pendingKey));
                this.#pendingDeleteKeys.delete(pendingKey);
                this.#loadedStoreKeys.delete(pendingKey);
                this.#recordStoreSuccess();
            } catch (error) {
                hasFailed = true;
                this.#reportStoreFailure(error);
            }
        }
        return !hasFailed;
    }

    #retryPendingSessionClear(sessionKey: string): boolean {
        if (
            !this.#store ||
            this.#pendingSessionClears
                .values()
                .every((candidate) => !isSameSessionKey(candidate, sessionKey))
        ) {
            return true;
        }
        const storedKeys = this.storedSessionKeys();
        if (!storedKeys) {
            return false;
        }
        const matchingKeys = new Set(
            [
                ...this.#pendingSessionClears.values(),
                ...this.#pendingDeleteKeys.values(),
                ...storedKeys.filter((candidate) =>
                    isSameSessionKey(candidate, sessionKey)
                ),
            ].filter((candidate) => isSameSessionKey(candidate, sessionKey))
        );
        let hasFailed = false;
        for (const matchingKey of matchingKeys) {
            try {
                this.#writeStore((store) => store.delete(matchingKey));
                this.#pendingDeleteKeys.delete(matchingKey);
                this.#loadedStoreKeys.delete(matchingKey);
                this.#recordStoreSuccess();
            } catch (error) {
                hasFailed = true;
                this.#reportStoreFailure(error);
            }
        }
        if (hasFailed) {
            return false;
        }
        for (const pendingKey of this.#pendingDeleteKeys) {
            if (isSameSessionKey(pendingKey, sessionKey)) {
                this.#pendingDeleteKeys.delete(pendingKey);
            }
        }
        for (const pendingClear of this.#pendingSessionClears) {
            if (isSameSessionKey(pendingClear, sessionKey)) {
                this.#pendingSessionClears.delete(pendingClear);
            }
        }
        return true;
    }

    /**
     * Reads the durable sequence watermark without hydrating transcript rows.
     * @returns The watermark, zero without a store, or undefined on failure.
     */
    maximumSequence(): number | undefined {
        if (!this.#store) {
            return 0;
        }
        try {
            const maximumSequence = this.#store.maximumSequence();
            if (!Number.isSafeInteger(maximumSequence) || maximumSequence < 0) {
                throw new Error("Runtime snapshot sequence watermark is invalid");
            }
            this.#recordStoreSuccess();
            return maximumSequence;
        } catch (error) {
            this.#reportStoreFailure(error);
            return undefined;
        }
    }

    /**
     * Lists persisted keys after retrying any pending whole-store clear.
     * @returns Keys, an empty list without a store, or undefined on failure.
     */
    storedSessionKeys(): string[] | undefined {
        if (!this.#store) {
            return [];
        }
        if (!this.#retryStoreClear()) {
            return undefined;
        }
        try {
            const keys = this.#store.keys();
            this.#recordStoreSuccess();
            return keys;
        } catch (error) {
            this.#reportStoreFailure(error);
            return undefined;
        }
    }

    /**
     * Retries tombstones that must settle before one session can hydrate.
     * @param sessionKey Session key to prepare.
     * @returns Whether the session is safe to hydrate.
     */
    prepareSession(sessionKey: string): boolean {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        return (
            this.#retryPendingSessionClear(storageSessionKey) &&
            this.#retryExactDelete(storageSessionKey)
        );
    }

    /**
     * Whether one normalized key has already been loaded into process memory.
     * @param sessionKey Session key to inspect.
     * @returns Whether the key is loaded.
     */
    isLoaded(sessionKey: string): boolean {
        return this.#loadedStoreKeys.has(normalizedSessionKey(sessionKey));
    }

    /**
     * Whether one normalized lookup has already been resolved against the store.
     * @param sessionKey Session key to inspect.
     * @returns Whether the lookup has completed.
     */
    isHydratedLookup(sessionKey: string): boolean {
        return this.#hydratedSessionLookups.has(normalizedSessionKey(sessionKey));
    }

    /**
     * Marks one normalized lookup as resolved against the store.
     * @param sessionKey Session key to mark.
     */
    markHydratedLookup(sessionKey: string): void {
        this.#hydratedSessionLookups.add(normalizedSessionKey(sessionKey));
    }

    /**
     * Allows a failed lookup or promotion to be retried.
     * @param sessionKey Session key to forget.
     */
    forgetHydratedLookup(sessionKey: string): void {
        this.#hydratedSessionLookups.delete(normalizedSessionKey(sessionKey));
    }

    /**
     * Whether a pending exact-delete tombstone protects one stored key.
     * @param sessionKey Session key to inspect.
     * @returns Whether a delete is pending.
     */
    hasPendingDelete(sessionKey: string): boolean {
        return this.#hasPendingExactDelete(sessionKey);
    }

    /**
     * Loads one exact stored key and records its process-local hydration state.
     * @param sessionKey Exact stored session key.
     * @returns A discriminated result so an empty snapshot is not a failure.
     */
    load(sessionKey: string): OpenClawChatSnapshotLoadResult {
        if (!this.#store) {
            return { ok: true, snapshot: undefined };
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        try {
            const snapshot = this.#store.load(sessionKey);
            this.#loadedStoreKeys.add(storageSessionKey);
            this.#recordStoreSuccess();
            return { ok: true, snapshot };
        } catch (error) {
            this.#reportStoreFailure(error);
            return { ok: false };
        }
    }

    /**
     * Deletes one exact persisted snapshot and retains a retry tombstone on failure.
     * @param sessionKey Session key to delete.
     * @returns Whether the delete settled.
     */
    deleteSession(sessionKey: string): boolean {
        if (!this.#store) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        this.#pendingDeleteKeys.add(storageSessionKey);
        try {
            this.#writeStore((store) => store.delete(storageSessionKey));
            this.#pendingDeleteKeys.delete(storageSessionKey);
            this.#loadedStoreKeys.delete(storageSessionKey);
            this.#recordStoreSuccess();
            return true;
        } catch (error) {
            this.#reportStoreFailure(error);
            return false;
        }
    }

    #persistSession(sessionKey: string): boolean {
        if (!this.#store) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        if (
            !this.#retryStoreClear() ||
            !this.prepareSession(storageSessionKey) ||
            !this.#ensureSessionLoaded(storageSessionKey)
        ) {
            return false;
        }
        const snapshot = this.#snapshotFromMemory(storageSessionKey);
        try {
            if (snapshot.events.length === 0) {
                return this.deleteSession(storageSessionKey);
            }
            this.#writeStore((store) => store.save(storageSessionKey, snapshot));
            for (const pendingKey of this.#pendingDeleteKeys) {
                if (isExactSessionKey(pendingKey, storageSessionKey)) {
                    this.#pendingDeleteKeys.delete(pendingKey);
                }
            }
            this.#loadedStoreKeys.add(storageSessionKey);
            this.#recordStoreSuccess();
            return true;
        } catch (error) {
            this.#reportStoreFailure(error);
            return false;
        }
    }

    /**
     * Immediately persists one session and retains it in the retry queue on failure.
     * @param sessionKey Session key to persist.
     * @returns Whether the write settled.
     */
    flushSession(sessionKey: string): boolean {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const didPersist = this.#persistSession(storageSessionKey);
        if (didPersist) {
            this.#pendingPersistence.delete(storageSessionKey);
        } else {
            this.#pendingPersistence.add(storageSessionKey);
        }
        if (this.#pendingPersistence.size === 0) {
            this.#cancelPersistenceTimer();
        }
        return didPersist;
    }

    #flushPendingPersistence(): boolean {
        this.#cancelPersistenceTimer();
        const sessionKeys = this.#pendingPersistence.values().toArray();
        let didFlushAll = true;
        for (const sessionKey of sessionKeys) {
            didFlushAll = this.flushSession(sessionKey) && didFlushAll;
        }
        return didFlushAll;
    }

    /**
     * Coalesces a non-terminal snapshot write behind the persistence debounce.
     * @param sessionKey Session key to queue.
     */
    queueSession(sessionKey: string): void {
        if (!this.#store) {
            return;
        }
        this.#pendingPersistence.add(normalizedSessionKey(sessionKey));
        if (this.#persistenceTimer) {
            return;
        }
        this.#persistenceTimer = setTimeout(() => {
            this.#persistenceTimer = undefined;
            this.#flushPendingPersistence();
        }, OPENCLAW_CHAT_PERSIST_DEBOUNCE_MS);
    }

    /**
     * Removes one session from the coalesced write queue.
     * @param sessionKey Session key to remove.
     */
    cancelPendingSession(sessionKey: string): void {
        this.#pendingPersistence.delete(normalizedSessionKey(sessionKey));
        if (this.#pendingPersistence.size === 0) {
            this.#cancelPersistenceTimer();
        }
    }

    /**
     * Returns pending write keys without exposing the mutable coordinator set.
     * @returns Pending normalized session keys.
     */
    pendingSessionKeys(): string[] {
        return this.#pendingPersistence.values().toArray();
    }

    /**
     * Atomically promotes persisted alias snapshots and updates hydration indexes.
     * @param sourceSessionKey Source alias key.
     * @param canonicalSessionKey Canonical destination key.
     * @param sourceSnapshot Snapshot retained under the source key.
     * @param canonicalSnapshot Snapshot retained under the canonical key.
     * @returns Whether the promotion persisted or no store is configured.
     */
    promote(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        sourceSnapshot: OpenClawRuntimeSnapshot,
        canonicalSnapshot: OpenClawRuntimeSnapshot
    ): boolean {
        if (!this.#store) {
            return true;
        }
        const sourceStorageKey = normalizedSessionKey(sourceSessionKey);
        const canonicalStorageKey = normalizedSessionKey(canonicalSessionKey);
        if (
            !this.#retryStoreClear() ||
            !this.#retryPendingSessionClear(sourceStorageKey) ||
            !this.#retryPendingSessionClear(canonicalStorageKey) ||
            !this.#retryExactDelete(sourceStorageKey) ||
            !this.#retryExactDelete(canonicalStorageKey)
        ) {
            return false;
        }
        try {
            this.#writeStore((store) =>
                store.promote(
                    sourceStorageKey,
                    canonicalStorageKey,
                    sourceSnapshot,
                    canonicalSnapshot
                )
            );
            for (const pendingKey of this.#pendingDeleteKeys) {
                if (
                    isExactSessionKey(pendingKey, sourceStorageKey) ||
                    isExactSessionKey(pendingKey, canonicalStorageKey)
                ) {
                    this.#pendingDeleteKeys.delete(pendingKey);
                }
            }
            if (sourceSnapshot.events.length === 0) {
                this.#loadedStoreKeys.delete(sourceStorageKey);
            } else {
                this.#loadedStoreKeys.add(sourceStorageKey);
            }
            if (canonicalSnapshot.events.length === 0) {
                this.#loadedStoreKeys.delete(canonicalStorageKey);
            } else {
                this.#loadedStoreKeys.add(canonicalStorageKey);
            }
            this.markHydratedLookup(sourceStorageKey);
            this.markHydratedLookup(canonicalStorageKey);
            this.#recordStoreSuccess();
            return true;
        } catch (error) {
            this.#reportStoreFailure(error);
            return false;
        }
    }

    /**
     * Adds a broad equivalent-session tombstone before clear discovery begins.
     * @param sessionKey Session key whose equivalents must be cleared.
     */
    beginSessionClear(sessionKey: string): void {
        if (this.#store) {
            this.#pendingSessionClears.add(normalizedSessionKey(sessionKey));
        }
    }

    /**
     * Settles or retains a broad equivalent-session tombstone after deletion attempts.
     * @param sessionKey Session key whose equivalents were cleared.
     * @param didClearAll Whether every discovered key was deleted.
     */
    finishSessionClear(sessionKey: string, didClearAll: boolean): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        if (!this.#store) {
            return;
        }
        if (!didClearAll) {
            this.#pendingSessionClears.add(storageSessionKey);
            return;
        }
        for (const pendingKey of this.#pendingDeleteKeys) {
            if (isSameSessionKey(pendingKey, storageSessionKey)) {
                this.#pendingDeleteKeys.delete(pendingKey);
            }
        }
        for (const pendingClear of this.#pendingSessionClears) {
            if (isSameSessionKey(pendingClear, storageSessionKey)) {
                this.#pendingSessionClears.delete(pendingClear);
            }
        }
    }

    /**
     * Drops persistence indexes for one process-local replay eviction.
     * @param sessionKey Session key evicted from memory.
     */
    forgetMemorySession(sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        this.cancelPendingSession(storageSessionKey);
        this.#loadedStoreKeys.delete(storageSessionKey);
        for (const lookup of this.#hydratedSessionLookups) {
            if (isSameSessionKey(lookup, storageSessionKey)) {
                this.#hydratedSessionLookups.delete(lookup);
            }
        }
    }

    /** Drops all process-local hydration indexes while retaining durable rows. */
    clearMemoryIndexes(): void {
        this.#hydratedSessionLookups.clear();
        this.#loadedStoreKeys.clear();
    }

    /**
     * Flushes clear/delete/write retries at a lifecycle boundary.
     * @returns Whether every pending store operation settled.
     */
    flush(): boolean {
        this.#cancelPersistenceTimer();
        if (!this.#retryStoreClear()) {
            return false;
        }
        let didFlushAll = true;
        for (const pendingClear of this.#pendingSessionClears) {
            didFlushAll = this.#retryPendingSessionClear(pendingClear) && didFlushAll;
        }
        for (const pendingKey of this.#pendingDeleteKeys) {
            didFlushAll = this.#retryExactDelete(pendingKey) && didFlushAll;
        }
        didFlushAll = this.#flushPendingPersistence() && didFlushAll;
        return (
            didFlushAll &&
            !this.#storeClearPending &&
            this.#pendingSessionClears.size === 0 &&
            this.#pendingDeleteKeys.size === 0 &&
            this.#pendingPersistence.size === 0
        );
    }

    /** Clears all pending and durable replay state, retaining a retry on failure. */
    clear(): void {
        this.#cancelPersistenceTimer();
        this.#pendingPersistence.clear();
        this.clearMemoryIndexes();
        if (!this.#store) {
            return;
        }
        this.#storeClearPending = true;
        this.#retryStoreClear();
    }
}
