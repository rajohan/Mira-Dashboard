import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";

import { type ComponentProps, useState } from "react";

import { Virtualizer } from "./Virtualizer.tsx";

const { act, fireEvent, render, screen } = await import("@testing-library/react");

const hadOwnResizeObserver = Object.hasOwn(globalThis, "ResizeObserver");
const originalResizeObserver = Reflect.get(globalThis, "ResizeObserver");
const originalOffsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight"
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth"
);

function fixtureOffsetHeight(this: HTMLElement): number {
    return Number(this.style.height.slice(0, -2)) || 0;
}

function fixtureOffsetWidth(this: HTMLElement): number {
    return Number(this.style.width.slice(0, -2)) || 320;
}

beforeAll(() => {
    Reflect.set(globalThis, "ResizeObserver", undefined);
    Object.defineProperties(HTMLElement.prototype, {
        offsetHeight: {
            configurable: true,
            get: fixtureOffsetHeight,
        },
        offsetWidth: {
            configurable: true,
            get: fixtureOffsetWidth,
        },
    });
});

afterAll(() => {
    if (hadOwnResizeObserver) {
        Reflect.set(globalThis, "ResizeObserver", originalResizeObserver);
    } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    if (originalOffsetHeight === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    } else {
        Object.defineProperty(
            HTMLElement.prototype,
            "offsetHeight",
            originalOffsetHeight
        );
    }
    if (originalOffsetWidth === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    } else {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
    }
});

interface FollowFixtureProps {
    readonly followEnabled?: boolean;
    readonly items: readonly string[];
    readonly layoutRevision?: number;
    readonly onItemsAppended?: NonNullable<
        ComponentProps<typeof Virtualizer>["followToEnd"]
    >["onItemsAppended"];
    readonly scopeKey?: string;
    readonly withNestedScrollRegion?: boolean;
}

function FollowFixture({
    followEnabled = true,
    items,
    layoutRevision = 1,
    onItemsAppended,
    scopeKey = "first",
    withNestedScrollRegion = false,
}: FollowFixtureProps) {
    const followConfiguration = followEnabled
        ? ({
              followToEnd: { layoutRevision, onItemsAppended, scopeKey },
              getItemKey: (index: number) => items[index] ?? `missing:${index}`,
          } as const)
        : ({ followToEnd: undefined, getItemKey: undefined } as const);
    return (
        <Virtualizer<HTMLDivElement>
            count={items.length}
            estimateSize={() => 100}
            {...followConfiguration}
            initialRect={{ height: 200, width: 320 }}
            overscan={3}
        >
            {(virtualization) => (
                <section
                    data-at-end={virtualization.followToEnd?.atEnd}
                    data-following={virtualization.followToEnd?.following}
                    data-total-size={virtualization.totalSize}
                    data-testid="follow-fixture"
                >
                    <button onClick={virtualization.followToEnd?.follow} type="button">
                        Follow latest
                    </button>
                    <div
                        aria-label="Virtual messages"
                        ref={virtualization.scrollContainerRef}
                        role="log"
                        style={{ height: 200, overflow: "auto" }}
                    >
                        {withNestedScrollRegion && (
                            <button data-virtualizer-scroll-region type="button">
                                Nested scroll region
                            </button>
                        )}
                        <div
                            style={{
                                height: virtualization.totalSize,
                                position: "relative",
                            }}
                        >
                            {virtualization.virtualItems.map((item) => (
                                <div
                                    data-index={item.index}
                                    key={item.key}
                                    ref={virtualization.measureElement}
                                    style={{
                                        height: 100,
                                        position: "absolute",
                                        transform: `translateY(${item.start}px)`,
                                    }}
                                >
                                    {items[item.index]}
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            )}
        </Virtualizer>
    );
}

function DefaultFixture() {
    const [state, setState] = useState("pending");
    return (
        <Virtualizer<HTMLDivElement> count={2} estimateSize={() => 40}>
            {(virtualization) => (
                <button
                    data-follow-controller={
                        virtualization.followToEnd === undefined ? "undefined" : "defined"
                    }
                    onClick={() => setState("clicked")}
                    type="button"
                >
                    {state}
                </button>
            )}
        </Virtualizer>
    );
}

async function flushAnimationFrames(frameCount = 6): Promise<void> {
    await act(async () => {
        for (let index = 0; index < frameCount; index += 1) {
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => resolve());
            });
        }
    });
}

