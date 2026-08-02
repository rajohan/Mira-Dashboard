import {
    type Dispatch,
    type RefObject,
    type SetStateAction,
    useEffect,
    useEffectEvent,
    useRef,
    useState,
} from "react";

import { messageFromError } from "../../../lib/errorMessage";
import { isBrowserPollingAllowed, refreshPolicy } from "../../../lib/refreshPolicy";
import {
    CHAT_HISTORY_LIMIT,
    mergeWithRecentOptimisticMessages,
} from "./chatMessageReconciliation";
import {
    nextRefreshedChatMessages,
    shouldStayAtHistoryBottom,
} from "./chatPageUtilities";
import type { ChatHistoryMessage } from "./chatTypes";
import type { ChatTransport } from "./transport/chatTransport";

const LIVE_HISTORY_POLL_MS = refreshPolicy.live;

interface ChatHistoryOptions {
    isConnected: boolean;
    onError: Dispatch<SetStateAction<string | undefined>>;
    selectedSessionKey: string;
    selectedSessionKeyRef: RefObject<string>;
    selectedSessionUpdatedAt?: number;
    setIsAtBottom: Dispatch<SetStateAction<boolean>>;
    shouldStickToBottomRef: RefObject<boolean>;
    transport: ChatTransport;
}

interface ChatHistoryState {
    isResolved: boolean;
    messages: ChatHistoryMessage[];
    resolvedConnectionGeneration?: number;
    sessionKey: string;
}

type ChatHistoryRequestResult =
    | { status: "ignored" }
    | { error: string; status: "error" }
    | { messages: ChatHistoryMessage[]; status: "success" };

/**
 * Owns canonical transcript loading and opportunistic history refreshes.
 * @returns Chat history state and actions.
 */
