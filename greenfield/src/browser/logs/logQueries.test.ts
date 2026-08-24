import { describe, expect, test } from "bun:test";

import type { LogClient } from "./logClient.ts";
import { logSnapshotQueryOptions } from "./logQueries.ts";

const client = Object.freeze({}) as LogClient;

describe("log snapshot query identity", () => {
    test("never carries rows across source or search query keys", () => {
        const sourceA = logSnapshotQueryOptions(
            client,
            { mode: "tail", sourceId: "dashboard.web.stdout" },
            true
        );
        const sourceB = logSnapshotQueryOptions(
            client,
            { mode: "tail", sourceId: "openclaw.20260809" },
            true
        );
        const search = logSnapshotQueryOptions(
            client,
            {
                mode: "search",
                query: "worker",
                sourceId: "openclaw.20260809",
            },
            true
        );

        expect(sourceA.queryKey).not.toEqual(sourceB.queryKey);
        expect(sourceB.queryKey).not.toEqual(search.queryKey);
        expect(sourceA.placeholderData).toBeUndefined();
        expect(sourceB.placeholderData).toBeUndefined();
        expect(search.placeholderData).toBeUndefined();
    });
});
