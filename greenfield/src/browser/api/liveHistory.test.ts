import { describe, expect, test } from "bun:test";

import {
    createLiveHistoryAccumulator,
    liveHistoryArchiveQueryKey,
    liveHistoryHeadQueryKey,
    mergeLiveHistoryRows,
} from "./liveHistory.ts";

describe("live history", () => {
    test("retains rows displaced from successive live heads", () => {
        const accumulate = createLiveHistoryAccumulator<{ id: string }>(({ id }) => id);

        expect(accumulate([{ id: "new-1" }, { id: "old" }], [{ id: "old" }])).toEqual([
            { id: "new-1" },
            { id: "old" },
        ]);
        expect(accumulate([{ id: "new-2" }, { id: "new-1" }], [{ id: "old" }])).toEqual([
            { id: "new-2" },
            { id: "new-1" },
            { id: "old" },
        ]);
        expect(accumulate([{ id: "new-4" }, { id: "new-3" }], [{ id: "old" }])).toEqual([
            { id: "new-4" },
            { id: "new-3" },
            { id: "new-2" },
            { id: "new-1" },
            { id: "old" },
        ]);
    });

    test("evicts retained live rows after a confirmed deletion", () => {
        const accumulate = createLiveHistoryAccumulator<{ id: string }>(({ id }) => id);
        accumulate([{ id: "new" }], []);

        expect(accumulate([], [], new Set(["new"]))).toEqual([]);
    });

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
