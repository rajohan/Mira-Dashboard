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
    const messagesBottomReference = useRef<HTMLDivElement | undefined>(undefined);
    const bottomFollowFrameReference = useRef<number | undefined>(undefined);
    const previousRowsLengthReference = useRef(0);
    const previousSessionKeyReference = useRef("");

    const virtualizer = useVirtualizer({
        anchorTo: "end",
        count: rows.length,
        estimateSize: (index) =>
            rows[index]?.kind === "typing"
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
        const atBottom = checkIsAtBottom();
        shouldStickToBottomReference.current = atBottom;
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
        if (bottomFollowFrameReference.current !== undefined) {
            return;
        }
        bottomFollowFrameReference.current = requestAnimationFrame(() => {
            bottomFollowFrameReference.current = undefined;
            if (shouldStickToBottomReference.current) {
                scrollToBottom();
            }
        });
    };

    const handleDynamicContentLoad = () => {
        if (shouldStickToBottomReference.current) {
            scheduleBottomFollow();
        }
    };

    useLayoutEffect(() => {
        const isSessionChanged =
            previousSessionKeyReference.current !== selectedSessionKey;
        const isInitialHistory =
            previousRowsLengthReference.current === 0 && rows.length > 0;
        previousSessionKeyReference.current = selectedSessionKey;
        previousRowsLengthReference.current = rows.length;

        if (isSessionChanged) {
            shouldStickToBottomReference.current = true;
            setIsAtBottom(true);
        }
        if (rows.length > 0 && (isSessionChanged || isInitialHistory)) {
            scheduleBottomFollow();
        }
    }, [rows.length, selectedSessionKey]);

    useLayoutEffect(
        () => () => {
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
