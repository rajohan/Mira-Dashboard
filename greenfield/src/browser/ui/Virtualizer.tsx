import {
    type Virtualizer as TanStackVirtualizer,
    useVirtualizer,
    type VirtualItem,
} from "@tanstack/react-virtual";
import {
    type ReactNode,
    type RefObject,
    useEffect,
    useEffectEvent,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

const defaultInitialRect = Object.freeze({ height: 480, width: 960 });
const defaultFollowEndThresholdPx = 32;
const structuralFollowMaximumFrames = 12;
const structuralFollowStableFrames = 2;
const scrollKeys = new Set([
    " ",
    "ArrowDown",
    "ArrowUp",
    "End",
    "Home",
    "PageDown",
    "PageUp",
]);

type VirtualizerItemKey = VirtualItem["key"];

export interface VirtualizerItemsAppendedEvent {
    readonly itemKeys: readonly VirtualizerItemKey[];
    readonly wasFollowing: boolean;
}

export interface VirtualizerFollowToEndOptions {
    /** Changes when already-rendered rows may have changed height. */
    readonly layoutRevision?: number | string;
    /** Receives pure tail additions without imposing domain-specific unread rules. */
    readonly onItemsAppended?: (event: VirtualizerItemsAppendedEvent) => void;
    /** Receives reader-follow state changes, including manual return to the end. */
    readonly onFollowingChange?: (following: boolean) => void;
    /** Resets the end anchor when the caller switches lists, sessions, or scopes. */
    readonly scopeKey: number | string;
    readonly scrollEndThreshold?: number;
}

export interface VirtualizerFollowToEndState {
    /** True only when the viewport currently resolves within the end threshold. */
    readonly atEnd: boolean;
    /** Explicit alias for consumers deciding whether to render a follow control. */
    readonly awayFromEnd: boolean;
    /** Returns to the latest row and re-enables sticky following. */
    readonly follow: () => void;
    /** True while append and dynamic-size changes should remain pinned to the end. */
    readonly following: boolean;
    /** Re-measures async media or other content whose load is not represented by layoutRevision. */
    readonly notifyDynamicContentChange: () => void;
}

export interface VirtualizerRenderState<TItemElement extends Element> {
    readonly followToEnd: VirtualizerFollowToEndState | undefined;
    readonly getVirtualItemForOffset: (
        offset: number
    ) => Readonly<{ index: number }> | undefined;
    readonly measure: () => void;
    readonly measureElement: (node: TItemElement | null) => void;
    readonly scrollToIndex: (
        index: number,
        options?: Readonly<{ align?: "auto" | "center" | "end" | "start" }>
    ) => void;
    readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
    readonly totalSize: number;
    readonly virtualItems: readonly VirtualItem[];
}

interface VirtualizerBaseProps<TItemElement extends Element> {
    readonly children: (state: VirtualizerRenderState<TItemElement>) => ReactNode;
    readonly count: number;
    readonly estimateSize: (index: number) => number;
    readonly initialRect?: Readonly<{ height: number; width: number }>;
    readonly overscan?: number;
}

type VirtualizerProps<TItemElement extends Element> = VirtualizerBaseProps<TItemElement> &
    (
        | {
              readonly followToEnd: VirtualizerFollowToEndOptions;
              readonly getItemKey: (index: number) => VirtualizerItemKey;
          }
        | {
              readonly followToEnd?: undefined;
              readonly getItemKey?: (index: number) => VirtualizerItemKey;
          }
    );

interface FollowControllerArguments<TItemElement extends Element> {
    readonly count: number;
    readonly getItemKey: ((index: number) => VirtualizerItemKey) | undefined;
    readonly options: VirtualizerFollowToEndOptions | undefined;
    readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
    readonly virtualizer: TanStackVirtualizer<HTMLDivElement, TItemElement>;
}

function isKeyboardScroll(event: KeyboardEvent, container: HTMLDivElement): boolean {
    return scrollKeys.has(event.key) && (event.target === container || event.key !== " ");
}

function isScrollbarPointer(event: PointerEvent, container: HTMLDivElement): boolean {
    const scrollbarWidth = container.offsetWidth - container.clientWidth;
    return (
        scrollbarWidth > 0 &&
        event.target === container &&
        event.clientX >= container.getBoundingClientRect().right - scrollbarWidth
    );
}

function sameKeys(
    first: readonly VirtualizerItemKey[],
    second: readonly VirtualizerItemKey[]
): boolean {
    return (
        first.length === second.length &&
        first.every((key, index) => key === second[index])
    );
}

function tailAddition(
    previous: readonly VirtualizerItemKey[],
    current: readonly VirtualizerItemKey[]
): readonly VirtualizerItemKey[] {
    if (
        previous.length === 0 ||
        current.length <= previous.length ||
        !previous.every((key, index) => key === current[index])
    ) {
        return [];
    }
    return current.slice(previous.length);
}

function useFollowToEndController<TItemElement extends Element>({
    count,
    getItemKey,
    options,
    scrollContainerRef,
    virtualizer,
}: FollowControllerArguments<TItemElement>): VirtualizerFollowToEndState | undefined {
    const enabled = options !== undefined;
    const frame = useRef<number | undefined>(undefined);
    const framesRemaining = useRef(0);
    const lastHeight = useRef<number | undefined>(undefined);
    const needsPrime = useRef(false);
    const previousItemKeys = useRef<readonly VirtualizerItemKey[]>([]);
    const previousLayoutRevision = useRef<number | string | undefined>(undefined);
    const previousScopeKey = useRef<number | string | undefined>(undefined);
    const previousScrollTop = useRef(0);
    const stableFrames = useRef(0);
    const structuralFollow = useRef(false);
    const wasFollowingWhenHidden = useRef(false);
    const followingReference = useRef(true);
    const [atEnd, setAtEnd] = useState(true);
    const [following, setFollowing] = useState(true);

    function setFollowState(nextFollowing: boolean): void {
        if (followingReference.current === nextFollowing) return;
        followingReference.current = nextFollowing;
        setFollowing(nextFollowing);
        options?.onFollowingChange?.(nextFollowing);
    }

    function resetStructuralFollow(): void {
        structuralFollow.current = false;
        framesRemaining.current = 0;
        lastHeight.current = undefined;
        needsPrime.current = false;
        stableFrames.current = 0;
    }

    function cancelScheduledFollow(): void {
        resetStructuralFollow();
        if (frame.current === undefined) return;
        cancelAnimationFrame(frame.current);
        frame.current = undefined;
    }

    function writeScrollEnd(): void {
        const element = scrollContainerRef.current;
        if (element === null) return;
        element.scrollTop = element.scrollHeight;
        previousScrollTop.current = element.scrollTop;
        setFollowState(true);
        setAtEnd(true);
    }

    function scheduleFollow(isStructuralChange = false, shouldPrimeEnd = false): void {
        if (!enabled || !followingReference.current) return;
        if (isStructuralChange) {
            structuralFollow.current = true;
            framesRemaining.current = structuralFollowMaximumFrames;
            lastHeight.current = undefined;
            needsPrime.current ||= shouldPrimeEnd;
            stableFrames.current = 0;
        }
        if (frame.current !== undefined) return;
        const followWhenStable = () => {
            if (!followingReference.current) {
                cancelScheduledFollow();
                return;
            }
            if (needsPrime.current) {
                needsPrime.current = false;
                writeScrollEnd();
                lastHeight.current = undefined;
                stableFrames.current = 0;
                frame.current = requestAnimationFrame(followWhenStable);
                return;
            }
            if (structuralFollow.current) {
                const currentHeight = scrollContainerRef.current?.scrollHeight;
                stableFrames.current =
                    currentHeight !== undefined && currentHeight === lastHeight.current
                        ? stableFrames.current + 1
                        : 0;
                lastHeight.current = currentHeight;
                framesRemaining.current -= 1;
            }
            const waitForStableHeight =
                structuralFollow.current &&
                stableFrames.current < structuralFollowStableFrames &&
                framesRemaining.current > 0;
            if (waitForStableHeight) {
                frame.current = requestAnimationFrame(followWhenStable);
                return;
            }
            writeScrollEnd();
            frame.current = undefined;
            resetStructuralFollow();
        };
        frame.current = requestAnimationFrame(followWhenStable);
    }

    function followLatest(): void {
        setFollowState(true);
        setAtEnd(true);
        scheduleFollow(true, true);
    }

    function notifyDynamicContentChange(): void {
        virtualizer.measure();
        scheduleFollow(true);
    }

    const handleScroll = useEffectEvent(() => {
        const element = scrollContainerRef.current;
        if (!enabled || element === null) return;
        const threshold = options?.scrollEndThreshold ?? defaultFollowEndThresholdPx;
        const nextAtEnd =
            element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
        const movedUp = element.scrollTop + 1 < previousScrollTop.current;
        const structuralCorrectionPending =
            movedUp && structuralFollow.current && frame.current !== undefined;
        if (nextAtEnd) {
            setFollowState(true);
        } else if (movedUp && !structuralCorrectionPending) {
            cancelScheduledFollow();
            setFollowState(false);
        }
        previousScrollTop.current = element.scrollTop;
        setAtEnd(nextAtEnd);
    });
    const handleUserScrollIntent = useEffectEvent(() => {
        if (enabled) cancelScheduledFollow();
    });
    const restoreVisibleFollow = useEffectEvent(() => {
        if (!enabled) return;
        if (document.visibilityState === "hidden") {
            wasFollowingWhenHidden.current = followingReference.current;
            return;
        }
        if (!wasFollowingWhenHidden.current) return;
        wasFollowingWhenHidden.current = false;
        followLatest();
    });
    const synchronizeLayout = useEffectEvent(() => {
        if (!enabled || options === undefined) {
            previousItemKeys.current = [];
            previousLayoutRevision.current = undefined;
            previousScopeKey.current = undefined;
            cancelScheduledFollow();
            return;
        }
        const oldKeys = previousItemKeys.current;
        const currentKeys = Array.from({ length: count }, (_, index) =>
            getItemKey === undefined ? index : getItemKey(index)
        );
        const scopeChanged = previousScopeKey.current !== options.scopeKey;
        const layoutChanged = previousLayoutRevision.current !== options.layoutRevision;
        const keysChanged = !sameKeys(oldKeys, currentKeys);
        const appendedKeys = scopeChanged ? [] : tailAddition(oldKeys, currentKeys);
        const wasFollowing = followingReference.current;

        previousScopeKey.current = options.scopeKey;
        previousLayoutRevision.current = options.layoutRevision;
        previousItemKeys.current = currentKeys;

        if (scopeChanged) {
            previousScrollTop.current = 0;
            setFollowState(true);
            setAtEnd(true);
            if (currentKeys.length > 0) scheduleFollow(true, true);
            return;
        }
        if (appendedKeys.length > 0) {
            options.onItemsAppended?.({ itemKeys: appendedKeys, wasFollowing });
        }
        if (layoutChanged && !keysChanged) virtualizer.measure();
        if (followingReference.current && (keysChanged || layoutChanged)) {
            scheduleFollow(true, oldKeys.length === 0);
        }
    });
    const cancelOnCleanup = useEffectEvent(cancelScheduledFollow);
    const scheduleFollowAfterResize = useEffectEvent(() => scheduleFollow());

    useLayoutEffect(() => {
        synchronizeLayout();
    }, [count, getItemKey, options?.layoutRevision, options?.scopeKey]);

    useEffect(() => {
        if (!enabled) return;
        const element = scrollContainerRef.current;
        if (element === null) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (isKeyboardScroll(event, element)) handleUserScrollIntent();
        };
        const onPointerDown = (event: PointerEvent) => {
            if (isScrollbarPointer(event, element)) handleUserScrollIntent();
        };
        const onScroll = () => handleScroll();
        const onTouchMove = () => handleUserScrollIntent();
        const onWheel = () => handleUserScrollIntent();
        const onVisibilityChange = () => restoreVisibleFollow();
        const resizeObserver =
            typeof ResizeObserver === "undefined"
                ? undefined
                : new ResizeObserver(() => scheduleFollowAfterResize());
        element.addEventListener("keydown", onKeyDown);
        element.addEventListener("pointerdown", onPointerDown);
        element.addEventListener("scroll", onScroll, { passive: true });
        element.addEventListener("touchmove", onTouchMove, { passive: true });
        element.addEventListener("wheel", onWheel, { passive: true });
        document.addEventListener("visibilitychange", onVisibilityChange);
        resizeObserver?.observe(element);
        return () => {
            element.removeEventListener("keydown", onKeyDown);
            element.removeEventListener("pointerdown", onPointerDown);
            element.removeEventListener("scroll", onScroll);
            element.removeEventListener("touchmove", onTouchMove);
            element.removeEventListener("wheel", onWheel);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            resizeObserver?.disconnect();
        };
    }, [enabled, scrollContainerRef]);

    useLayoutEffect(() => () => cancelOnCleanup(), []);

    if (!enabled) return undefined;
    return {
        atEnd,
        awayFromEnd: !following,
        follow: followLatest,
        following,
        notifyDynamicContentChange,
    };
}

