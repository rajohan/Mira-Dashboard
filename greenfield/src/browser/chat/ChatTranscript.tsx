import { ArrowDown, LoaderCircle, MessagesSquare } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable transcript log must be keyboard-focusable. */

import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Virtualizer, type VirtualizerItemsAppendedEvent } from "../ui/Virtualizer.tsx";
import { ChatMessageBubble } from "./ChatMessageBubble.tsx";
import { visibleChatTranscriptMessages } from "./chatMessageVisibility.ts";
import { activeStreamingTextMessageIds } from "./chatReadAloudProjection.ts";
import {
    activeCompactionMaximumAgeMs,
    completedCompactionMaximumAgeMs,
    projectChatTranscriptMessages,
} from "./chatTranscriptProjection.ts";
import type {
    ChatDisplayMessage,
    ChatDisplaySettings,
    ChatReadAloudView,
} from "./chatTypes.ts";

const estimatedMessageHeightPx = 148;
const olderHistoryLoadThresholdPx = 32;

function hashRevisionPart(hash: number, value: string): number {
    let next = hash;
    for (let index = 0; index < value.length; index += 1) {
        const codePoint = value.codePointAt(index) ?? 0;
        next ^= codePoint;
        next = Math.imul(next, 16_777_619);
        if (codePoint > 65_535) index += 1;
    }
    return next >>> 0;
}

function revisionDetail(value: unknown): string {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return "[unavailable]";
    }
}

function messageRevision(message: ChatDisplayMessage): number {
    let hash = hashRevisionPart(
        2_166_136_261,
        `${message.delivery ?? ""}|${message.hydration ?? ""}`
    );
    for (const attachment of message.attachments) {
        hash = hashRevisionPart(
            hash,
            `${attachment.id}|${attachment.status ?? ""}|${attachment.progress ?? ""}|${attachment.renderPolicy ?? ""}`
        );
    }
    for (const part of message.parts) {
        if (part.kind === "text" || part.kind === "thinking") {
            hash = hashRevisionPart(
                hash,
                `${part.kind}|${part.kind === "thinking" ? part.status : ""}|${part.text}`
            );
        } else if (part.kind === "control") {
            hash = hashRevisionPart(
                hash,
                `${part.kind}|${part.tone}|${part.activity ?? ""}|${part.text}`
            );
        } else {
            hash = hashRevisionPart(
                hash,
                `${part.kind}|${part.callId}|${part.callIdSource ?? ""}|${part.name}|${part.status}|${revisionDetail(part.input)}|${part.error ?? ""}|${revisionDetail(part.output)}`
            );
        }
    }
    return hash;
}

function isActivityOnlyMessage(message: ChatDisplayMessage): boolean {
    return (
        message.parts.length > 0 &&
        message.parts.every(
            (part) => part.kind === "control" && part.activity !== undefined
        )
    );
}

function transcriptLayoutRevision(
    messages: readonly ChatDisplayMessage[],
    display: ChatDisplaySettings,
    activeRunIds: readonly string[],
    readAloud: ChatReadAloudView | undefined
): number {
    let hash = hashRevisionPart(
        2_166_136_261,
        `${display.keepThinkingAfterFinal}|${display.showThinking}|${display.showTools}|${display.toolsExpanded}`
    );
    for (const activeRunId of activeRunIds) {
        hash = hashRevisionPart(hash, activeRunId);
    }
    for (const message of messages) {
        hash = hashRevisionPart(hash, `${message.id}|${messageRevision(message)}`);
    }
    if (readAloud !== undefined) {
        hash = hashRevisionPart(
            hash,
            `${readAloud.phase}|${readAloud.activeMessageId ?? ""}|${readAloud.errorMessageId ?? ""}|${readAloud.error ?? ""}`
        );
    }
    return hash;
}

interface ChatTranscriptProps {
    readonly activeRunIds?: readonly string[];
    readonly display: ChatDisplaySettings;
    readonly hasOlder: boolean;
    readonly initialLoading: boolean;
    readonly messages: readonly ChatDisplayMessage[];
    readonly onDismissReadAloudError?: () => void;
    readonly onHydrateMessage: (messageId: string) => void;
    readonly onLoadOlder: () => boolean | Promise<boolean>;
    readonly onOpenLocalFile?: (reference: string) => void;
    readonly onReadAloud?: (messageId: string, text: string) => void;
    readonly onStopReadAloud?: () => void;
    readonly readAloud?: ChatReadAloudView;
    readonly sessionKey: string;
}