export function useChatHistory({
    isConnected,
    onError,
    selectedSessionKey,
    selectedSessionKeyRef,
    selectedSessionUpdatedAt,
    setIsAtBottom,
    shouldStickToBottomRef,
    transport,
}: ChatHistoryOptions) {
    const [historyState, setHistoryState] = useState<ChatHistoryState>({
        isResolved: false,
        messages: [],
        sessionKey: "",
    });
    const liveRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );
    const backgroundAbortRef = useRef<AbortController | undefined>(undefined);
    const historyLoadSessionRef = useRef("");
    const historyRequestSequenceRef = useRef(0);
    const latestAppliedHistoryRequestRef = useRef(0);

    const beginHistoryRequest = () => {
        historyRequestSequenceRef.current += 1;
        return historyRequestSequenceRef.current;
    };

    const canApplyHistoryResponse = (sessionKey: string, requestSequence: number) => {
        if (
            selectedSessionKeyRef.current !== sessionKey ||
            requestSequence < latestAppliedHistoryRequestRef.current
        ) {
            return false;
        }
        latestAppliedHistoryRequestRef.current = requestSequence;
        return true;
    };
    const reportErrorFromEffect = useEffectEvent(
        (value: SetStateAction<string | undefined>) => onError(value)
    );
    const setIsAtBottomFromEffect = useEffectEvent((value: SetStateAction<boolean>) =>
        setIsAtBottom(value)
    );

    const refreshSoon = (sessionKey: string, delayMs = 450) => {
        if (liveRefreshTimerRef.current !== undefined) {
            clearTimeout(liveRefreshTimerRef.current);
        }
        liveRefreshTimerRef.current = setTimeout(() => {
            void (async () => {
                liveRefreshTimerRef.current = undefined;
                if (selectedSessionKeyRef.current !== sessionKey) {
                    return;
                }
                const requestSequence = beginHistoryRequest();
                const requestConnectionGeneration = transport.connectionGeneration;
                try {
                    const history = await transport.history(
                        sessionKey,
                        CHAT_HISTORY_LIMIT
                    );
                    if (!canApplyHistoryResponse(sessionKey, requestSequence)) {
                        return;
                    }
                    setHistoryState((previous) => ({
                        isResolved: true,
                        messages: nextRefreshedChatMessages(
                            previous.sessionKey === sessionKey ? previous.messages : [],
                            history
                        ),
                        resolvedConnectionGeneration: requestConnectionGeneration,
                        sessionKey,
                    }));
                    if (shouldStickToBottomRef.current) {
                        setIsAtBottom(true);
                    }
                } catch {
                    // Runtime state remains authoritative until the next successful poll.
                }
            })();
        }, delayMs);
    };

    const requestHistory = useEffectEvent(
        async (
            sessionKey: string,
            signal: AbortSignal
        ): Promise<ChatHistoryRequestResult> => {
            const requestSequence = beginHistoryRequest();
            try {
                const nextMessages = await transport.history(
                    sessionKey,
                    CHAT_HISTORY_LIMIT
                );
                if (
                    signal.aborted ||
                    !canApplyHistoryResponse(sessionKey, requestSequence)
                ) {
                    return { status: "ignored" };
                }
                return { messages: nextMessages, status: "success" };
            } catch (error) {
                const shouldIgnoreError =
                    signal.aborted ||
                    requestSequence < latestAppliedHistoryRequestRef.current;
                if (shouldIgnoreError) {
                    return { status: "ignored" };
                }
                return {
                    error: messageFromError(error, "Failed to load chat history"),
                    status: "error",
                };
            }
        }
    );

    useEffect(() => {
        if (isConnected) {
            return;
        }
        if (liveRefreshTimerRef.current !== undefined) {
            clearTimeout(liveRefreshTimerRef.current);
            liveRefreshTimerRef.current = undefined;
        }
    }, [isConnected]);

    useEffect(() => {
        if (!selectedSessionKey) {
            historyLoadSessionRef.current = "";
            return;
        }
        if (!isConnected) {
            return;
        }

        const abortController = new AbortController();
        const isNewSession = historyLoadSessionRef.current !== selectedSessionKey;
        const requestConnectionGeneration = transport.connectionGeneration;
        historyLoadSessionRef.current = selectedSessionKey;
        void (async () => {
            const result = await requestHistory(
                selectedSessionKey,
                abortController.signal
            );
            if (result.status === "ignored") {
                return;
            }
            if (result.status === "error") {
                setHistoryState((previous) => ({
                    isResolved: true,
                    messages:
                        previous.sessionKey === selectedSessionKey
                            ? previous.messages
                            : [],
                    resolvedConnectionGeneration: requestConnectionGeneration,
                    sessionKey: selectedSessionKey,
                }));
                reportErrorFromEffect(result.error);
                return;
            }
            setHistoryState((previous) => ({
                isResolved: true,
                messages: mergeWithRecentOptimisticMessages(
                    previous.sessionKey === selectedSessionKey ? previous.messages : [],
                    result.messages
                ),
                resolvedConnectionGeneration: requestConnectionGeneration,
                sessionKey: selectedSessionKey,
            }));
            reportErrorFromEffect(undefined);
            if (isNewSession) {
                shouldStickToBottomRef.current = true;
            }
            setIsAtBottomFromEffect((previous) =>
                shouldStayAtHistoryBottom(
                    previous,
                    isNewSession,
                    shouldStickToBottomRef.current
                )
            );
        })();
        return () => abortController.abort();
    }, [
        isConnected,
        selectedSessionKey,
        shouldStickToBottomRef,
        transport.connectionGeneration,
    ]);

    useEffect(() => {
        if (
            !isConnected ||
            !selectedSessionKey ||
            !selectedSessionUpdatedAt ||
            historyState.sessionKey !== selectedSessionKey ||
            !historyState.isResolved ||
            historyState.resolvedConnectionGeneration !== transport.connectionGeneration
        ) {
            return;
        }
        const requestSessionKey = selectedSessionKey;
        const requestConnectionGeneration = transport.connectionGeneration;
        const abortController = new AbortController();
        backgroundAbortRef.current?.abort();
        backgroundAbortRef.current = abortController;
        void (async () => {
            const result = await requestHistory(
                requestSessionKey,
                abortController.signal
            );
            if (result.status !== "success") {
                return;
            }
            setHistoryState((previous) => ({
                isResolved: true,
                messages: nextRefreshedChatMessages(
                    previous.sessionKey === requestSessionKey ? previous.messages : [],
                    result.messages
                ),
                resolvedConnectionGeneration: requestConnectionGeneration,
                sessionKey: requestSessionKey,
            }));
            setIsAtBottomFromEffect(shouldStickToBottomRef.current);
        })();
        return () => {
            abortController.abort();
            if (backgroundAbortRef.current === abortController) {
                backgroundAbortRef.current = undefined;
            }
        };
    }, [
        historyState.isResolved,
        historyState.resolvedConnectionGeneration,
        historyState.sessionKey,
        isConnected,
        selectedSessionKey,
        selectedSessionUpdatedAt,
        shouldStickToBottomRef,
        transport.connectionGeneration,
    ]);

    useEffect(() => {
        if (!isConnected || !selectedSessionKey) {
            return;
        }
        const abortController = new AbortController();
        let isRefreshInFlight = false;
        const pollVisibleHistory = async () => {
            if (
                isRefreshInFlight ||
                !isBrowserPollingAllowed() ||
                !shouldStickToBottomRef.current
            ) {
                return;
            }
            isRefreshInFlight = true;
            const requestConnectionGeneration = transport.connectionGeneration;
            try {
                const result = await requestHistory(
                    selectedSessionKey,
                    abortController.signal
                );
                if (result.status !== "success") {
                    return;
                }
                setHistoryState((previous) => ({
                    isResolved: true,
                    messages: nextRefreshedChatMessages(
                        previous.sessionKey === selectedSessionKey
                            ? previous.messages
                            : [],
                        result.messages
                    ),
                    resolvedConnectionGeneration: requestConnectionGeneration,
                    sessionKey: selectedSessionKey,
                }));
                setIsAtBottomFromEffect(shouldStickToBottomRef.current);
            } finally {
                isRefreshInFlight = false;
            }
        };
        const interval = setInterval(
            () => void pollVisibleHistory(),
            LIVE_HISTORY_POLL_MS
        );
        return () => {
            abortController.abort();
            clearInterval(interval);
        };
    }, [
        isConnected,
        selectedSessionKey,
        shouldStickToBottomRef,
        transport.connectionGeneration,
    ]);

    useEffect(
        () => () => {
            if (liveRefreshTimerRef.current !== undefined) {
                clearTimeout(liveRefreshTimerRef.current);
            }
            backgroundAbortRef.current?.abort();
        },
        []
    );

    const visibleMessages =
        historyState.sessionKey === selectedSessionKey ? historyState.messages : [];
    const isLoadingHistory =
        isConnected &&
        Boolean(selectedSessionKey) &&
        (historyState.sessionKey !== selectedSessionKey ||
            !historyState.isResolved ||
            historyState.resolvedConnectionGeneration !== transport.connectionGeneration);
    const setMessages: Dispatch<SetStateAction<ChatHistoryMessage[]>> = (action) => {
        setHistoryState((previous) => {
            const currentMessages =
                previous.sessionKey === selectedSessionKey ? previous.messages : [];
            return {
                isResolved:
                    previous.sessionKey === selectedSessionKey && previous.isResolved,
                messages: typeof action === "function" ? action(currentMessages) : action,
                resolvedConnectionGeneration:
                    previous.sessionKey === selectedSessionKey
                        ? previous.resolvedConnectionGeneration
                        : undefined,
                sessionKey: selectedSessionKey,
            };
        });
    };
    return {
        isLoadingHistory,
        messages: visibleMessages,
        refreshSoon,
        setMessages,
    };
}
