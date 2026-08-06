import { describe, expect, test } from "bun:test";

import { QueryClient } from "@tanstack/query-core";

import {
    createQualificationQueryCollection,
    QualificationCollectionConflictError,
    type QualificationPersistedUpdate,
} from "./queryCollectionAdapter";

interface QualificationItem {
    id: string;
    label: string;
    version: number;
}

const collectionKey = ["qualification", "items"] as const;

describe("TanStack DB Query Collection adapter qualification", () => {
    test("replaces snapshots and synchronizes direct batches with Query cache", async () => {
        const queryClient = createQueryClient();
        let authoritative: QualificationItem[] = [
            { id: "a", label: "server-a", version: 1 },
            { id: "b", label: "server-b", version: 1 },
        ];
        const adapter = createQualificationQueryCollection({
            id: "qualification-items",
            queryClient,
            queryKey: collectionKey,
            fetchSnapshot: () => Promise.resolve(structuredClone(authoritative)),
        });

        try {
            await adapter.preload();
            expect(project(adapter.rows())).toEqual(authoritative);
            expect(cachedItems(queryClient)).toEqual(authoritative);

            adapter.applyBatch([
                {
                    type: "upsert",
                    value: { id: "a", label: "delta-a", version: 2 },
                },
                { type: "delete", id: "b" },
                {
                    type: "upsert",
                    value: { id: "c", label: "delta-c", version: 1 },
                },
            ]);
            const deltaRows = [
                { id: "a", label: "delta-a", version: 2 },
                { id: "c", label: "delta-c", version: 1 },
            ];
            expect(project(adapter.rows())).toEqual(deltaRows);
            expect(cachedItems(queryClient)).toEqual(deltaRows);

            authoritative = [{ id: "a", label: "server-wins", version: 3 }];
            await adapter.refetchAuthoritative();
            expect(project(adapter.rows())).toEqual(authoritative);
            expect(cachedItems(queryClient)).toEqual(authoritative);
        } finally {
            await adapter.dispose();
        }
    });

    test("lets the authoritative refetch win an optimistic version conflict", async () => {
        const queryClient = createQueryClient();
        const persistence = Promise.withResolvers<void>();
        const persistedUpdates: QualificationPersistedUpdate<QualificationItem>[][] = [];
        const authoritative = [
            { id: "a", label: "authoritative", version: 2 },
        ] satisfies QualificationItem[];
        const adapter = createQualificationQueryCollection({
            id: "qualification-optimistic-items",
            queryClient,
            queryKey: collectionKey,
            fetchSnapshot: () => Promise.resolve(structuredClone(authoritative)),
            persistUpdates: async (updates) => {
                persistedUpdates.push([...updates]);
                await persistence.promise;
            },
        });

        try {
            await adapter.preload();
            const update = adapter.updateOptimistically("a", 2, {
                label: "speculative",
                version: 3,
            });
            expect(project(adapter.rows())).toEqual([
                { id: "a", label: "speculative", version: 3 },
            ]);

            persistence.resolve();
            await update;
            expect(persistedUpdates).toEqual([
                [
                    {
                        modified: { id: "a", label: "speculative", version: 3 },
                        original: { id: "a", label: "authoritative", version: 2 },
                    },
                ],
            ]);
            expect(project(adapter.rows())).toEqual(authoritative);

            let conflict: unknown;
            try {
                await adapter.updateOptimistically("a", 1, {
                    label: "stale",
                    version: 2,
                });
            } catch (error) {
                conflict = error;
            }
            expect(conflict).toBeInstanceOf(QualificationCollectionConflictError);
            expect(project(adapter.rows())).toEqual(authoritative);
        } finally {
            await adapter.dispose();
        }
    });

    test("forwards AbortSignal and removes an in-flight query on teardown", async () => {
        const queryClient = createQueryClient();
        const fetchStarted = Promise.withResolvers<AbortSignal>();
        const firstAdapter = createQualificationQueryCollection<QualificationItem>({
            id: "qualification-route-items",
            queryClient,
            queryKey: collectionKey,
            fetchSnapshot: (signal) => {
                fetchStarted.resolve(signal);
                return new Promise((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(new DOMException("Aborted", "AbortError")),
                        { once: true }
                    );
                });
            },
        });

        const preload = firstAdapter.preload();
        const signal = await fetchStarted.promise;
        expect(signal.aborted).toBeFalse();
        await firstAdapter.dispose();
        await preload;
        expect(signal.aborted).toBeTrue();
        expect(firstAdapter.isDisposed).toBeTrue();
        expect(cachedItems(queryClient)).toBeUndefined();
    });

    test("tears down route subscriptions without duplicate rows or listeners", async () => {
        const queryClient = createQueryClient();
        const adapter = createQualificationQueryCollection({
            id: "qualification-route-items",
            queryClient,
            queryKey: collectionKey,
            fetchSnapshot: () =>
                Promise.resolve([
                    { id: "a", label: "first-route", version: 1 },
                ] satisfies QualificationItem[]),
        });
        try {
            await adapter.preload();
            let firstRouteNotifications = 0;
            const unsubscribeFirstRoute = adapter.subscribe(() => {
                firstRouteNotifications += 1;
            });
            adapter.applyBatch([
                {
                    type: "upsert",
                    value: { id: "a", label: "first-update", version: 2 },
                },
            ]);
            const notificationsAtTeardown = firstRouteNotifications;
            unsubscribeFirstRoute();

            let replacementRouteNotifications = 0;
            const unsubscribeReplacementRoute = adapter.subscribe(() => {
                replacementRouteNotifications += 1;
            });
            adapter.applyBatch([
                {
                    type: "upsert",
                    value: { id: "a", label: "single-row", version: 3 },
                },
            ]);
            unsubscribeReplacementRoute();

            expect(notificationsAtTeardown).toBe(2);
            expect(firstRouteNotifications).toBe(2);
            expect(replacementRouteNotifications).toBe(2);
            expect(project(adapter.rows())).toEqual([
                { id: "a", label: "single-row", version: 3 },
            ]);
            expect(cachedItems(queryClient)).toEqual([
                { id: "a", label: "single-row", version: 3 },
            ]);
        } finally {
            await adapter.dispose();
        }
        expect(cachedItems(queryClient)).toBeUndefined();
    });

    test("runs against the exact installed TanStack dependency set", async () => {
        expect(await readInstalledVersions()).toEqual({
            "@tanstack/db": "0.6.17",
            "@tanstack/query-core": "5.101.4",
            "@tanstack/query-db-collection": "1.2.1",
            "@tanstack/react-db": "0.1.95",
        });
    });
});

function createQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                retry: false,
            },
        },
    });
}

function project(items: readonly QualificationItem[]): QualificationItem[] {
    return items.map(({ id, label, version }) => ({ id, label, version }));
}

function cachedItems(queryClient: QueryClient): QualificationItem[] | undefined {
    return queryClient.getQueryData<QualificationItem[]>(collectionKey);
}

async function readInstalledVersions(): Promise<Record<string, string>> {
    const packageNames = [
        "@tanstack/db",
        "@tanstack/query-core",
        "@tanstack/query-db-collection",
        "@tanstack/react-db",
    ] as const;
    const versions: Record<string, string> = {};
    for (const packageName of packageNames) {
        const packageJsonUrl = new URL(
            `../../node_modules/${packageName}/package.json`,
            import.meta.url
        );
        const parsed: unknown = JSON.parse(await Bun.file(packageJsonUrl).text());
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            !("version" in parsed) ||
            typeof parsed.version !== "string"
        ) {
            throw new Error(`${packageName} has no package version`);
        }
        versions[packageName] = parsed.version;
    }
    return versions;
}
