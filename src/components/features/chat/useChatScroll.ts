import { useVirtualizer } from "@tanstack/react-virtual";
import {
    type Dispatch,
    type RefObject,
    type SetStateAction,
    useLayoutEffect,
    useRef,
} from "react";

import { didScheduleBottomFollow } from "./chatPageUtilities";
import type { ChatRow } from "./chatTypes";

const BOTTOM_THRESHOLD_PX = 32;
const BOTTOM_FOLLOW_FRAME_COUNT = 4;
const NO_SCROLL_ELEMENT = JSON.parse("null") as HTMLDivElement | null;

interface ChatViewportAnchor {
    key: string;
    offset: number;
}

function chatRowElements(container: HTMLDivElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>("[data-chat-row-key]")];
}

function captureViewportAnchor(
    container: HTMLDivElement
): ChatViewportAnchor | undefined {
    const containerBounds = container.getBoundingClientRect();
    const viewportBottom = containerBounds.top + container.clientHeight;
    const element = chatRowElements(container).find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.bottom > containerBounds.top && bounds.top < viewportBottom;
    });
    const key = element?.dataset.chatRowKey;
    return element && key
        ? {
              key,
              offset: element.getBoundingClientRect().top - containerBounds.top,
          }
        : undefined;
}

function restoreViewportAnchor(
    container: HTMLDivElement,
    anchor: ChatViewportAnchor
): void {
    const element = chatRowElements(container).find(
        (candidate) => candidate.dataset.chatRowKey === anchor.key
    );
    if (!element) {
        return;
    }
    const currentOffset =
        element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const adjustment = currentOffset - anchor.offset;
    if (Math.abs(adjustment) < 0.5) {
        return;
    }
    const top = Math.max(0, container.scrollTop + adjustment);
    if (typeof container.scrollTo === "function") {
        container.scrollTo({ behavior: "auto", top });
    } else {
        container.scrollTop = top;
    }
}