interface ChatTranscriptNotice {
    readonly announcement: string;
    readonly newMessageCount: number;
    readonly sessionKey: string;
}

function emptyTranscriptNotice(sessionKey: string): ChatTranscriptNotice {
    return { announcement: "", newMessageCount: 0, sessionKey };
}

function compactionTimings(messages: readonly ChatDisplayMessage[]): readonly Readonly<{
    expiresAtMs: number;
    revision: readonly [string, number, number, "complete" | "running"];
}>[] {
    return messages.flatMap((message) => {
        const timestampMs = message.timestampMs;
        if (timestampMs === undefined) return [];
        return message.parts.flatMap((part, index) => {
            if (part.kind !== "control" || part.activity === undefined) return [];
            return [
                {
                    expiresAtMs:
                        timestampMs +
                        (part.activity === "running"
                            ? activeCompactionMaximumAgeMs
                            : completedCompactionMaximumAgeMs),
                    revision: [message.id, timestampMs, index, part.activity] as const,
                },
            ];
        });
    });
}

/**
 * Virtualizes hydrated chat history while preserving prepend and follow anchors.
 * @returns One accessible virtual transcript.
 */
export function ChatTranscript({
    activeRunIds = [],
    display,
    hasOlder,
    initialLoading,
    messages,
    onDismissReadAloudError,
    onHydrateMessage,
    onLoadOlder,
    onOpenLocalFile,
    onReadAloud,
    onStopReadAloud,
    readAloud,
    sessionKey,
}: ChatTranscriptProps) {
    const olderHistoryRequestPending = useRef(false);
    const olderHistoryCycleActive = useRef(false);
    const [, completeOlderHistoryRequest] = useState(0);
    const [olderHistoryCycleLoading, setOlderHistoryCycleLoading] = useState(false);
    const historyViewport = useRef<HTMLDivElement>(null);
    const previousHistoryScrollTop = useRef(0);
    const preserveHistoryAnchor = useRef<(() => void) | null>(null);
    const [notice, setNotice] = useState<ChatTranscriptNotice>(() =>
        emptyTranscriptNotice(sessionKey)
    );
    const timings = compactionTimings(messages);
    const compactionRevision = JSON.stringify(timings.map(({ revision }) => revision));
    const [nowMs, setNowMs] = useState(() => Date.now());
    const nextCompactionExpiry = timings
        .map(({ expiresAtMs }) => expiresAtMs)
        .filter((expiry) => expiry > nowMs)
        .toSorted((left, right) => left - right)[0];
    const currentNotice =
        notice.sessionKey === sessionKey ? notice : emptyTranscriptNotice(sessionKey);
    const transcriptMessages = projectChatTranscriptMessages(
        messages,
        activeRunIds,
        sessionKey,
        nowMs
    );
    const visibleMessages = visibleChatTranscriptMessages(
        transcriptMessages,
        display,
        readAloud
    );
    const streamingTextMessageIds = activeStreamingTextMessageIds(
        visibleMessages,
        activeRunIds
    );
    const layoutRevision = transcriptLayoutRevision(
        visibleMessages,
        display,
        activeRunIds,
        readAloud
    );
    const stopReadAloud = useEffectEvent(() => onStopReadAloud?.());
    const stopActiveReadAloud = useEffectEvent(() => {
        if (readAloud?.phase !== "idle") stopReadAloud();
    });
    async function requestOlderAtTop(): Promise<void> {
        if (
            historyViewport.current === null ||
            historyViewport.current.scrollTop > olderHistoryLoadThresholdPx ||
            !hasOlder ||
            olderHistoryRequestPending.current
        ) {
            return;
        }
        olderHistoryRequestPending.current = true;
        setOlderHistoryCycleLoading(true);
        preserveHistoryAnchor.current?.();
        try {
            if (!(await onLoadOlder())) {
                olderHistoryCycleActive.current = false;
                setOlderHistoryCycleLoading(false);
            }
        } catch {
            olderHistoryCycleActive.current = false;
            setOlderHistoryCycleLoading(false);
        } finally {
            olderHistoryRequestPending.current = false;
            requestAnimationFrame(() =>
                completeOlderHistoryRequest((current) => current + 1)
            );
        }
    }
    function handleHistoryScroll(): void {
        const scrollTop = historyViewport.current?.scrollTop ?? 0;
        const movedUp = scrollTop + 1 < previousHistoryScrollTop.current;
        previousHistoryScrollTop.current = scrollTop;
        if (!movedUp) return;
        olderHistoryCycleActive.current = true;
        void requestOlderAtTop();
    }
    function handleHistoryWheel(deltaY: number): void {
        if (deltaY >= 0) return;
        olderHistoryCycleActive.current = true;
        void requestOlderAtTop();
    }
    function handleItemsAppended({
        itemKeys,
        wasFollowing,
    }: VirtualizerItemsAppendedEvent): void {
        const addedIds = new Set(itemKeys.map(String));
        const assistantCount = visibleMessages.filter(
            (message) => addedIds.has(message.id) && message.role === "assistant"
        ).length;
        if (assistantCount === 0) return;
        if (wasFollowing) {
            setNotice(emptyTranscriptNotice(sessionKey));
            requestAnimationFrame(() => {
                setNotice((current) =>
                    current.sessionKey === sessionKey
                        ? { ...current, announcement: "New message from Mira." }
                        : current
                );
            });
            return;
        }
        setNotice((current) => {
            const active =
                current.sessionKey === sessionKey
                    ? current
                    : emptyTranscriptNotice(sessionKey);
            return {
                ...active,
                newMessageCount: active.newMessageCount + assistantCount,
            };
        });
    }

    function handleFollowingChange(following: boolean): void {
        if (!following) return;
        setNotice((current) =>
            current.sessionKey === sessionKey
                ? { ...current, newMessageCount: 0 }
                : emptyTranscriptNotice(sessionKey)
        );
    }

    useEffect(() => () => stopActiveReadAloud(), [sessionKey]);
    useLayoutEffect(() => {
        const currentTimeMs = Date.now();
        // oxlint-disable-next-line react/react-compiler -- A changed provider lifecycle must refresh the external wall clock before paint so an already-expired status never flashes.
        setNowMs((previous) => Math.max(previous, currentTimeMs));
    }, [compactionRevision]);
    useEffect(() => {
        if (nextCompactionExpiry === undefined) return;
        const timeout = globalThis.setTimeout(
            () => setNowMs(Date.now()),
            Math.max(0, nextCompactionExpiry - nowMs)
        );
        return () => globalThis.clearTimeout(timeout);
    }, [nextCompactionExpiry, nowMs]);
    if (visibleMessages.length === 0 && initialLoading) {
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center">
                <LoadingState label="Loading chat history…" />
            </div>
        );
    }

    if (visibleMessages.length === 0 && !hasOlder) {
        return (
            <EmptyState
                className="m-3 flex min-h-0 flex-1 flex-col justify-center border-0 bg-transparent"
                description="Send a message to start this chat. OpenClaw history will appear here when it is ready."
                icon={MessagesSquare}
                title="No messages yet"
            />
        );
    }

    const newMessageLabel =
        currentNotice.newMessageCount === 0
            ? currentNotice.announcement
            : `${currentNotice.newMessageCount} new ${currentNotice.newMessageCount === 1 ? "message" : "messages"}`;
    return (
        <section
            aria-label="Chat transcript"
            className="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden"
        >
            <output aria-atomic="true" aria-live="polite" className="sr-only">
                {newMessageLabel}
            </output>
            <Virtualizer<HTMLDivElement>
                count={visibleMessages.length}
                estimateSize={() => estimatedMessageHeightPx}
                followToEnd={{
                    layoutRevision,
                    onFollowingChange: handleFollowingChange,
                    onItemsAppended: handleItemsAppended,
                    scopeKey: sessionKey,
                }}
                getItemKey={(index) => visibleMessages[index]?.id ?? `message:${index}`}
                initialRect={{ height: 560, width: 880 }}
                overscan={50}
            >
                {(virtualization) => (
                    <div className="relative flex h-full min-h-0 flex-col">
                        {virtualization.followToEnd?.awayFromEnd === true && (
                            <Button
                                className="border-primary-600 absolute top-2 right-4 z-20 rounded-full border px-3 py-1 text-xs shadow-lg sm:right-5"
                                onClick={() => {
                                    setNotice(emptyTranscriptNotice(sessionKey));
                                    virtualization.followToEnd?.follow();
                                }}
                                size="sm"
                                variant="secondary"
                            >
                                <Icon icon={ArrowDown} size="sm" tone="inherit" />
                                {currentNotice.newMessageCount === 0
                                    ? "Back to latest"
                                    : `${currentNotice.newMessageCount} new ${currentNotice.newMessageCount === 1 ? "message" : "messages"}`}
                            </Button>
                        )}
                        {olderHistoryCycleLoading && (
                            <output
                                aria-label="Loading older messages"
                                className="text-primary-200 flex h-8 shrink-0 items-center justify-center gap-2 text-sm"
                            >
                                <Icon
                                    className="motion-safe:animate-spin"
                                    icon={LoaderCircle}
                                    size="sm"
                                    tone="inherit"
                                />
                                Loading older messages…
                            </output>
                        )}
                        <div
                            aria-busy={olderHistoryCycleLoading}
                            aria-label="Messages"
                            aria-live="off"
                            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 py-3 sm:px-3"
                            ref={(node) => {
                                virtualization.scrollContainerRef.current = node;
                                historyViewport.current = node;
                                preserveHistoryAnchor.current =
                                    virtualization.preserveVisibleAnchor;
                                if (
                                    node === null ||
                                    !olderHistoryCycleActive.current ||
                                    olderHistoryRequestPending.current
                                ) {
                                    return;
                                }
                                if (
                                    !hasOlder ||
                                    node.scrollTop > olderHistoryLoadThresholdPx
                                ) {
                                    olderHistoryCycleActive.current = false;
                                    setOlderHistoryCycleLoading(false);
                                    return;
                                }
                                void requestOlderAtTop();
                            }}
                            role="log"
                            onScroll={handleHistoryScroll}
                            onWheel={(event) => handleHistoryWheel(event.deltaY)}
                            style={{ overflowAnchor: "none" }}
                            tabIndex={0}
                        >
                            <div
                                className="relative w-full"
                                style={{ height: `${virtualization.totalSize}px` }}
                            >
                                {virtualization.virtualItems.map((virtualItem) => {
                                    const message = visibleMessages[virtualItem.index];
                                    if (message === undefined) return null;
                                    return (
                                        <div
                                            className={`absolute top-0 left-0 w-full ${
                                                virtualItem.index ===
                                                    visibleMessages.length - 1 &&
                                                isActivityOnlyMessage(message)
                                                    ? "pb-1"
                                                    : "pb-3"
                                            }`}
                                            data-index={virtualItem.index}
                                            key={virtualItem.key}
                                            ref={virtualization.measureElement}
                                            style={{
                                                transform: `translateY(${virtualItem.start}px)`,
                                            }}
                                        >
                                            <ChatMessageBubble
                                                activeRunIds={
                                                    streamingTextMessageIds.has(
                                                        message.id
                                                    )
                                                        ? activeRunIds
                                                        : []
                                                }
                                                display={display}
                                                message={message}
                                                onDismissReadAloudError={
                                                    onDismissReadAloudError
                                                }
                                                onDynamicContentLoad={
                                                    virtualization.followToEnd
                                                        ?.notifyDynamicContentChange
                                                }
                                                onHydrate={onHydrateMessage}
                                                onOpenLocalFile={onOpenLocalFile}
                                                onReadAloud={onReadAloud}
                                                onStopReadAloud={onStopReadAloud}
                                                onToolExpand={
                                                    virtualization.followToEnd
                                                        ?.stopFollowing
                                                }
                                                readAloud={readAloud}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </Virtualizer>
        </section>
    );
}
