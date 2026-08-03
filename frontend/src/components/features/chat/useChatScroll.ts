import { useVirtualizer } from "@tanstack/react-virtual";
import {
    type Dispatch,
    type RefObject,
    type SetStateAction,
    useEffectEvent,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import type { ChatRow } from "./chatTypes";
import {
    chatUnreadMessageIdentities,
    type ChatUnreadMessageIdentity,
    countAddedChatUnreadMessages,
} from "./chatUnreadMessages";

const BOTTOM_THRESHOLD_PX = 32;
const STRUCTURAL_BOTTOM_STABLE_FRAMES = 2;
const STRUCTURAL_BOTTOM_MAX_WAIT_FRAMES = 12;
const ESTIMATED_MESSAGE_ROW_HEIGHT_PX = 160;
const ESTIMATED_TYPING_ROW_HEIGHT_PX = 76;

/**
 * Owns sticky-bottom state and delegates viewport anchoring to the virtualizer.
 * @param rows Rows value.
 * @param selectedSessionKey Selected session key value.
 * @param setIsAtBottom Set is at bottom value.
 * @param shouldStickToBottomRef Whether should stick to bottom ref.
 * @param isLoadingHistory Whether is loading history.
 * @param composerLayoutKey Composer layout key value.
 * @returns Chat scroll state and actions.
 */
export function useChatScroll(
    rows: ChatRow[],
    selectedSessionKey: string,
    setIsAtBottom: Dispatch<SetStateAction<boolean>>,
    shouldStickToBottomRef: RefObject<boolean>,
    isLoadingHistory = false,
    composerLayoutKey: number | string = 0
) {
    const messagesContainerRef = useRef<HTMLDivElement | undefined>(undefined);
    const bottomFollowFrameRef = useRef<number | undefined>(undefined);
    const bottomFollowFramesRemainingRef = useRef(0);
    const bottomFollowLastHeightRef = useRef<number | undefined>(undefined);
    const bottomFollowNeedsPrimeRef = useRef(false);
    const bottomFollowStableFramesRef = useRef(0);
    const resumeStickyBottomRef = useRef<() => void>(() => {});
    const structuralBottomFollowRef = useRef(false);
    const wasStickyWhenDocumentHiddenRef = useRef(false);
    const previousUnreadMessageIdentitiesRef = useRef<ChatUnreadMessageIdentity[]>([]);
    const previousRowKeysRef = useRef<string[]>([]);
    const previousComposerLayoutKeyRef = useRef(composerLayoutKey);
    const previousIsLoadingHistoryRef = useRef(false);
    const previousScrollTopRef = useRef(0);
    const previousSessionKeyRef = useRef("");
    const [newMessageCount, setNewMessageCount] = useState(0);

    const virtualizer = useVirtualizer({
        anchorTo: "end",
        count: rows.length,
        estimateSize: (index) =>
            rows[index]?.kind === "typing" || rows[index]?.kind === "status"
                ? ESTIMATED_TYPING_ROW_HEIGHT_PX
                : ESTIMATED_MESSAGE_ROW_HEIGHT_PX,
        followOnAppend: "auto",
        getItemKey: (index) => rows[index]?.key ?? `row-${index}`,
        getScrollElement: () => messagesContainerRef.current ?? null,
        overscan: 12,
        scrollEndThreshold: BOTTOM_THRESHOLD_PX,
        useAnimationFrameWithResizeObserver: true,
    });

    const checkIsAtBottom = () => {
        const container = messagesContainerRef.current;
        if (!container) {
            return true;
        }
        return (
            container.scrollHeight - container.scrollTop - container.clientHeight <=
            BOTTOM_THRESHOLD_PX
        );
    };

    const resetStructuralFollowState = () => {
        structuralBottomFollowRef.current = false;
        bottomFollowFramesRemainingRef.current = 0;
        bottomFollowLastHeightRef.current = undefined;
        bottomFollowNeedsPrimeRef.current = false;
        bottomFollowStableFramesRef.current = 0;
    };

    const cancelBottomFollow = () => {
        resetStructuralFollowState();
        if (bottomFollowFrameRef.current === undefined) {
            return;
        }
        cancelAnimationFrame(bottomFollowFrameRef.current);
        bottomFollowFrameRef.current = undefined;
    };

    const handleScroll = () => {
        const container = messagesContainerRef.current;
        const scrollTop = container?.scrollTop ?? 0;
        const didScrollUp = scrollTop + 1 < previousScrollTopRef.current;
        const isStructuralCorrectionPending =
            didScrollUp &&
            structuralBottomFollowRef.current &&
            bottomFollowFrameRef.current !== undefined;
        if (
            didScrollUp &&
            !isStructuralCorrectionPending &&
            bottomFollowFrameRef.current !== undefined
        ) {
            cancelBottomFollow();
        }
        const isAtBottom = checkIsAtBottom();
        if (isAtBottom) {
            setNewMessageCount(0);
        }
        const shouldStaySticky =
            isAtBottom ||
            (shouldStickToBottomRef.current &&
                (!didScrollUp || isStructuralCorrectionPending));
        previousScrollTopRef.current = scrollTop;
        shouldStickToBottomRef.current = shouldStaySticky;
        setIsAtBottom((previous) =>
            previous === shouldStaySticky ? previous : shouldStaySticky
        );
    };

    const scrollToBottom = () => {
        const container = messagesContainerRef.current;
        if (!container) {
            return;
        }
        container.scrollTop = container.scrollHeight;
        previousScrollTopRef.current = container.scrollTop;
        shouldStickToBottomRef.current = true;
        setIsAtBottom(true);
        setNewMessageCount(0);
    };

    const scheduleBottomFollow = (
        isStructuralCorrection = false,
        shouldPrimeBottom = false
    ) => {
        if (isStructuralCorrection) {
            structuralBottomFollowRef.current = true;
            bottomFollowFramesRemainingRef.current = STRUCTURAL_BOTTOM_MAX_WAIT_FRAMES;
            bottomFollowLastHeightRef.current = undefined;
            bottomFollowNeedsPrimeRef.current ||= shouldPrimeBottom;
            bottomFollowStableFramesRef.current = 0;
        }
        if (bottomFollowFrameRef.current !== undefined) {
            return;
        }
        const followBottom = () => {
            if (!shouldStickToBottomRef.current) {
                cancelBottomFollow();
                return;
            }
            if (bottomFollowNeedsPrimeRef.current) {
                bottomFollowNeedsPrimeRef.current = false;
                scrollToBottom();
                bottomFollowLastHeightRef.current = undefined;
                bottomFollowStableFramesRef.current = 0;
                bottomFollowFrameRef.current = requestAnimationFrame(followBottom);
                return;
            }
            if (structuralBottomFollowRef.current) {
                const currentHeight = messagesContainerRef.current?.scrollHeight;
                const previousHeight = bottomFollowLastHeightRef.current;
                bottomFollowLastHeightRef.current = currentHeight;
                bottomFollowStableFramesRef.current =
                    currentHeight !== undefined && currentHeight === previousHeight
                        ? bottomFollowStableFramesRef.current + 1
                        : 0;
                bottomFollowFramesRemainingRef.current -= 1;
            }
            const shouldWaitForStableHeight =
                structuralBottomFollowRef.current &&
                bottomFollowStableFramesRef.current < STRUCTURAL_BOTTOM_STABLE_FRAMES &&
                bottomFollowFramesRemainingRef.current > 0;
            if (shouldWaitForStableHeight) {
                bottomFollowFrameRef.current = requestAnimationFrame(followBottom);
                return;
            }
            scrollToBottom();
            bottomFollowFrameRef.current = undefined;
            resetStructuralFollowState();
        };
        bottomFollowFrameRef.current = requestAnimationFrame(followBottom);
    };
    const followToBottom = () => {
        shouldStickToBottomRef.current = true;
        setIsAtBottom(true);
        setNewMessageCount(0);
        scheduleBottomFollow(true, true);
    };
    resumeStickyBottomRef.current = followToBottom;

    const handleUserScrollIntent = () => {
        cancelBottomFollow();
    };

    const handleDynamicContentLoad = () => {
        if (shouldStickToBottomRef.current) {
            scheduleBottomFollow();
        }
    };

    const synchronizeViewportLayout = useEffectEvent(() => {
        const isSessionChanged = previousSessionKeyRef.current !== selectedSessionKey;
        const previousRowKeys = previousRowKeysRef.current;
        const rowKeys = rows.map((row) => row.key);
        const unreadMessageIdentities = chatUnreadMessageIdentities(rows);
        const addedConversationMessageCount = countAddedChatUnreadMessages(
            previousUnreadMessageIdentitiesRef.current,
            unreadMessageIdentities
        );
        const isInitialHistoryLoad = previousRowKeys.length === 0 && rowKeys.length > 0;
        const didRowKeysChange =
            previousRowKeys.length !== rowKeys.length ||
            previousRowKeys.some((key, index) => key !== rowKeys[index]);
        const isPureTailAppend =
            rowKeys.length > previousRowKeys.length &&
            previousRowKeys.every((key, index) => rowKeys[index] === key);
        const isNeedsStructuralBottomFollow =
            previousRowKeys.length > 0 && didRowKeysChange && !isPureTailAppend;
        const didFinishHistoryLoad =
            previousIsLoadingHistoryRef.current && !isLoadingHistory;
        const didComposerLayoutChange =
            previousComposerLayoutKeyRef.current !== composerLayoutKey;
        previousSessionKeyRef.current = selectedSessionKey;
        previousUnreadMessageIdentitiesRef.current = unreadMessageIdentities;
        previousRowKeysRef.current = rowKeys;
        previousIsLoadingHistoryRef.current = isLoadingHistory;
        previousComposerLayoutKeyRef.current = composerLayoutKey;

        if (isSessionChanged) {
            previousScrollTopRef.current = 0;
            shouldStickToBottomRef.current = true;
            setIsAtBottom(true);
            setNewMessageCount(0);
        } else if (
            previousRowKeys.length > 0 &&
            !shouldStickToBottomRef.current &&
            addedConversationMessageCount > 0
        ) {
            setNewMessageCount((previous) => previous + addedConversationMessageCount);
        }
        if (
            rows.length > 0 &&
            shouldStickToBottomRef.current &&
            (isSessionChanged ||
                isInitialHistoryLoad ||
                isNeedsStructuralBottomFollow ||
                didFinishHistoryLoad ||
                didComposerLayoutChange)
        ) {
            if (didComposerLayoutChange) {
                scrollToBottom();
            }
            scheduleBottomFollow(
                true,
                isSessionChanged || isInitialHistoryLoad || didFinishHistoryLoad
            );
        }
    });
    const cancelBottomFollowOnCleanup = useEffectEvent(cancelBottomFollow);
    const handleDocumentVisibilityChange = useEffectEvent(() => {
        if (document.visibilityState === "hidden") {
            wasStickyWhenDocumentHiddenRef.current = shouldStickToBottomRef.current;
            return;
        }
        if (!wasStickyWhenDocumentHiddenRef.current) {
            return;
        }
        wasStickyWhenDocumentHiddenRef.current = false;
        resumeStickyBottomRef.current();
    });

    useLayoutEffect(() => {
        synchronizeViewportLayout();
    }, [composerLayoutKey, isLoadingHistory, rows, selectedSessionKey]);

    useLayoutEffect(() => () => cancelBottomFollowOnCleanup(), []);

    useLayoutEffect(() => {
        const handleVisibilityChange = () => handleDocumentVisibilityChange();
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () =>
            document.removeEventListener("visibilitychange", handleVisibilityChange);
    }, []);

    return {
        handleDynamicContentLoad,
        handleScroll,
        handleUserScrollIntent,
        messagesContainerRef: messagesContainerRef,
        newMessageCount,
        scheduleBottomFollow,
        followToBottom,
        virtualizer,
    };
}
