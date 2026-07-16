import {
    type Dispatch,
    type MutableRefObject,
    type SetStateAction,
    useEffect,
    useRef,
    useState,
} from "react";

import {
    nextHistoryBottomState,
    nextHistoryLoadSendError,
    nextRefreshedChatMessages,
} from "./chatPageUtilities";
import type { ChatHistoryMessage } from "./chatTypes";
import {
    CHAT_HISTORY_LIMIT,
    chatErrorMessage,
    mergeWithRecentOptimisticMessages,
} from "./chatUtilities";
import type { ChatTransport } from "./transport/chatTransport";

const LIVE_HISTORY_POLL_MS = 2000;

interface ChatHistoryOptions {
    isConnected: boolean;
    onError: Dispatch<SetStateAction<string | undefined>>;
    onSessionChanged(): void;
    selectedSessionKey: string;
    selectedSessionKeyReference: MutableRefObject<string>;
    selectedSessionUpdatedAt?: number;
    setIsAtBottom: Dispatch<SetStateAction<boolean>>;
    shouldStickToBottomReference: MutableRefObject<boolean>;
    transport: ChatTransport;
}

/** Owns canonical transcript loading and opportunistic history refreshes. */
export function useChatHistory({
    isConnected,
    onError,
    onSessionChanged,
    selectedSessionKey,
    selectedSessionKeyReference,
    selectedSessionUpdatedAt,
    setIsAtBottom,
    shouldStickToBottomReference,
    transport,
}: ChatHistoryOptions) {
    const [messages, setMessages] = useState<ChatHistoryMessage[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const loadedSessionReference = useRef("");
    const liveRefreshTimerReference = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );
    const backgroundAbortReference = useRef<AbortController | undefined>(undefined);
    const transportReference = useRef(transport);
    const sessionChangedReference = useRef(onSessionChanged);

    transportReference.current = transport;
    sessionChangedReference.current = onSessionChanged;

    const refreshSoon = (sessionKey: string, delayMs = 450) => {
        if (liveRefreshTimerReference.current !== undefined) {
            clearTimeout(liveRefreshTimerReference.current);
        }
        liveRefreshTimerReference.current = setTimeout(async () => {
            liveRefreshTimerReference.current = undefined;
            if (
                selectedSessionKeyReference.current !== sessionKey ||
                !shouldStickToBottomReference.current
            ) {
                return;
            }
            try {
                const history = await transportReference.current.history(
                    sessionKey,
                    CHAT_HISTORY_LIMIT
                );
                if (selectedSessionKeyReference.current !== sessionKey) {
                    return;
                }
                setMessages((previous) =>
                    mergeWithRecentOptimisticMessages(previous, history)
                );
                setIsAtBottom(true);
            } catch {
                // Runtime state remains authoritative until the next successful poll.
            }
        }, delayMs);
    };

    useEffect(() => {
        if (isConnected) {
            return;
        }
        setIsLoadingHistory(false);
        if (liveRefreshTimerReference.current !== undefined) {
            clearTimeout(liveRefreshTimerReference.current);
            liveRefreshTimerReference.current = undefined;
        }
    }, [isConnected]);

    useEffect(() => {
        const isNewSession = loadedSessionReference.current !== selectedSessionKey;
        if (isNewSession) {
            shouldStickToBottomReference.current = true;
            setIsAtBottom(true);
            sessionChangedReference.current();
        }
        if (!selectedSessionKey) {
            loadedSessionReference.current = "";
            setMessages([]);
            setIsLoadingHistory(false);
            return;
        }
        if (!isConnected) {
            setIsLoadingHistory(false);
            return;
        }

        let isCancelled = false;
        const loadHistory = async () => {
            setIsLoadingHistory(true);
            onError(undefined);
            try {
                const nextMessages = await transportReference.current.history(
                    selectedSessionKey,
                    CHAT_HISTORY_LIMIT
                );
                if (
                    isCancelled ||
                    selectedSessionKeyReference.current !== selectedSessionKey
                ) {
                    return;
                }
                const isFirstLoad = loadedSessionReference.current !== selectedSessionKey;
                loadedSessionReference.current = selectedSessionKey;
                setMessages((previous) =>
                    isFirstLoad
                        ? nextMessages
                        : mergeWithRecentOptimisticMessages(previous, nextMessages)
                );
                if (isNewSession) {
                    shouldStickToBottomReference.current = true;
                }
                setIsAtBottom((previous) =>
                    nextHistoryBottomState(
                        previous,
                        isNewSession,
                        shouldStickToBottomReference.current
                    )
                );
            } catch (error) {
                const historyError = chatErrorMessage(
                    error,
                    "Failed to load chat history"
                );
                onError((previous) =>
                    nextHistoryLoadSendError(previous, isCancelled, historyError)
                );
            } finally {
                if (!isCancelled) {
                    setIsLoadingHistory(false);
                }
            }
        };
        void loadHistory();
        return () => {
            isCancelled = true;
        };
    }, [isConnected, selectedSessionKey]);

    useEffect(() => {
        if (
            !isConnected ||
            !selectedSessionKey ||
            !selectedSessionUpdatedAt ||
            isLoadingHistory
        ) {
            return;
        }
        const requestSessionKey = selectedSessionKey;
        const abortController = new AbortController();
        backgroundAbortReference.current?.abort();
        backgroundAbortReference.current = abortController;
        let isCancelled = false;

        const refreshVisibleHistory = async () => {
            try {
                const nextMessages = await transportReference.current.history(
                    requestSessionKey,
                    CHAT_HISTORY_LIMIT
                );
                if (
                    isCancelled ||
                    abortController.signal.aborted ||
                    selectedSessionKeyReference.current !== requestSessionKey
                ) {
                    return;
                }
                setMessages((previous) =>
                    nextRefreshedChatMessages(previous, nextMessages)
                );
                setIsAtBottom(shouldStickToBottomReference.current);
            } catch {
                // Ignore background refresh failures.
            }
        };
        void refreshVisibleHistory();
        return () => {
            isCancelled = true;
            abortController.abort();
            backgroundAbortReference.current = undefined;
        };
    }, [isConnected, isLoadingHistory, selectedSessionKey, selectedSessionUpdatedAt]);

    useEffect(() => {
        if (!isConnected || !selectedSessionKey) {
            return;
        }
        let isCancelled = false;
        let isRefreshInFlight = false;
        const refreshVisibleHistory = async () => {
            if (
                isRefreshInFlight ||
                document.visibilityState === "hidden" ||
                !shouldStickToBottomReference.current
            ) {
                return;
            }
            isRefreshInFlight = true;
            try {
                const nextMessages = await transportReference.current.history(
                    selectedSessionKey,
                    CHAT_HISTORY_LIMIT
                );
                if (
                    isCancelled ||
                    selectedSessionKeyReference.current !== selectedSessionKey
                ) {
                    return;
                }
                setMessages((previous) =>
                    nextRefreshedChatMessages(previous, nextMessages)
                );
                setIsAtBottom(shouldStickToBottomReference.current);
            } catch {
                // WebSocket runtime events remain the primary live path.
            } finally {
                isRefreshInFlight = false;
            }
        };
        const interval = setInterval(
            () => void refreshVisibleHistory(),
            LIVE_HISTORY_POLL_MS
        );
        return () => {
            isCancelled = true;
            clearInterval(interval);
        };
    }, [isConnected, selectedSessionKey]);

    useEffect(
        () => () => {
            if (liveRefreshTimerReference.current !== undefined) {
                clearTimeout(liveRefreshTimerReference.current);
            }
            backgroundAbortReference.current?.abort();
        },
        []
    );

    const visibleMessages =
        loadedSessionReference.current === selectedSessionKey ? messages : [];
    return {
        isLoadingHistory,
        messages: visibleMessages,
        refreshSoon,
        setMessages,
    };
}
