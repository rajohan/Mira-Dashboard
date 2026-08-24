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
const exactEndTolerancePx = 1;
const overlayScrollbarHitAreaPx = 16;
const structuralFollowMaximumFrames = 12;
const structuralFollowStableFrames = 2;
const nestedScrollRegionSelector = "[data-virtualizer-scroll-region]";
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
    /** Stops sticky end correction before an intentional in-list reposition. */
    readonly stopFollowing: () => void;
}

export interface VirtualizerRenderState<TItemElement extends Element> {
    readonly followToEnd: VirtualizerFollowToEndState | undefined;
    readonly getVirtualItemForOffset: (
        offset: number
    ) => Readonly<{ index: number }> | undefined;
    readonly measure: () => void;
    readonly measureElement: (node: TItemElement | null) => void;
    readonly preserveVisibleAnchor: () => void;
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
    readonly following: boolean;
    readonly getItemKey: ((index: number) => VirtualizerItemKey) | undefined;
    readonly onFollowStateChange: (following: boolean) => void;
    readonly onScrollbarGestureChange: (active: boolean) => void;
    readonly options: VirtualizerFollowToEndOptions | undefined;
    readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
    readonly virtualizer: TanStackVirtualizer<HTMLDivElement, TItemElement>;
}

function isKeyboardScroll(event: KeyboardEvent, container: HTMLDivElement): boolean {
    if (!scrollKeys.has(event.key)) return false;
    if (event.target === container) return true;
    if (event.key === " ") return false;
    return !isNestedScrollRegionTarget(event.target);
}

function nestedScrollRegionForTarget(target: EventTarget | null): Element | null {
    return target instanceof Element ? target.closest(nestedScrollRegionSelector) : null;
}

function isNestedScrollRegionTarget(target: EventTarget | null): boolean {
    return nestedScrollRegionForTarget(target) !== null;
}

function nestedScrollRegionConsumesUpwardWheel(target: EventTarget | null): boolean {
    const region = nestedScrollRegionForTarget(target);
    return (
        region instanceof HTMLElement &&
        region.scrollHeight > region.clientHeight &&
        region.scrollTop > 0
    );
}

