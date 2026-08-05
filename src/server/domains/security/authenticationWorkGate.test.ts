import { describe, expect, test } from "bun:test";

import { createAuthenticationWorkGate } from "./authenticationWorkGate.ts";

describe("authentication work gate", () => {
    test("serializes expensive work and rejects overflow beyond the bounded queue", async () => {
        const gate = createAuthenticationWorkGate(1, 1);
        const releaseFirst = Promise.withResolvers<void>();
        let starts = 0;
        const first = gate.run(async () => {
            starts += 1;
            await releaseFirst.promise;
            return "first";
        });
        await Promise.resolve();
        const second = gate.run(() => {
            starts += 1;
            return Promise.resolve("second");
        });
        await Promise.resolve();

        expect(starts).toBe(1);
        expect(await gate.run(() => Promise.resolve("overflow"))).toEqual({
            accepted: false,
        });

        releaseFirst.resolve();
        expect(await first).toEqual({ accepted: true, value: "first" });
        expect(await second).toEqual({ accepted: true, value: "second" });
        expect(starts).toBe(2);
    });

    test("removes aborted queued work without consuming queue capacity", async () => {
        const gate = createAuthenticationWorkGate(1, 1);
        const releaseFirst = Promise.withResolvers<void>();
        const first = gate.run(() => releaseFirst.promise);
        await Promise.resolve();
        const controller = new AbortController();
        const aborted = gate.run(() => Promise.resolve(), controller.signal);
        await Promise.resolve();

        controller.abort(new Error("request cancelled"));
        expect(aborted).rejects.toThrow("request cancelled");

        const replacement = gate.run(() => Promise.resolve("replacement"));
        releaseFirst.resolve();
        await first;
        expect(await replacement).toEqual({
            accepted: true,
            value: "replacement",
        });
    });

    test("rejects invalid resource budgets", () => {
        expect(() => createAuthenticationWorkGate(0, 1)).toThrow(RangeError);
        expect(() => createAuthenticationWorkGate(1, -1)).toThrow(RangeError);
    });
});
