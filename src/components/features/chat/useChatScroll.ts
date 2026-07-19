import { useVirtualizer } from "@tanstack/react-virtual";
import {
    type Dispatch,
    type RefObject,
    type SetStateAction,
    useCallback,
    useLayoutEffect,
    useRef,
} from "react";

import type { ChatRow } from "./chatTypes";

const BOTTOM_THRESHOLD_PX = 32;
const STRUCTURAL_BOTTOM_STABLE_FRAMES = 2;
const STRUCTURAL_BOTTOM_MAX_WAIT_FRAMES = 12;
const ESTIMATED_MESSAGE_ROW_HEIGHT_PX = 160;
const ESTIMATED_TYPING_ROW_HEIGHT_PX = 76;
const NO_SCROLL_ELEMENT = JSON.parse("null") as HTMLDivElement | null;

/** Owns sticky-bottom state and delegates viewport anchoring to the virtualizer. */
export function useChatScroll(
    rows: ChatRow[],
    selectedSessionKey: string,
    setIsAtBottom: Dispatch<SetStateAction<boolean>>,
    shouldStickToBottomReference: RefObject<boolean>
) {
    const messagesContainerReference = useRef<HTMLDivElement | undefined>(undefined);
    const bottomFollowFrameReference = useRef<number | undefined>(undefined);
    const bottomFollowFramesRemainingReference = useRef(0);
    const bottomFollowLastHeightReference = useRef<number | undefined>(undefined);
    const bottomFollowNeedsPrimeReference = useRef(false);
    const bottomFollowStableFramesReference = useRef(0);
    const structuralBottomFollowReference = useRef(false);
    const previousRowKeysReference = useRef<string[]>([]);
    const previousScrollTopReference = useRef(0);
    const previousSessionKeyReference = useRef("");

    const virtualizer = useVirtualizer({
        anchorTo: "end",
        count: rows.length,
        estimateSize: (index) =>
            rows[index]?.kind === "typing" || rows[index]?.kind === "status"
                ? ESTIMATED_TYPING_ROW_HEIGHT_PX
                : ESTIMATED_MESSAGE_ROW_HEIGHT_PX,
        followOnAppend: "auto",
        getItemKey: (index) => rows[index]?.key ?? `row-${index}`,
        getScrollElement: () => messagesContainerReference.current ?? NO_SCROLL_ELEMENT,
        overscan: 12,
        scrollEndThreshold: BOTTOM_THRESHOLD_PX,
        useAnimationFrameWithResizeObserver: true,
    });

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

    const resetStructuralFollowState = useCallback(() => {
        structuralBottomFollowReference.current = false;
        bottomFollowFramesRemainingReference.current = 0;
        bottomFollowLastHeightReference.current = undefined;
        bottomFollowNeedsPrimeReference.current = false;
        bottomFollowStableFramesReference.current = 0;
    }, []);

    const cancelBottomFollow = useCallback(() => {
        resetStructuralFollowState();
        if (bottomFollowFrameReference.current === undefined) {
            return;
        }
        cancelAnimationFrame(bottomFollowFrameReference.current);
        bottomFollowFrameReference.current = undefined;
    }, [resetStructuralFollowState]);

    const handleScroll = () => {
        const container = messagesContainerReference.current;
        const scrollTop = container?.scrollTop ?? 0;
        const didScrollUp = scrollTop + 1 < previousScrollTopReference.current;
        const isStructuralCorrectionPending = Boolean(
            didScrollUp &&
            structuralBottomFollowReference.current &&
            bottomFollowFrameReference.current !== undefined
        );
        if (
            didScrollUp &&
            !isStructuralCorrectionPending &&
            bottomFollowFrameReference.current !== undefined
        ) {
            cancelBottomFollow();
        }
        const atBottom = checkIsAtBottom();
        const shouldStaySticky = Boolean(
            atBottom ||
            (shouldStickToBottomReference.current &&
                (!didScrollUp || isStructuralCorrectionPending))
        );
        previousScrollTopReference.current = scrollTop;
        shouldStickToBottomReference.current = shouldStaySticky;
        setIsAtBottom((previous) =>
            previous === shouldStaySticky ? previous : shouldStaySticky
        );
    };

    const scrollToBottom = () => {
        const container = messagesContainerReference.current;
        if (!container) {
            return;
        }
        container.scrollTop = container.scrollHeight;
        previousScrollTopReference.current = container.scrollTop;
        shouldStickToBottomReference.current = true;
        setIsAtBottom(true);
    };

    const scheduleBottomFollow = (
        isStructuralCorrection = false,
        shouldPrimeBottom = false
    ) => {
        if (isStructuralCorrection) {
            structuralBottomFollowReference.current = true;
            bottomFollowFramesRemainingReference.current =
                STRUCTURAL_BOTTOM_MAX_WAIT_FRAMES;
            bottomFollowLastHeightReference.current = undefined;
            bottomFollowNeedsPrimeReference.current ||= shouldPrimeBottom;
            bottomFollowStableFramesReference.current = 0;
        }
        if (bottomFollowFrameReference.current !== undefined) {
            return;
        }
        const followBottom = () => {
            if (!shouldStickToBottomReference.current) {
                cancelBottomFollow();
                return;
            }
            if (bottomFollowNeedsPrimeReference.current) {
                bottomFollowNeedsPrimeReference.current = false;
                scrollToBottom();
                bottomFollowLastHeightReference.current = undefined;
                bottomFollowStableFramesReference.current = 0;
                bottomFollowFrameReference.current = requestAnimationFrame(followBottom);
                return;
            }
            if (structuralBottomFollowReference.current) {
                const currentHeight = messagesContainerReference.current?.scrollHeight;
                const previousHeight = bottomFollowLastHeightReference.current;
                bottomFollowLastHeightReference.current = currentHeight;
                bottomFollowStableFramesReference.current =
                    currentHeight !== undefined && currentHeight === previousHeight
                        ? bottomFollowStableFramesReference.current + 1
                        : 0;
                bottomFollowFramesRemainingReference.current -= 1;
            }
            const shouldWaitForStableHeight = Boolean(
                structuralBottomFollowReference.current &&
                bottomFollowStableFramesReference.current <
                    STRUCTURAL_BOTTOM_STABLE_FRAMES &&
                bottomFollowFramesRemainingReference.current > 0
            );
            if (shouldWaitForStableHeight) {
                bottomFollowFrameReference.current = requestAnimationFrame(followBottom);
                return;
            }
            scrollToBottom();
            bottomFollowFrameReference.current = undefined;
            resetStructuralFollowState();
        };
        bottomFollowFrameReference.current = requestAnimationFrame(followBottom);
    };

    const handleUserScrollIntent = () => {
        cancelBottomFollow();
    };

    const handleDynamicContentLoad = () => {
        if (shouldStickToBottomReference.current) {
            scheduleBottomFollow();
        }
    };

    useLayoutEffect(() => {
        const isSessionChanged =
            previousSessionKeyReference.current !== selectedSessionKey;
        const previousRowKeys = previousRowKeysReference.current;
        const rowKeys = rows.map((row) => row.key);
        const isInitialHistoryLoad = previousRowKeys.length === 0 && rowKeys.length > 0;
        const didRowKeysChange =
            previousRowKeys.length !== rowKeys.length ||
            previousRowKeys.some((key, index) => key !== rowKeys[index]);
        const isPureTailAppend =
            rowKeys.length > previousRowKeys.length &&
            previousRowKeys.every((key, index) => rowKeys[index] === key);
        const needsStructuralBottomFollow =
            previousRowKeys.length > 0 && didRowKeysChange && !isPureTailAppend;
        previousSessionKeyReference.current = selectedSessionKey;
        previousRowKeysReference.current = rowKeys;

        if (isSessionChanged) {
            previousScrollTopReference.current = 0;
            shouldStickToBottomReference.current = true;
            setIsAtBottom(true);
        }
        if (
            rows.length > 0 &&
            shouldStickToBottomReference.current &&
            (isSessionChanged || isInitialHistoryLoad || needsStructuralBottomFollow)
        ) {
            scheduleBottomFollow(true, isSessionChanged || isInitialHistoryLoad);
        }
    }, [rows, selectedSessionKey]);

    useLayoutEffect(
        () => () => {
            cancelBottomFollow();
        },
        [cancelBottomFollow]
    );

    return {
        handleDynamicContentLoad,
        handleScroll,
        handleUserScrollIntent,
        messagesContainerReference,
        scheduleBottomFollow,
        scrollToBottom,
        virtualizer,
    };
}
