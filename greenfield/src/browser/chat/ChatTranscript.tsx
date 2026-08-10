import { ArrowDown, MessagesSquare } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable transcript log must be keyboard-focusable. */

import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Virtualizer, type VirtualizerItemsAppendedEvent } from "../ui/Virtualizer.tsx";
import { ChatMessageBubble } from "./ChatMessageBubble.tsx";
import { visibleChatTranscriptMessages } from "./chatMessageVisibility.ts";
import type {
    ChatDisplayMessage,
    ChatDisplaySettings,
    ChatReadAloudView,
} from "./chatTypes.ts";

const estimatedMessageHeightPx = 148;

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
            hash = hashRevisionPart(hash, `${part.kind}|${part.tone}|${part.text}`);
        } else {
            hash = hashRevisionPart(
                hash,
                `${part.kind}|${part.callId}|${part.callIdSource ?? ""}|${part.name}|${part.status}|${revisionDetail(part.input)}|${part.error ?? ""}|${revisionDetail(part.output)}`
            );
        }
    }
    return hash;
}

function transcriptLayoutRevision(
    messages: readonly ChatDisplayMessage[],
    display: ChatDisplaySettings,
    activeRunIds: readonly string[],
    readAloud: ChatReadAloudView | undefined,
    windowLimited: boolean
): number {
    let hash = hashRevisionPart(
        2_166_136_261,
        `${display.keepThinkingAfterFinal}|${display.showThinking}|${display.showTools}|${display.toolsExpanded}|${windowLimited}`
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
    readonly historyLoading: boolean;
    readonly initialLoading: boolean;
    readonly messages: readonly ChatDisplayMessage[];
    readonly onDismissReadAloudError?: () => void;
    readonly onHideMessage: (messageId: string) => void;
    readonly onHydrateMessage: (messageId: string) => void;
    readonly onLoadOlder: () => void;
    readonly onReadAloud?: (messageId: string, text: string) => void;
    readonly onReturnToLatest?: () => void;
    readonly onStopReadAloud?: () => void;
    readonly readAloud?: ChatReadAloudView;
    readonly sessionKey: string;
    readonly windowLimited?: boolean;
}

interface ChatTranscriptNotice {
    readonly announcement: string;
    readonly newMessageCount: number;
    readonly sessionKey: string;
}

function emptyTranscriptNotice(sessionKey: string): ChatTranscriptNotice {
    return { announcement: "", newMessageCount: 0, sessionKey };
}

/**
 * Virtualizes hydrated chat history while preserving prepend and follow anchors.
 * @returns One accessible virtual transcript.
 */
export function ChatTranscript({
    activeRunIds = [],
    display,
    hasOlder,
    historyLoading,
    initialLoading,
    messages,
    onDismissReadAloudError,
    onHideMessage,
    onHydrateMessage,
    onLoadOlder,
    onReadAloud,
    onReturnToLatest,
    onStopReadAloud,
    readAloud,
    sessionKey,
    windowLimited = false,
}: ChatTranscriptProps) {
    const [notice, setNotice] = useState<ChatTranscriptNotice>(() =>
        emptyTranscriptNotice(sessionKey)
    );
    const currentNotice =
        notice.sessionKey === sessionKey ? notice : emptyTranscriptNotice(sessionKey);
    const visibleMessages = visibleChatTranscriptMessages(messages, display, readAloud);
    const stopReadAloud = useEffectEvent(() => onStopReadAloud?.());
    const stopActiveReadAloud = useEffectEvent(() => {
        if (readAloud?.phase !== "idle") stopReadAloud();
    });
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

    if (visibleMessages.length === 0 && initialLoading) {
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center">
                <LoadingState label="Loading chat history…" />
            </div>
        );
    }

    if (visibleMessages.length === 0) {
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
    const layoutRevision = transcriptLayoutRevision(
        visibleMessages,
        display,
        activeRunIds,
        readAloud,
        windowLimited
    );
    return (
        <section
            aria-label="Chat transcript"
            className="relative isolate min-h-0 flex-1 overflow-hidden"
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
                overscan={8}
            >
                {(virtualization) => (
                    <>
                        <div
                            aria-busy={historyLoading}
                            aria-label="Messages"
                            aria-live="off"
                            className="h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain px-2 py-3 sm:px-3"
                            ref={virtualization.scrollContainerRef}
                            role="log"
                            style={{ overflowAnchor: "none" }}
                            tabIndex={0}
                        >
                            {virtualization.followToEnd?.awayFromEnd === true && (
                                <Button
                                    className="border-primary-600 sticky top-0 z-10 float-right mb-2 rounded-full border px-3 py-1 text-xs shadow-lg sm:mr-2"
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
                            <div className="mb-3 flex min-h-8 justify-center">
                                {hasOlder && (
                                    <Button
                                        busy={historyLoading}
                                        busyLabel="Loading older messages…"
                                        onClick={onLoadOlder}
                                        size="sm"
                                        variant="secondary"
                                    >
                                        Load older messages
                                    </Button>
                                )}
                                {windowLimited && (
                                    <div className="text-primary-300 text-center text-xs">
                                        <p>
                                            Older history is capped to this browser
                                            window.
                                        </p>
                                        {onReturnToLatest !== undefined && (
                                            <Button
                                                className="mt-2"
                                                onClick={onReturnToLatest}
                                                size="sm"
                                                variant="secondary"
                                            >
                                                Return to latest history
                                            </Button>
                                        )}
                                    </div>
                                )}
                            </div>
                            <div
                                className="relative w-full"
                                style={{ height: `${virtualization.totalSize}px` }}
                            >
                                {virtualization.virtualItems.map((virtualItem) => {
                                    const message = visibleMessages[virtualItem.index];
                                    if (message === undefined) return null;
                                    return (
                                        <div
                                            className="absolute top-0 left-0 w-full pb-3"
                                            data-index={virtualItem.index}
                                            key={virtualItem.key}
                                            ref={virtualization.measureElement}
                                            style={{
                                                transform: `translateY(${virtualItem.start}px)`,
                                            }}
                                        >
                                            <ChatMessageBubble
                                                activeRunIds={activeRunIds}
                                                display={display}
                                                message={message}
                                                onDismissReadAloudError={
                                                    onDismissReadAloudError
                                                }
                                                onDynamicContentLoad={
                                                    virtualization.followToEnd
                                                        ?.notifyDynamicContentChange
                                                }
                                                onHide={onHideMessage}
                                                onHydrate={onHydrateMessage}
                                                onReadAloud={onReadAloud}
                                                onStopReadAloud={onStopReadAloud}
                                                readAloud={readAloud}
                                            />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </>
                )}
            </Virtualizer>
        </section>
    );
}