function setScrollGeometry(
    element: HTMLElement,
    geometry: Readonly<{ clientHeight: number; scrollHeight: () => number }>
): void {
    Object.defineProperties(element, {
        clientHeight: { configurable: true, value: geometry.clientHeight },
        scrollHeight: { configurable: true, get: geometry.scrollHeight },
    });
}

function setScrollbarGeometry(element: HTMLElement): void {
    Object.defineProperties(element, {
        clientWidth: { configurable: true, value: 300 },
        getBoundingClientRect: {
            configurable: true,
            value: () => ({ right: 320 }) as DOMRect,
        },
    });
}

function setOverlayScrollbarGeometry(element: HTMLElement): void {
    Object.defineProperties(element, {
        clientWidth: { configurable: true, value: 320 },
        getBoundingClientRect: {
            configurable: true,
            value: () => ({ right: 320 }) as DOMRect,
        },
    });
}

class ControlledResizeObserver {
    static readonly instances = new Set<ControlledResizeObserver>();

    readonly #callback: ResizeObserverCallback;
    readonly #targets = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
        ControlledResizeObserver.instances.add(this);
    }

    disconnect(): void {
        this.#targets.clear();
        ControlledResizeObserver.instances.delete(this);
    }

    observe(target: Element): void {
        this.#targets.add(target);
    }

    takeRecords(): ResizeObserverEntry[] {
        return [];
    }

    unobserve(target: Element): void {
        this.#targets.delete(target);
    }

    static resize(target: Element, blockSize: number): void {
        const entry = {
            borderBoxSize: [{ blockSize, inlineSize: 320 }],
            target,
        } as unknown as ResizeObserverEntry;
        for (const observer of ControlledResizeObserver.instances) {
            if (!observer.#targets.has(target)) continue;
            observer.#callback([entry], observer);
        }
    }
}

function setControlledResizeObserver(value: typeof ResizeObserver | undefined): void {
    Reflect.set(globalThis, "ResizeObserver", value);
    if (document.defaultView !== null) {
        Reflect.set(document.defaultView, "ResizeObserver", value);
    }
}

