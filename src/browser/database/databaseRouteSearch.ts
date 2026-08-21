import * as v from "valibot";

const databaseRouteSearchSchema = v.strictObject({
    source: v.picklist(["sqlite", "postgresql"]),
});

/** Current reviewed database source selected by the route. */
export type DatabaseRouteSearch = v.InferOutput<typeof databaseRouteSearchSchema>;

/**
 * Normalizes untrusted route input to one reviewed database source.
 * @param search Untrusted search object parsed by TanStack Router.
 * @returns The canonical source selection, defaulting to Dashboard SQLite.
 */
export function normalizeDatabaseSearch(search: unknown): DatabaseRouteSearch {
    const candidate =
        typeof search === "object" &&
        search !== null &&
        !Array.isArray(search) &&
        "source" in search
            ? search.source
            : undefined;
    const source =
        candidate === "sqlite" || candidate === "postgresql" ? candidate : "sqlite";
    return v.parse(databaseRouteSearchSchema, { source });
}
