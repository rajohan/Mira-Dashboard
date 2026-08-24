import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";

import { type ComponentProps, useState } from "react";

import { Virtualizer } from "./Virtualizer.tsx";

const { act, fireEvent, render, screen } = await import("@testing-library/react");

const hadOwnResizeObserver = Object.hasOwn(globalThis, "ResizeObserver");
const originalResizeObserver = Reflect.get(globalThis, "ResizeObserver");

beforeAll(() => {
    Reflect.set(globalThis, "ResizeObserver", undefined);
});

afterAll(() => {
    if (hadOwnResizeObserver) {
        Reflect.set(globalThis, "ResizeObserver", originalResizeObserver);
    } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
});

interface FollowFixtureProps {
    readonly items: readonly string[];
    readonly layoutRevision?: number;
    readonly onItemsAppended?: NonNullable<
        ComponentProps<typeof Virtualizer>["followToEnd"]
    >["onItemsAppended"];
    readonly scopeKey?: string;
}

function FollowFixture({
    items,
    layoutRevision = 1,
    onItemsAppended,
    scopeKey = "first",
}: FollowFixtureProps) {
    return (
        <Virtualizer<HTMLDivElement>
            count={items.length}
            estimateSize={() => 100}
            followToEnd={{ layoutRevision, onItemsAppended, scopeKey }}
            getItemKey={(index) => items[index] ?? `missing:${index}`}
            initialRect={{ height: 200, width: 320 }}
            overscan={3}
        >
            {(virtualization) => (
                <section
                    data-at-end={virtualization.followToEnd?.atEnd}
                    data-following={virtualization.followToEnd?.following}
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

describe("shared virtualizer follow-to-end controller", () => {
    test("keeps follow behavior opt-in for existing consumers", () => {
        render(<DefaultFixture />);

        const button = screen.getByRole("button", { name: "pending" });
        expect(button).toHaveAttribute("data-follow-controller", "undefined");
        fireEvent.click(button);
        expect(button).toHaveTextContent("clicked");
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
            <FollowFixture items={["older-1", "older-2", ...initialItems]} />
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
