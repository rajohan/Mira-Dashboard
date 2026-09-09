import { describe, expect, jest, test } from "bun:test";

import { useNow } from "./useNow.ts";

const { act, renderHook } = await import("@testing-library/react");

describe("ticking presentation clock", () => {
    test("re-renders consumers on the configured cadence", async () => {
        jest.useFakeTimers();
        try {
            const nowSpy = jest.spyOn(Date, "now");
            const mountNow = 1_800_000_000_000;
            let clock = mountNow;
            nowSpy.mockImplementation(() => clock);

            const view = renderHook(() => useNow(30_000));
            expect(view.result.current).toBe(mountNow);

            await act(async () => {
                clock += 29_999;
                jest.advanceTimersByTime(29_999);
                await Promise.resolve();
            });
            expect(view.result.current).toBe(mountNow);

            await act(async () => {
                clock += 1;
                jest.advanceTimersByTime(1);
                await Promise.resolve();
            });
            expect(view.result.current).toBe(clock);

            view.unmount();
        } finally {
            jest.useRealTimers();
            jest.restoreAllMocks();
        }
    });

    test("clears its interval on unmount", () => {
        jest.useFakeTimers();
        try {
            const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");
            const view = renderHook(() => useNow(30_000));
            const callsBeforeUnmount = clearIntervalSpy.mock.calls.length;

            view.unmount();

            expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(
                callsBeforeUnmount
            );
        } finally {
            jest.useRealTimers();
            jest.restoreAllMocks();
        }
    });
});
