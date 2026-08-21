import { type Layer, ManagedRuntime } from "effect";

import {
    databaseRuntimeLayer,
    type DatabaseRuntimeLayerOptions,
} from "./databaseService.ts";

/** Minimal process-owned lifecycle for one retained database runtime scope. */
export interface DatabaseRuntimeOwner {
    dispose(): Promise<void>;
    initialize(): Promise<void>;
}

/**
 * Creates one idempotent owner around a database-scoped Effect layer.
 * @param layer Scoped database layer without external requirements.
 * @returns Memoized initialize/dispose ownership boundary.
 * @internal
 */
export function createOwnedDatabaseLayer<A, E>(
    layer: Layer.Layer<A, E>
): DatabaseRuntimeOwner {
    const runtime = ManagedRuntime.make(layer);
    let initializePromise: Promise<void> | undefined;
    let disposePromise: Promise<void> | undefined;
    const initialize = async (): Promise<void> => {
        await runtime.context();
    };

    return Object.freeze({
        dispose() {
            disposePromise ??= runtime.dispose();
            return disposePromise;
        },
        initialize() {
            if (disposePromise !== undefined) {
                return Promise.reject(new Error("Database runtime owner is disposed"));
            }
            initializePromise ??= initialize();
            return initializePromise;
        },
    });
}

/**
 * Creates an idempotent owner for one migration-verified database runtime scope.
 * @param database Exact release/state database runtime options.
 * @returns Initialization and disposal boundary without leaking ORM authority.
 */
export function createDatabaseRuntimeOwner(
    database: DatabaseRuntimeLayerOptions
): DatabaseRuntimeOwner {
    return createOwnedDatabaseLayer(databaseRuntimeLayer(database));
}
