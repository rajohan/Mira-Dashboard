export interface IntersectionObserverHarness {
    readonly intersectInfiniteScroll: () => void;
    readonly intersectLatest: () => void;
    readonly restore: () => void;
}

interface ObserverRecord {
    readonly callback: IntersectionObserverCallback;
    element?: Element;
}

function intersect(record: ObserverRecord | undefined): void {
    if (record === undefined) {
        throw new TypeError("No matching IntersectionObserver boundary is active");
    }
    record.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
    );
}

/** @returns A deterministic IntersectionObserver harness for pagination tests. */
export function installIntersectionObserverHarness(): IntersectionObserverHarness {
    const observers: ObserverRecord[] = [];
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
        readonly root = null;
        readonly rootMargin = "0px";
        readonly thresholds = [];
        readonly scrollMargin = "0px";
        readonly record: (typeof observers)[number];
        constructor(callback: IntersectionObserverCallback) {
            this.record = { callback };
            observers.push(this.record);
        }
        disconnect() {}
        observe(element: Element) {
            this.record.element = element;
        }
        takeRecords(): IntersectionObserverEntry[] {
            return [];
        }
        unobserve() {}
    };
    return {
        intersectInfiniteScroll: () =>
            intersect(
                observers.findLast(({ element }) =>
                    element?.matches("[data-infinite-scroll-trigger]")
                )
            ),
        intersectLatest: () => {
            intersect(observers.at(-1));
        },
        restore: () => {
            globalThis.IntersectionObserver = original;
        },
    };
}