function isScrollbarPointer(event: PointerEvent, container: HTMLDivElement): boolean {
    if (event.target !== container || container.scrollHeight <= container.clientHeight) {
        return false;
    }
    const rightEdge = container.getBoundingClientRect().right;
    const scrollbarWidth = container.offsetWidth - container.clientWidth;
    const hitAreaWidth = scrollbarWidth > 0 ? scrollbarWidth : overlayScrollbarHitAreaPx;
    return event.clientX >= rightEdge - hitAreaWidth && event.clientX <= rightEdge;
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

function remeasureMountedItems<TItemElement extends Element>(
    virtualizer: TanStackVirtualizer<HTMLDivElement, TItemElement>
): void {
    // A full measure() drops cached sizes for offscreen predecessors. Read only
    // the mounted virtual window so live row changes preserve those measurements.
    const sizeProperty = virtualizer.options.horizontal ? "offsetWidth" : "offsetHeight";
    for (const item of virtualizer.getVirtualItems()) {
        const element = virtualizer.elementsCache.get(item.key);
        if (!(element instanceof HTMLElement) || !element.isConnected) continue;
        virtualizer.resizeItem(item.index, element[sizeProperty]);
    }
}

function useFollowToEndController<TItemElement extends Element>({
    count,
    following,
    getItemKey,
    onFollowStateChange,
    onScrollbarGestureChange,
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
    const scrollbarGestureActive = useRef(false);
    const scrollbarGestureMovedUp = useRef(false);
    const middleAutoscrollPending = useRef(false);
    const userScrollIntent = useRef(false);
    const wasFollowingWhenHidden = useRef(false);
    const followingReference = useRef(following);
    const [atEnd, setAtEnd] = useState(true);

    function setFollowState(nextFollowing: boolean): void {
        if (followingReference.current === nextFollowing) return;
        followingReference.current = nextFollowing;
        onFollowStateChange(nextFollowing);
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
        middleAutoscrollPending.current = false;
        scrollbarGestureMovedUp.current = false;
        userScrollIntent.current = false;
        setFollowState(true);
        setAtEnd(true);
    }

    function scheduleFollow(isStructuralChange = false, shouldPrimeEnd = false): void {
        if (!enabled || !followingReference.current || userScrollIntent.current) {
            return;
        }
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
        middleAutoscrollPending.current = false;
        scrollbarGestureMovedUp.current = false;
        userScrollIntent.current = false;
        setFollowState(true);
        setAtEnd(true);
        scheduleFollow(true, true);
    }

    function notifyDynamicContentChange(): void {
        remeasureMountedItems(virtualizer);
        scheduleFollow(true);
    }

    function stopFollowing(): void {
        userScrollIntent.current = false;
        cancelScheduledFollow();
        setFollowState(false);
        setAtEnd(false);
    }

    const handleScroll = useEffectEvent(() => {
        const element = scrollContainerRef.current;
        if (!enabled || element === null) return;
        const threshold = options?.scrollEndThreshold ?? defaultFollowEndThresholdPx;
        const distanceFromEnd =
            element.scrollHeight - element.scrollTop - element.clientHeight;
        const nextAtEnd = distanceFromEnd <= threshold;
        const nextAtExactEnd = Math.abs(distanceFromEnd) <= exactEndTolerancePx;
        const moved = Math.abs(element.scrollTop - previousScrollTop.current) > 1;
        const movedUp = element.scrollTop + 1 < previousScrollTop.current;
        const upwardGestureActive =
            userScrollIntent.current ||
            middleAutoscrollPending.current ||
            scrollbarGestureActive.current;
        const structuralCorrectionPending =
            movedUp &&
            structuralFollow.current &&
            frame.current !== undefined &&
            !upwardGestureActive;
        const preserveGestureDetach =
            !nextAtExactEnd &&
            (middleAutoscrollPending.current ||
                (scrollbarGestureActive.current && scrollbarGestureMovedUp.current));
        if (movedUp && !structuralCorrectionPending && !nextAtExactEnd) {
            cancelScheduledFollow();
            userScrollIntent.current = false;
            middleAutoscrollPending.current = false;
            if (scrollbarGestureActive.current) {
                scrollbarGestureMovedUp.current = true;
            }
            setFollowState(false);
        } else if (
            moved &&
            userScrollIntent.current &&
            !structuralCorrectionPending &&
            !nextAtExactEnd
        ) {
            cancelScheduledFollow();
            userScrollIntent.current = false;
            setFollowState(false);
        } else if (
            nextAtEnd &&
            !preserveGestureDetach &&
            (followingReference.current || nextAtExactEnd)
        ) {
            userScrollIntent.current = false;
            if (nextAtExactEnd) {
                middleAutoscrollPending.current = false;
                scrollbarGestureMovedUp.current = false;
            }
            setFollowState(true);
        }
        previousScrollTop.current = element.scrollTop;
        setAtEnd(nextAtEnd);
    });
    const handleUserScrollIntent = useEffectEvent((awayFromEnd: boolean) => {
        if (!enabled) return;
        const element = scrollContainerRef.current;
        const canScrollAway =
            element !== null && element.scrollHeight > element.clientHeight;
        if (awayFromEnd && !canScrollAway) {
            userScrollIntent.current = false;
            return;
        }
        const threshold = options?.scrollEndThreshold ?? defaultFollowEndThresholdPx;
        const alreadyAtEnd =
            element !== null &&
            element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
        if (!awayFromEnd && alreadyAtEnd) {
            userScrollIntent.current = false;
            return;
        }
        userScrollIntent.current = true;
        cancelScheduledFollow();
        if (awayFromEnd && element !== null) {
            // Disable sticky following at gesture time. Waiting for the browser's
            // later scroll event leaves a race where observers or row measurement
            // can schedule another end correction first.
            setFollowState(false);
            setAtEnd(false);
        }
    });
    const clearUnusedUserScrollIntent = useEffectEvent(() => {
        userScrollIntent.current = false;
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
            middleAutoscrollPending.current = false;
            scrollbarGestureActive.current = false;
            scrollbarGestureMovedUp.current = false;
            userScrollIntent.current = false;
            setFollowState(true);
            setAtEnd(true);
            if (currentKeys.length > 0) scheduleFollow(true, true);
            return;
        }
        if (appendedKeys.length > 0) {
            options.onItemsAppended?.({ itemKeys: appendedKeys, wasFollowing });
        }
        if (layoutChanged && !keysChanged) remeasureMountedItems(virtualizer);
        if (followingReference.current && (keysChanged || layoutChanged)) {
            scheduleFollow(true, oldKeys.length === 0);
        }
    });
    const cancelOnCleanup = useEffectEvent(cancelScheduledFollow);
    const scheduleFollowAfterContentMutation = useEffectEvent(() => scheduleFollow(true));
    const scheduleFollowAfterResize = useEffectEvent(() => scheduleFollow());

    useLayoutEffect(() => {
        synchronizeLayout();
    }, [count, getItemKey, options?.layoutRevision, options?.scopeKey]);

    useEffect(() => {
        if (!enabled) return;
        const element = scrollContainerRef.current;
        if (element === null) return;
        let activeScrollbarPointerId: number | undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (!isKeyboardScroll(event, element)) return;
            const awayFromEnd =
                event.key === "ArrowUp" ||
                event.key === "Home" ||
                event.key === "PageUp" ||
                (event.key === " " && event.shiftKey);
            if (awayFromEnd) handleUserScrollIntent(true);
        };
        const onPointerDown = (event: PointerEvent) => {
            if (event.button === 1) {
                if (isNestedScrollRegionTarget(event.target)) return;
                middleAutoscrollPending.current = true;
                handleUserScrollIntent(true);
                return;
            }
            if (!isScrollbarPointer(event, element)) return;
            activeScrollbarPointerId = event.pointerId;
            scrollbarGestureActive.current = true;
            scrollbarGestureMovedUp.current = false;
            onScrollbarGestureChange(true);
            handleUserScrollIntent(true);
        };
        const onPointerEnd = (event: PointerEvent) => {
            if (event.pointerId !== activeScrollbarPointerId) return;
            activeScrollbarPointerId = undefined;
            clearUnusedUserScrollIntent();
            // Reconcile while the gesture is still marked active so a release
            // inside the end threshold cannot undo an upward thumb drag.
            handleScroll();
            scrollbarGestureActive.current = false;
            scrollbarGestureMovedUp.current = false;
            onScrollbarGestureChange(false);
        };
        const onScroll = () => handleScroll();
        const onTouchMove = () => handleUserScrollIntent(false);
        const onTouchEnd = () => clearUnusedUserScrollIntent();
        const onWheel = (event: WheelEvent) => {
            if (
                event.deltaY < 0 &&
                !nestedScrollRegionConsumesUpwardWheel(event.target)
            ) {
                handleUserScrollIntent(true);
            }
        };
        const onVisibilityChange = () => restoreVisibleFollow();
        const resizeObserver =
            typeof ResizeObserver === "undefined"
                ? undefined
                : new ResizeObserver(() => scheduleFollowAfterResize());
        const mutationObserver =
            typeof MutationObserver === "undefined"
                ? undefined
                : new MutationObserver(() => scheduleFollowAfterContentMutation());
        element.addEventListener("keydown", onKeyDown);
        element.addEventListener("pointerdown", onPointerDown);
        element.addEventListener("scroll", onScroll, { passive: true });
        element.addEventListener("touchend", onTouchEnd, { passive: true });
        element.addEventListener("touchmove", onTouchMove, { passive: true });
        element.addEventListener("wheel", onWheel, { passive: true });
        document.addEventListener("visibilitychange", onVisibilityChange);
        globalThis.addEventListener("pointercancel", onPointerEnd);
        globalThis.addEventListener("pointerup", onPointerEnd);
        resizeObserver?.observe(element);
        mutationObserver?.observe(element, {
            attributeFilter: ["style"],
            attributes: true,
            childList: true,
            subtree: true,
        });
        return () => {
            if (activeScrollbarPointerId !== undefined) {
                onScrollbarGestureChange(false);
            }
            scrollbarGestureActive.current = false;
            scrollbarGestureMovedUp.current = false;
            element.removeEventListener("keydown", onKeyDown);
            element.removeEventListener("pointerdown", onPointerDown);
            element.removeEventListener("scroll", onScroll);
            element.removeEventListener("touchend", onTouchEnd);
            element.removeEventListener("touchmove", onTouchMove);
            element.removeEventListener("wheel", onWheel);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            globalThis.removeEventListener("pointercancel", onPointerEnd);
            globalThis.removeEventListener("pointerup", onPointerEnd);
            mutationObserver?.disconnect();
            resizeObserver?.disconnect();
        };
    }, [enabled, onScrollbarGestureChange, scrollContainerRef]);

    useLayoutEffect(() => () => cancelOnCleanup(), []);

    if (!enabled) return undefined;
    return {
        atEnd,
        awayFromEnd: !following,
        follow: followLatest,
        following,
        notifyDynamicContentChange,
        stopFollowing,
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
    const pendingVisibleAnchor = useRef<
        | Readonly<{
              candidates: readonly Readonly<{
                  key: VirtualizerItemKey;
                  viewportOffset: number;
              }>[];
              itemKeys: readonly VirtualizerItemKey[];
              lastTarget?: number;
          }>
        | undefined
    >(undefined);
    const previousCount = useRef(count);
    const previousFirstKey = useRef<VirtualizerItemKey | undefined>(
        count === 0 || getItemKey === undefined ? undefined : getItemKey(0)
    );
    const [following, setFollowing] = useState(followToEnd !== undefined);
    const [scrollbarGestureActive, setScrollbarGestureActive] = useState(false);
    const tanStackEndFollowEnabled =
        followToEnd !== undefined && following && !scrollbarGestureActive;
    const itemKeys = Array.from({ length: count }, (_, index) =>
        getItemKey === undefined ? index : getItemKey(index)
    );
    const pendingAnchor = pendingVisibleAnchor.current;
    const previousFirstKeyIndex =
        previousFirstKey.current === undefined
            ? -1
            : itemKeys.indexOf(previousFirstKey.current);
    const strictPrepend =
        followToEnd !== undefined &&
        !following &&
        ((count > previousCount.current && previousFirstKeyIndex > 0) ||
            (pendingAnchor !== undefined &&
                !sameKeys(pendingAnchor.itemKeys, itemKeys) &&
                pendingAnchor.candidates.some(({ key }) => itemKeys.indexOf(key) > 0)));
    const virtualizer = useVirtualizer<HTMLDivElement, TItemElement>({
        anchorTo: tanStackEndFollowEnabled || strictPrepend ? "end" : undefined,
        count,
        estimateSize,
        followOnAppend: tanStackEndFollowEnabled ? "auto" : undefined,
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
        following,
        getItemKey,
        onFollowStateChange: setFollowing,
        onScrollbarGestureChange: setScrollbarGestureActive,
        options: followToEnd,
        scrollContainerRef,
        virtualizer,
    });
    useLayoutEffect(() => {
        previousCount.current = count;
        previousFirstKey.current = itemKeys[0];
    }, [count, itemKeys]);
    useLayoutEffect(() => {
        const anchor = pendingVisibleAnchor.current;
        if (
            anchor === undefined ||
            sameKeys(anchor.itemKeys, itemKeys) ||
            getItemKey === undefined
        ) {
            return;
        }
        const retained = anchor.candidates
            .map((candidate) => ({
                ...candidate,
                index: itemKeys.indexOf(candidate.key),
            }))
            .find(({ index }) => index > 0);
        if (retained === undefined) {
            pendingVisibleAnchor.current = undefined;
            return;
        }
        remeasureMountedItems(virtualizer);
        const offset = virtualizer.getOffsetForIndex(retained.index, "start")?.[0];
        if (offset === undefined) return;
        const target = offset - retained.viewportOffset;
        virtualizer.scrollToOffset(target, { align: "start" });
        pendingVisibleAnchor.current =
            anchor.lastTarget !== undefined && Math.abs(anchor.lastTarget - target) <= 1
                ? undefined
                : { ...anchor, lastTarget: target };
    });

    function preserveVisibleAnchor(): void {
        const scrollElement = scrollContainerRef.current;
        if (scrollElement === null) return;
        const viewportEnd = scrollElement.scrollTop + scrollElement.clientHeight;
        const candidates = virtualizer
            .getVirtualItems()
            .filter(
                (item) => item.end > scrollElement.scrollTop && item.start < viewportEnd
            )
            .map((item) => ({
                key: item.key,
                viewportOffset: item.start - scrollElement.scrollTop,
            }));
        if (candidates.length === 0) return;
        pendingVisibleAnchor.current = {
            candidates,
            itemKeys,
        };
    }
    return children({
        followToEnd: followController,
        getVirtualItemForOffset: virtualizer.getVirtualItemForOffset,
        measure: virtualizer.measure,
        measureElement: virtualizer.measureElement,
        preserveVisibleAnchor,
        scrollToIndex: virtualizer.scrollToIndex,
        scrollContainerRef,
        totalSize: virtualizer.getTotalSize(),
        virtualItems: virtualizer.getVirtualItems(),
    });
}
