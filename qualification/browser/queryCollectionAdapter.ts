import { QueryClient, type QueryKey } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection, type UpdateMutationFnParams } from "@tanstack/react-db";

export interface QualificationVersionedEntity {
    id: string;
    version: number;
}

export type QualificationCollectionDelta<T extends QualificationVersionedEntity> =
    | { type: "delete"; id: string }
    | { type: "upsert"; value: T };

export interface QualificationPersistedUpdate<T extends QualificationVersionedEntity> {
    modified: T;
    original: T;
}

export interface QualificationQueryCollectionOptions<
    T extends QualificationVersionedEntity,
> {
    fetchSnapshot: (signal: AbortSignal) => Promise<readonly T[]>;
    id: string;
    persistUpdates?: (
        updates: readonly QualificationPersistedUpdate<T>[]
    ) => Promise<void>;
    queryClient: QueryClient;
    queryKey: QueryKey;
}

export class QualificationCollectionConflictError extends Error {
    readonly _tag = "QualificationCollectionConflictError";
}

/**
 * Qualification-only seam around the current pre-1.0 Query Collection API.
 * It exercises the intended browser ownership without creating production code.
 * @param options Query client, snapshot, and persistence dependencies.
 * @returns Qualification collection adapter.
 */
export function createQualificationQueryCollection<
    T extends QualificationVersionedEntity,
>(options: QualificationQueryCollectionOptions<T>) {
    const stableQueryKey = [...options.queryKey];
    let disposed = false;
    const onUpdate = options.persistUpdates
        ? async ({ transaction }: UpdateMutationFnParams<T, string>) => {
              await options.persistUpdates?.(
                  transaction.mutations.map(({ modified, original }) => ({
                      modified,
                      original,
                  }))
              );
          }
        : undefined;

    const collection = createCollection(
        queryCollectionOptions<T, unknown, QueryKey, string>({
            id: options.id,
            queryClient: options.queryClient,
            queryFn: async ({ signal }) => [...(await options.fetchSnapshot(signal))],
            queryKey: stableQueryKey,
            getKey: (entity: T) => entity.id,
            ...(onUpdate ? { onUpdate } : {}),
        })
    );

    function assertActive(): void {
        if (disposed) {
            throw new Error(`Qualification collection ${options.id} is disposed`);
        }
    }

    return {
        applyBatch(deltas: readonly QualificationCollectionDelta<T>[]): void {
            assertActive();
            collection.utils.writeBatch(() => {
                for (const delta of deltas) {
                    if (delta.type === "delete") {
                        collection.utils.writeDelete(delta.id);
                    } else {
                        collection.utils.writeUpsert(delta.value);
                    }
                }
            });
        },
        async dispose(): Promise<void> {
            if (disposed) return;
            disposed = true;
            await collection.cleanup();
            options.queryClient.removeQueries({
                exact: true,
                queryKey: stableQueryKey,
            });
        },
        get(id: string): T | undefined {
            assertActive();
            return collection.get(id);
        },
        get isDisposed(): boolean {
            return disposed;
        },
        preload(): Promise<void> {
            assertActive();
            return collection.preload();
        },
        async refetchAuthoritative(): Promise<void> {
            assertActive();
            await collection.utils.refetch({ throwOnError: true });
        },
        rows(): readonly T[] {
            assertActive();
            return collection.toArray;
        },
        subscribe(listener: (rows: readonly T[]) => void): () => void {
            assertActive();
            const subscription = collection.subscribeChanges(
                () => listener(collection.toArray),
                { includeInitialState: true }
            );
            return () => subscription.unsubscribe();
        },
        async updateOptimistically(
            id: string,
            expectedVersion: number,
            changes: Partial<T>
        ): Promise<void> {
            assertActive();
            if (!options.persistUpdates) {
                throw new Error(
                    `Qualification collection ${options.id} has no mutation persistence`
                );
            }
            const current = collection.get(id);
            if (!current || current.version !== expectedVersion) {
                throw new QualificationCollectionConflictError(
                    `Expected ${id} at version ${expectedVersion}`
                );
            }
            if (changes.id !== undefined && changes.id !== id) {
                throw new QualificationCollectionConflictError(
                    "An optimistic update cannot change its entity id"
                );
            }

            const transaction = collection.update(id, (draft) => {
                Object.assign(draft, changes);
            });
            await transaction.isPersisted.promise;
        },
    };
}
