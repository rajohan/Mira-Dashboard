import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { act } from "react";

import { useDemandDrivenCacheRefresh } from "./useDemandDrivenCacheRefresh.ts";

const { render } = await import("@testing-library/react");

afterEach(() => {
    jest.useRealTimers();
});

function RefreshProbe({
    enabled = true,
    mutation,
    observedAtMs = 0,
}: {
    readonly enabled?: boolean;
    readonly mutation: (...arguments_: readonly unknown[]) => Promise<never>;
    readonly observedAtMs?: number;
}) {
    useDemandDrivenCacheRefresh({
        client: { mutation },
        enabled,
        intervalMs: 5000,
        key: "docker.overview",
        observedAtMs,
    });
    return null;
}

describe("demand-driven cache refresh", () => {
    test("requests one bounded refresh for a stale visible projection", () => {
        jest.useFakeTimers();
        jest.setSystemTime(10_000);
        const pending = Promise.withResolvers<never>();
        const mutation = mock((..._arguments: readonly unknown[]) => pending.promise);
        const view = render(<RefreshProbe mutation={mutation} />);

        act(() => {
            jest.advanceTimersByTime(5000);
        });

        expect(mutation).toHaveBeenCalledTimes(1);
        const call = mutation.mock.calls[0] as unknown as readonly [
            string,
            { readonly key: string },
            { readonly signal: AbortSignal },
        ];
        expect(call[0]).toBe("cache.refreshEntry");
        expect(call[1]).toMatchObject({ key: "docker.overview" });
        expect(call[2].signal).toBeInstanceOf(AbortSignal);

        act(() => {
            jest.advanceTimersByTime(5000);
        });
        expect(mutation).toHaveBeenCalledTimes(1);
        view.unmount();
        expect(call[2].signal.aborted).toBeTrue();
    });

    test("stays idle when disabled, hidden, or already fresh", () => {
        jest.useFakeTimers();
        jest.setSystemTime(10_000);
        const mutation = mock((..._arguments: readonly unknown[]) =>
            Promise.resolve(undefined as never)
        );
        const visibility = Object.getOwnPropertyDescriptor(
            globalThis.document,
            "visibilityState"
        );
        Object.defineProperty(globalThis.document, "visibilityState", {
            configurable: true,
            value: "hidden",
        });
        const hidden = render(<RefreshProbe mutation={mutation} />);
        const disabled = render(<RefreshProbe enabled={false} mutation={mutation} />);
        const fresh = render(
            <RefreshProbe mutation={mutation} observedAtMs={Date.now()} />
        );

        try {
            act(() => {
                jest.advanceTimersByTime(5000);
            });
            expect(mutation).not.toHaveBeenCalled();
        } finally {
            hidden.unmount();
            disabled.unmount();
            fresh.unmount();
            if (visibility === undefined) {
                Reflect.deleteProperty(globalThis.document, "visibilityState");
            } else {
                Object.defineProperty(globalThis.document, "visibilityState", visibility);
            }
        }
    });
});
