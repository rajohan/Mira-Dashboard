import { describe, expect, it, jest } from "bun:test";

import {
    CoalescedSnapshot,
    getCoalescedSnapshotMetrics,
} from "../src/lib/coalescedSnapshot.ts";

describe("coalesced snapshots", () => {
    it("shares a cold in-flight load across concurrent readers", async () => {
        const load = Promise.withResolvers<string>();
        const producer = jest.fn(() => load.promise);
        const snapshot = new CoalescedSnapshot({
            freshForMs: 1000,
            load: producer,
            name: "test.cold-single-flight",
            staleForMs: 5000,
        });

        const first = snapshot.read();
        const second = snapshot.read();
        await Promise.resolve();

        expect(producer).toHaveBeenCalledTimes(1);
        load.resolve("shared");
        await expect(Promise.all([first, second])).resolves.toEqual(["shared", "shared"]);
        expect(
            getCoalescedSnapshotMetrics().find(
                (entry) => entry.name === "test.cold-single-flight"
            )
        ).toMatchObject({
            coalescedHits: 1,
            loads: 1,
            requests: 2,
        });
    });

    it("serves bounded stale data while one background refresh runs", async () => {
        let now = 1000;
        const refresh = Promise.withResolvers<string>();
        const producer = jest
            .fn<() => Promise<string>>()
            .mockResolvedValueOnce("first")
            .mockImplementationOnce(() => refresh.promise);
        const snapshot = new CoalescedSnapshot({
            freshForMs: 500,
            load: producer,
            name: "test.stale-while-revalidate",
            now: () => now,
            staleForMs: 5000,
        });

        await expect(snapshot.read()).resolves.toBe("first");
        now = 2000;
        await expect(snapshot.read()).resolves.toBe("first");
        await expect(snapshot.read()).resolves.toBe("first");
        expect(producer).toHaveBeenCalledTimes(2);

        now = 2100;
        refresh.resolve("second");
        await refresh.promise;
        await Promise.resolve();
        await expect(snapshot.read()).resolves.toBe("second");
    });

    it("does not let an invalidated load repopulate a newer generation", async () => {
        const oldLoad = Promise.withResolvers<string>();
        const newLoad = Promise.withResolvers<string>();
        const producer = jest
            .fn<() => Promise<string>>()
            .mockImplementationOnce(() => oldLoad.promise)
            .mockImplementationOnce(() => newLoad.promise);
        const snapshot = new CoalescedSnapshot({
            freshForMs: 1000,
            load: producer,
            name: "test.invalidation-generation",
            staleForMs: 5000,
        });

        const oldRead = snapshot.read();
        await Promise.resolve();
        snapshot.invalidate();
        const newRead = snapshot.read();
        await Promise.resolve();
        expect(producer).toHaveBeenCalledTimes(2);

        oldLoad.resolve("old");
        await expect(oldRead).resolves.toBe("old");
        newLoad.resolve("new");
        await expect(newRead).resolves.toBe("new");
        await expect(snapshot.read()).resolves.toBe("new");
    });

    it("propagates refresh failures after the hard stale boundary", async () => {
        let now = 1000;
        const producer = jest
            .fn<() => Promise<string>>()
            .mockResolvedValueOnce("first")
            .mockRejectedValueOnce(new Error("producer unavailable"));
        const snapshot = new CoalescedSnapshot({
            freshForMs: 500,
            load: producer,
            name: "test.hard-stale",
            now: () => now,
            staleForMs: 1000,
        });

        await expect(snapshot.read()).resolves.toBe("first");
        now = 2501;
        await expect(snapshot.read()).rejects.toThrow("producer unavailable");
    });
});