/** Owns virtualized chat scrolling independently from transport/runtime state. */
export function useChatScroll(
    rows: ChatRow[],
    activityFingerprint: string,
    selectedSessionKey: string,
    setIsAtBottom: Dispatch<SetStateAction<boolean>>,
    shouldStickToBottomReference: RefObject<boolean>
) {
    const messagesContainerReference = useRef<HTMLDivElement | undefined>(undefined);
    const messagesBottomReference = useRef<HTMLDivElement | undefined>(undefined);
    const previousRowsLengthReference = useRef(0);
    const previousRowKeysReference = useRef("");
    const previousSessionKeyReference = useRef("");
    const previousActivityReference = useRef("");
    const viewportAnchorReference = useRef<ChatViewportAnchor | undefined>(undefined);
    const bottomFollowFrameReference = useRef<number | undefined>(undefined);
    const bottomFollowFramesRemainingReference = useRef(0);
    const rowKeysFingerprint = rows.map((row) => row.key).join("\u{0}");

    const checkIsAtBottom = () => {
        const container = messagesContainerReference.current;
        if (!container) {
            return true;
        }
        return (
            container.scrollHeight - container.scrollTop - container.clientHeight <=
            BOTTOM_THRESHOLD_PX
        );
    };

    const handleScroll = () => {
        const atBottom = checkIsAtBottom();
        shouldStickToBottomReference.current = atBottom;
        viewportAnchorReference.current = atBottom
            ? undefined
            : messagesContainerReference.current
              ? captureViewportAnchor(messagesContainerReference.current)
              : undefined;
        setIsAtBottom((previous) => (previous === atBottom ? previous : atBottom));
    };

    const scrollToBottom = () => {
        const container = messagesContainerReference.current;
        if (!container || rows.length === 0) {
            return;
        }
        messagesBottomReference.current?.scrollIntoView({ block: "end" });
        container.scrollTop = container.scrollHeight;
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
    };

    const scheduleBottomFollow = () => {
        bottomFollowFramesRemainingReference.current = BOTTOM_FOLLOW_FRAME_COUNT;
        if (bottomFollowFrameReference.current !== undefined) {
            return;
        }

        const followMeasuredLayout = () => {
            bottomFollowFrameReference.current = undefined;
            if (
                !shouldStickToBottomReference.current ||
                bottomFollowFramesRemainingReference.current <= 0
            ) {
                bottomFollowFramesRemainingReference.current = 0;
                return;
            }
            bottomFollowFramesRemainingReference.current -= 1;
            scrollToBottom();
            if (bottomFollowFramesRemainingReference.current > 0) {
                bottomFollowFrameReference.current =
                    requestAnimationFrame(followMeasuredLayout);
            }
        };

        bottomFollowFrameReference.current = requestAnimationFrame(followMeasuredLayout);
    };

    const virtualizer = useVirtualizer({
        anchorTo: "end",
        count: rows.length,
        getItemKey: (index) => rows[index]?.key ?? `row-${index}`,
        getScrollElement: () => messagesContainerReference.current ?? NO_SCROLL_ELEMENT,
        estimateSize: (index) => (rows[index]?.kind === "typing" ? 76 : 160),
        overscan: 12,
        scrollEndThreshold: BOTTOM_THRESHOLD_PX,
        useAnimationFrameWithResizeObserver: true,
        onChange: (_instance, sync) => {
            if (!sync && shouldStickToBottomReference.current) {
                scheduleBottomFollow();
            }
        },
    });

    const handleDynamicContentLoad = () => {
        const container = messagesContainerReference.current;
        if (!shouldStickToBottomReference.current && container) {
            if (viewportAnchorReference.current) {
                restoreViewportAnchor(container, viewportAnchorReference.current);
            }
            viewportAnchorReference.current = captureViewportAnchor(container);
            return;
        }
        didScheduleBottomFollow(
            shouldStickToBottomReference.current,
            scheduleBottomFollow
        );
    };

    useLayoutEffect(() => {
        const isSessionChanged =
            previousSessionKeyReference.current !== selectedSessionKey;
        const isRowsAdded = rows.length > previousRowsLengthReference.current;
        const areRowsChanged = previousRowKeysReference.current !== rowKeysFingerprint;
        const isActivityChanged =
            previousActivityReference.current !== activityFingerprint;

        previousSessionKeyReference.current = selectedSessionKey;
        previousRowsLengthReference.current = rows.length;
        previousRowKeysReference.current = rowKeysFingerprint;
        previousActivityReference.current = activityFingerprint;

        if (rows.length === 0) {
            viewportAnchorReference.current = undefined;
            return;
        }
        if (isSessionChanged) {
            viewportAnchorReference.current = undefined;
            shouldStickToBottomReference.current = true;
            scrollToBottom();
            scheduleBottomFollow();
            return;
        }
        if (!shouldStickToBottomReference.current) {
            const container = messagesContainerReference.current;
            if (container) {
                if (areRowsChanged && viewportAnchorReference.current) {
                    restoreViewportAnchor(container, viewportAnchorReference.current);
                }
                viewportAnchorReference.current = captureViewportAnchor(container);
            }
            return;
        }
        if (!isRowsAdded && !isActivityChanged) {
            return;
        }

        scrollToBottom();
        scheduleBottomFollow();
    }, [activityFingerprint, rowKeysFingerprint, rows.length, selectedSessionKey]);

    useLayoutEffect(
        () => () => {
            bottomFollowFramesRemainingReference.current = 0;
            if (bottomFollowFrameReference.current === undefined) {
                return;
            }
            cancelAnimationFrame(bottomFollowFrameReference.current);
            bottomFollowFrameReference.current = undefined;
        },
        []
    );

    return {
        handleDynamicContentLoad,
        handleScroll,
        messagesBottomReference,
        messagesContainerReference,
        scheduleBottomFollow,
        scrollToBottom,
        virtualizer,
    };
}
