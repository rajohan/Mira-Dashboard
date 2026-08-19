import { describe, expect, test } from "bun:test";

import {
    liveHistoryArchiveQueryKey,
    liveHistoryHeadQueryKey,
    mergeLiveHistoryRows,
} from "./liveHistory.ts";

describe("live history", () => {
    test("isolates archives while keeping live heads under their feature root", () => {
        const featureKey = ["reports", "list"] as const;

        expect(liveHistoryArchiveQueryKey(featureKey)).toEqual([
            "live-history-archive",
            ...featureKey,
        ]);
        expect(liveHistoryHeadQueryKey(featureKey)).toEqual([...featureKey, "live-head"]);
    });

    test("places current rows first and retains unique archive rows", () => {
        const rows = mergeLiveHistoryRows(
            [
                { id: "new", state: "running" },
                { id: "shared", state: "succeeded" },
            ],
            [
                { id: "shared", state: "queued" },
                { id: "old", state: "succeeded" },
            ],
            ({ id }) => id
        );

        expect(rows).toEqual([
            { id: "new", state: "running" },
            { id: "shared", state: "succeeded" },
            { id: "old", state: "succeeded" },
        ]);
    });
});
