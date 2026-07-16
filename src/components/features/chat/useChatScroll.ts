import { useVirtualizer } from "@tanstack/react-virtual";
import {
    type Dispatch,
    type MutableRefObject,
    type SetStateAction,
    useLayoutEffect,
    useRef,
} from "react";

import { scheduleBottomFollowWhenNeeded } from "./chatPageUtilities";
import type { ChatRow } from "./chatTypes";

const BOTTOM_THRESHOLD_PX = 32;
const NO_SCROLL_ELEMENT = JSON.parse("null") as HTMLDivElement | null;

/** Owns virtualized chat scrolling independently from transport/runtime state. */
export function useChatScroll(
    rows: ChatRow[],
    activityFingerprint: string,
    selectedSessionKey: string,
    setIsAtBottom: Dispatch<SetStateAction<boolean>>,
    shouldStickToBottomReference: MutableRefObject<boolean>
) {
    const messagesContainerReference = useRef<HTMLDivElement | undefined>(undefined);
    const messagesBottomReference = useRef<HTMLDivElement | undefined>(undefined);
    const previousRowsLengthReference = useRef(0);
    const previousSessionKeyReference = useRef("");
    const previousActivityReference = useRef("");
    const bottomFollowFrameReference = useRef<number | undefined>(undefined);

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
            scrollToBottom();
        });
    };

    const virtualizer = useVirtualizer({
        count: rows.length,
        getItemKey: (index) => rows[index]?.key ?? `row-${index}`,
        getScrollElement: () => messagesContainerReference.current ?? NO_SCROLL_ELEMENT,
        estimateSize: (index) => (rows[index]?.kind === "typing" ? 76 : 160),
        overscan: 12,
        useAnimationFrameWithResizeObserver: true,
        onChange: (_instance, sync) => {
            if (!sync && shouldStickToBottomReference.current) {
                scheduleBottomFollow();
            }
        },
    });

    const handleDynamicContentLoad = () => {
        scheduleBottomFollowWhenNeeded(
            shouldStickToBottomReference.current,
            scheduleBottomFollow
        );
    };

    useLayoutEffect(() => {
        const isSessionChanged =
            previousSessionKeyReference.current !== selectedSessionKey;
        const isRowsAdded = rows.length > previousRowsLengthReference.current;
        const isActivityChanged =
            previousActivityReference.current !== activityFingerprint;

        previousSessionKeyReference.current = selectedSessionKey;
        previousRowsLengthReference.current = rows.length;
        previousActivityReference.current = activityFingerprint;

        if (rows.length === 0) {
            return;
        }
        if (isSessionChanged) {
            shouldStickToBottomReference.current = true;
            scrollToBottom();
            return;
        }
        if (
            !shouldStickToBottomReference.current ||
            (!isRowsAdded && !isActivityChanged)
        ) {
            return;
        }

        scrollToBottom();
        const frame = requestAnimationFrame(scrollToBottom);
        return () => cancelAnimationFrame(frame);
    }, [activityFingerprint, rows.length, selectedSessionKey]);

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
