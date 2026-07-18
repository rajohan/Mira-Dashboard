import { useVirtualizer } from "@tanstack/react-virtual";
import {
    type Dispatch,
    type RefObject,
    type SetStateAction,
    useLayoutEffect,
    useRef,
} from "react";

import type { ChatRow } from "./chatTypes";

const BOTTOM_THRESHOLD_PX = 32;
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
            cancelAnimationFrame(bottomFollowFrameReference.current);
            bottomFollowFrameReference.current = undefined;
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

    const scheduleBottomFollow = (isStructuralCorrection = false) => {
        structuralBottomFollowReference.current ||= isStructuralCorrection;
        if (bottomFollowFrameReference.current !== undefined) {
            return;
        }
        bottomFollowFrameReference.current = requestAnimationFrame(() => {
            bottomFollowFrameReference.current = undefined;
            structuralBottomFollowReference.current = false;
            if (shouldStickToBottomReference.current) {
                scrollToBottom();
            }
        });
    };

    const handleUserScrollIntent = () => {
        structuralBottomFollowReference.current = false;
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
            scheduleBottomFollow(true);
        }
    }, [rows, selectedSessionKey]);

    useLayoutEffect(
        () => () => {
            if (bottomFollowFrameReference.current === undefined) {
                return;
            }
            cancelAnimationFrame(bottomFollowFrameReference.current);
            bottomFollowFrameReference.current = undefined;
            structuralBottomFollowReference.current = false;
        },
        []
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