/**
 * Exposes a shared TanStack Virtual window without imposing list or table markup.
 * Follow-to-end behavior is opt-in so existing table consumers keep start anchoring.
 * @returns The caller's presentation composed with scroll and measurement state.
 */
export function Virtualizer<TItemElement extends Element = HTMLElement>({
    children,
    count,
    estimateSize,
    followToEnd,
    getItemKey,
    initialRect = defaultInitialRect,
    overscan = 6,
}: VirtualizerProps<TItemElement>) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer<HTMLDivElement, TItemElement>({
        anchorTo: followToEnd === undefined ? undefined : "end",
        count,
        estimateSize,
        followOnAppend: followToEnd === undefined ? undefined : "auto",
        getItemKey,
        getScrollElement: () => scrollContainerRef.current,
        initialRect,
        overscan,
        scrollEndThreshold: followToEnd?.scrollEndThreshold,
        useAnimationFrameWithResizeObserver: followToEnd === undefined ? undefined : true,
        useFlushSync: false,
    });
    const followController = useFollowToEndController({
        count,
        getItemKey,
        options: followToEnd,
        scrollContainerRef,
        virtualizer,
    });

    return children({
        followToEnd: followController,
        getVirtualItemForOffset: virtualizer.getVirtualItemForOffset,
        measure: virtualizer.measure,
        measureElement: virtualizer.measureElement,
        scrollToIndex: virtualizer.scrollToIndex,
        scrollContainerRef,
        totalSize: virtualizer.getTotalSize(),
        virtualItems: virtualizer.getVirtualItems(),
    });
}