describe("shared virtualizer follow-to-end controller", () => {
    test("renders a short followed list whose content is smaller than its viewport", async () => {
        const rendered = render(<FollowFixture items={["first", "latest"]} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => 200 });
        await flushAnimationFrames();

        expect(log).toHaveTextContent("first");
        expect(log).toHaveTextContent("latest");
        act(() => rendered.unmount());
    });

    test("keeps a short non-overflowing list sticky after a no-op upward wheel", async () => {
        let scrollHeight = 200;
        const rendered = render(<FollowFixture items={["first", "latest"]} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();
        log.scrollTop = 0;

        fireEvent.wheel(log, { deltaY: -100 });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );

        scrollHeight = 300;
        rendered.rerender(<FollowFixture items={["first", "latest", "new-latest"]} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(300);
        act(() => rendered.unmount());
    });

    test("keeps a short non-overflowing list sticky after a no-op upward key", async () => {
        let scrollHeight = 200;
        const rendered = render(<FollowFixture items={["first", "latest"]} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();
        log.scrollTop = 0;

        fireEvent.keyDown(log, { key: "ArrowUp" });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );

        scrollHeight = 300;
        rendered.rerender(<FollowFixture items={["first", "latest", "new-latest"]} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(300);
        act(() => rendered.unmount());
    });

    test("keeps a followed list sticky after a no-op downward key at the end", async () => {
        let scrollHeight = 200;
        const rendered = render(<FollowFixture items={["first", "latest"]} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();
        log.scrollTop = 0;

        fireEvent.keyDown(log, { key: "ArrowDown" });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );

        scrollHeight = 300;
        rendered.rerender(<FollowFixture items={["first", "latest", "new-latest"]} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(300);
        act(() => rendered.unmount());
    });

    test("ignores upward scroll gestures from a nested scroll region", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} withNestedScrollRegion />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        const nested = screen.getByRole("button", { name: "Nested scroll region" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();

        for (const key of ["ArrowUp", "Home", "PageUp"]) {
            fireEvent.keyDown(nested, { key });
            expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
                "data-following",
                "true"
            );
        }
        Object.defineProperties(nested, {
            clientHeight: { configurable: true, value: 40 },
            scrollHeight: { configurable: true, value: 120 },
        });
        nested.scrollTop = 20;
        fireEvent.wheel(nested, { deltaY: -20 });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );
        fireEvent.pointerDown(nested, { button: 1, pointerId: 13 });
        fireEvent.pointerUp(document.body, { button: 1, pointerId: 13 });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );

        scrollHeight = 1200;
        rendered.rerender(
            <FollowFixture items={items} layoutRevision={2} withNestedScrollRegion />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1200);
        act(() => rendered.unmount());
    });

    test("detaches when an upward wheel chains out of a nested scroll boundary", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        const rendered = render(<FollowFixture items={items} withNestedScrollRegion />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        const nested = screen.getByRole("button", { name: "Nested scroll region" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => 1000 });
        await flushAnimationFrames();

        nested.scrollTop = 0;
        fireEvent.wheel(nested, { deltaY: -20 });

        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );
        act(() => rendered.unmount());
    });

    test("keeps follow behavior opt-in for existing consumers", () => {
        render(<DefaultFixture />);

        const button = screen.getByRole("button", { name: "pending" });
        expect(button).toHaveAttribute("data-follow-controller", "undefined");
        fireEvent.click(button);
        expect(button).toHaveTextContent("clicked");
    });

    test("resets follow state when follow-to-end is enabled again", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();

        fireEvent.wheel(log, { deltaY: -100 });
        act(() => {
            log.scrollTop = 400;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        rendered.rerender(<FollowFixture followEnabled={false} items={items} />);
        expect(screen.getByTestId("follow-fixture")).not.toHaveAttribute(
            "data-following"
        );

        scrollHeight = 1100;
        rendered.rerender(<FollowFixture items={items} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1100);
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );
        act(() => rendered.unmount());
    });

    test("stops following on reader scroll, reports tail additions, and resumes explicitly", async () => {
        const appended = jest.fn();
        const firstItems = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(
            <FollowFixture items={firstItems} onItemsAppended={appended} />
        );
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1000);

        act(() => {
            log.scrollTop = 800;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );

        fireEvent.wheel(log, { deltaY: -100 });
        act(() => {
            log.scrollTop = 400;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        scrollHeight = 1100;
        rendered.rerender(
            <FollowFixture
                items={[...firstItems, "item-10"]}
                onItemsAppended={appended}
            />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(400);
        expect(appended).toHaveBeenLastCalledWith({
            itemKeys: ["item-10"],
            wasFollowing: false,
        });

        fireEvent.click(screen.getByRole("button", { name: "Follow latest" }));
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1100);
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );

        scrollHeight = 1200;
        rendered.rerender(
            <FollowFixture
                items={[...firstItems, "item-10", "item-11"]}
                onItemsAppended={appended}
            />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1200);
        expect(appended).toHaveBeenLastCalledWith({
            itemKeys: ["item-11"],
            wasFollowing: true,
        });
        act(() => rendered.unmount());
    });

    test("disables shared end-follow before observers can fight an upward gesture", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1000);

        fireEvent.wheel(log, { deltaY: -100 });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        // A layout update can land before the browser dispatches its scroll event.
        // It must not re-arm follow-to-end during that gesture window.
        scrollHeight = 1200;
        rendered.rerender(<FollowFixture items={items} layoutRevision={2} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1000);

        act(() => {
            log.scrollTop = 400;
            fireEvent.scroll(log);
        });
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(400);
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );
        act(() => rendered.unmount());
    });

    test("detaches immediately during a scrollbar drag and stays at the reader position", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        setScrollbarGeometry(log);
        await flushAnimationFrames();

        fireEvent.pointerDown(log, { clientX: 315, pointerId: 17 });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        const appendedItems = [...items, "item-10"];
        scrollHeight = 1100;
        rendered.rerender(<FollowFixture items={appendedItems} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1000);

        act(() => {
            log.scrollTop = 400;
            fireEvent.scroll(log);
        });
        fireEvent.pointerUp(document.body, { pointerId: 17 });

        scrollHeight = 1300;
        rendered.rerender(<FollowFixture items={appendedItems} layoutRevision={2} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(400);
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );
        act(() => rendered.unmount());
    });

    test("keeps an overlay-scrollbar drag detached through repeated near-end movement and release", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        setOverlayScrollbarGeometry(log);
        await flushAnimationFrames();

        fireEvent.pointerDown(log, { button: 0, clientX: 315, pointerId: 31 });
        act(() => {
            log.scrollTop = 790;
            fireEvent.scroll(log);
            log.scrollTop = 780;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        scrollHeight = 1100;
        rendered.rerender(<FollowFixture items={items} layoutRevision={2} />);
        await flushAnimationFrames();
        fireEvent.pointerUp(document.body, { button: 0, pointerId: 31 });
        await flushAnimationFrames();

        expect(log.scrollTop).toBe(780);
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        act(() => {
            log.scrollTop = 900;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );
        act(() => rendered.unmount());
    });

    test("keeps middle-button autoscroll detached when movement starts after release", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();

        fireEvent.pointerDown(log, { button: 1, clientX: 100, pointerId: 37 });
        fireEvent.pointerUp(document.body, { button: 1, pointerId: 37 });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        scrollHeight = 1200;
        rendered.rerender(<FollowFixture items={items} layoutRevision={2} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1000);

        act(() => {
            log.scrollTop = 990;
            fireEvent.scroll(log);
            log.scrollTop = 980;
            fireEvent.scroll(log);
        });
        scrollHeight = 1300;
        rendered.rerender(<FollowFixture items={[...items, "item-10"]} />);
        await flushAnimationFrames();

        expect(log.scrollTop).toBe(980);
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        act(() => {
            log.scrollTop = 1100;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );
        act(() => rendered.unmount());
    });

    test("detaches on an unrecognized upward move inside the end threshold", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();

        act(() => {
            log.scrollTop = 790;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        scrollHeight = 1100;
        rendered.rerender(<FollowFixture items={items} layoutRevision={2} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(790);
        act(() => rendered.unmount());
    });

    test("preserves sticky follow during an in-progress structural correction", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();

        scrollHeight = 1100;
        rendered.rerender(<FollowFixture items={items} layoutRevision={2} />);
        act(() => {
            // Browsers can adjust scrollTop upward while measured rows reconcile.
            log.scrollTop = 890;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );

        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1100);
        act(() => rendered.unmount());
    });

    test("lets an upward wheel override an already-pending structural follow", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();

        scrollHeight = 1100;
        rendered.rerender(<FollowFixture items={items} layoutRevision={2} />);
        fireEvent.wheel(log, { deltaY: -20 });
        act(() => {
            log.scrollTop = 890;
            fireEvent.scroll(log);
        });
        await flushAnimationFrames();

        expect(log.scrollTop).toBe(890);
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );
        act(() => rendered.unmount());
    });

    test("does not reattach on near-end jitter after an upward scrollbar release", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => 1000 });
        setScrollbarGeometry(log);
        await flushAnimationFrames();

        fireEvent.pointerDown(log, { button: 0, clientX: 315, pointerId: 41 });
        act(() => {
            log.scrollTop = 790;
            fireEvent.scroll(log);
        });
        fireEvent.pointerUp(document.body, { button: 0, pointerId: 41 });
        act(() => {
            log.scrollTop = 795;
            fireEvent.scroll(log);
        });

        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        act(() => {
            log.scrollTop = 800;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );
        act(() => rendered.unmount());
    });

    test("does not tug downward after an upward scrollbar drag when a near-end row is remeasured", async () => {
        setControlledResizeObserver(ControlledResizeObserver);
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => 1200 });
        setScrollbarGeometry(log);
        Object.defineProperty(log, "scrollTo", {
            configurable: true,
            value: (options: ScrollToOptions) => {
                log.scrollTop = options.top ?? log.scrollTop;
            },
        });

        try {
            await flushAnimationFrames();
            fireEvent.pointerDown(log, { clientX: 315, pointerId: 19 });
            act(() => {
                log.scrollTop = 780;
                fireEvent.scroll(log);
            });
            fireEvent.pointerUp(document.body, { pointerId: 19 });
            await flushAnimationFrames(1);
            expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
                "data-following",
                "false"
            );

            const lastRow = screen.getByText("item-9");
            act(() => {
                ControlledResizeObserver.resize(lastRow, 150);
            });
            await flushAnimationFrames();

            expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
                "data-total-size",
                "1050"
            );
            expect(log.scrollTop).toBe(780);
            expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
                "data-following",
                "false"
            );
        } finally {
            act(() => rendered.unmount());
            ControlledResizeObserver.instances.clear();
            setControlledResizeObserver(undefined);
        }
    });

    test("completes a scrollbar gesture released outside the scroll container", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        setScrollbarGeometry(log);
        await flushAnimationFrames();

        fireEvent.pointerDown(log, { clientX: 315, pointerId: 23 });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );
        log.scrollTop = 800;
        fireEvent.pointerCancel(document.body, { pointerId: 23 });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );

        scrollHeight = 1100;
        rendered.rerender(
            <FollowFixture items={[...items, "item-10"]} layoutRevision={2} />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1100);
        act(() => rendered.unmount());
    });

    test("keeps a near-end upward gesture detached until the reader returns", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();

        fireEvent.wheel(log, { deltaY: -20 });
        act(() => {
            log.scrollTop = 790;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        scrollHeight = 1200;
        rendered.rerender(<FollowFixture items={items} layoutRevision={2} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(790);

        act(() => {
            log.scrollTop = 1000;
            fireEvent.scroll(log);
        });
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );
        act(() => rendered.unmount());
    });

    test("follows dynamic layout only while sticky and restores a sticky visible session", async () => {
        const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={items} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();

        scrollHeight = 1150;
        rendered.rerender(<FollowFixture items={items} layoutRevision={2} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(1150);

        fireEvent.wheel(log, { deltaY: -100 });
        act(() => {
            log.scrollTop = 300;
            fireEvent.scroll(log);
        });
        scrollHeight = 1300;
        rendered.rerender(<FollowFixture items={items} layoutRevision={3} />);
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(300);

        const visibilityDescriptor = Object.getOwnPropertyDescriptor(
            document,
            "visibilityState"
        );
        try {
            Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "hidden",
            });
            act(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "visible",
            });
            act(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            await flushAnimationFrames();
            expect(log.scrollTop).toBe(300);

            fireEvent.click(screen.getByRole("button", { name: "Follow latest" }));
            await flushAnimationFrames();
            Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "hidden",
            });
            act(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            scrollHeight = 1400;
            Object.defineProperty(document, "visibilityState", {
                configurable: true,
                value: "visible",
            });
            act(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            await flushAnimationFrames();
            expect(log.scrollTop).toBe(1400);
        } finally {
            if (visibilityDescriptor === undefined) {
                Reflect.deleteProperty(document, "visibilityState");
            } else {
                Object.defineProperty(document, "visibilityState", visibilityDescriptor);
            }
        }
        act(() => rendered.unmount());
    });

    test("preserves the visible anchor across a prepend and resets to end on scope change", async () => {
        const initialItems = Array.from({ length: 10 }, (_, index) => `item-${index}`);
        let scrollHeight = 1000;
        const rendered = render(<FollowFixture items={initialItems} />);
        const log = screen.getByRole("log", { name: "Virtual messages" });
        setScrollGeometry(log, { clientHeight: 200, scrollHeight: () => scrollHeight });
        await flushAnimationFrames();

        fireEvent.wheel(log, { deltaY: -100 });
        act(() => {
            log.scrollTop = 400;
            fireEvent.scroll(log);
        });
        scrollHeight = 1200;
        rendered.rerender(
            <FollowFixture
                items={["older-1", "older-2", ...initialItems]}
                layoutRevision={2}
            />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(600);
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "false"
        );

        scrollHeight = 900;
        rendered.rerender(
            <FollowFixture
                items={Array.from({ length: 9 }, (_, index) => `next-${index}`)}
                layoutRevision={3}
                scopeKey="second"
            />
        );
        await flushAnimationFrames();
        expect(log.scrollTop).toBe(900);
        expect(screen.getByTestId("follow-fixture")).toHaveAttribute(
            "data-following",
            "true"
        );
        act(() => rendered.unmount());
    });
});
