import { describe, expect, test } from "bun:test";

import {
    createLiveHistoryAccumulator,
    createScopedLiveHistoryAccumulator,
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

    test("retains the newest value after an updated live row is displaced", () => {
        const accumulate = createLiveHistoryAccumulator<{
            id: string;
            state: "completed" | "queued";
        }>(({ id }) => id);

        accumulate([{ id: "run", state: "queued" }], []);
        accumulate([{ id: "run", state: "completed" }], []);

        expect(accumulate([], [])).toEqual([{ id: "run", state: "completed" }]);
    });

    test("resets retained rows after an authoritative archive rebase", () => {
        const accumulate = createScopedLiveHistoryAccumulator<{ id: string }>(
            ({ id }) => id
        );
        accumulate("active", [{ id: "incident" }], [], undefined, 1);

        expect(accumulate("active", [], [], undefined, 2)).toEqual([]);
    });

    test("keeps displaced rows when later archive pages are appended", () => {
        const accumulate = createScopedLiveHistoryAccumulator<{ id: string }>(
            ({ id }) => id
        );
        const firstPage = { revision: 1 };
        accumulate("progress", [{ id: "displaced" }], [], undefined, firstPage);

        expect(
            accumulate("progress", [], [{ id: "older-page" }], undefined, firstPage)
        ).toEqual([{ id: "displaced" }, { id: "older-page" }]);
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
