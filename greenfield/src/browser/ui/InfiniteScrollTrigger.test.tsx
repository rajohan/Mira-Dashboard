import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { act, render, screen } from "@testing-library/react";

import { InfiniteScrollTrigger } from "./InfiniteScrollTrigger.tsx";

describe("InfiniteScrollTrigger", () => {
    const callbacks: IntersectionObserverCallback[] = [];
    const originalIntersectionObserver = globalThis.IntersectionObserver;

    beforeEach(() => {
        callbacks.length = 0;
        globalThis.IntersectionObserver = class {
            readonly root = null;
            readonly rootMargin = "400px 0px";
            readonly scrollMargin = "0px";
            readonly thresholds = [0];

            constructor(
                callback: IntersectionObserverCallback,
                _options?: IntersectionObserverInit
            ) {
                callbacks.push(callback);
            }

            disconnect(): void {}
            observe(): void {}
            takeRecords(): IntersectionObserverEntry[] {
                return [];
            }
            unobserve(): void {}
        };
    });

    afterEach(() => {
        globalThis.IntersectionObserver = originalIntersectionObserver;
    });

    test("requests one next page for one observed continuation boundary", () => {
        const onLoadMore = jest.fn();
        render(
            <InfiniteScrollTrigger
                hasMore
                loading={false}
                loadingLabel="Loading older rows…"
                onLoadMore={onLoadMore}
            />
        );

        act(() => {
            callbacks[0]?.(
                [{ isIntersecting: true } as IntersectionObserverEntry],
                {} as IntersectionObserver
            );
            callbacks[0]?.(
                [{ isIntersecting: true } as IntersectionObserverEntry],
                {} as IntersectionObserver
            );
        });

        expect(onLoadMore).toHaveBeenCalledTimes(1);
    });

    test("shows stable loading feedback and error-only retry", () => {
        const onLoadMore = jest.fn();
        const view = render(
            <InfiniteScrollTrigger
                hasMore
                loading
                loadingLabel="Loading older rows…"
                onLoadMore={onLoadMore}
            />
        );
        expect(screen.getByLabelText("Loading older rows…")).toBeTruthy();

        view.rerender(
            <InfiniteScrollTrigger
                error="Older rows are unavailable."
                hasMore
                loading={false}
                loadingLabel="Loading older rows…"
                onLoadMore={onLoadMore}
            />
        );
        screen.getByRole("button", { name: "Try again" }).click();
        expect(onLoadMore).toHaveBeenCalledTimes(1);
    });
});
