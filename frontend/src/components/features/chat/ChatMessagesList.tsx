import type { Virtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";

import { EmptyState } from "../../ui/EmptyState";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { ActivityIndicator } from "./ChatMessageControls";
import type { ChatPreviewItem, ChatRow, ChatVisibilitySettings } from "./chatTypes";
import { useChatTextToSpeech } from "./useChatTextToSpeech";

const SCROLL_KEYS = new Set([
    " ",
    "ArrowDown",
    "ArrowUp",
    "End",
    "Home",
    "PageDown",
    "PageUp",
]);

function isScrollbarPointer(event: PointerEvent<HTMLDivElement>): boolean {
    const container = event.currentTarget;
    const scrollbarWidth = container.offsetWidth - container.clientWidth;
    return (
        scrollbarWidth > 0 &&
        event.target === container &&
        event.clientX >= container.getBoundingClientRect().right - scrollbarWidth
    );
}

function isKeyboardScroll(event: KeyboardEvent<HTMLDivElement>): boolean {
    return (
        SCROLL_KEYS.has(event.key) &&
        (event.target === event.currentTarget || event.key !== " ")
    );
}

interface ChatMessagesListProperties {
    chatRows: ChatRow[];
    isAtBottom: boolean;
    isLoadingHistory: boolean;
    messagesContainerRef: RefObject<HTMLDivElement | undefined>;
    messagesVirtualizer: Virtualizer<HTMLDivElement, Element>;
    onDeleteMessage: (messageKey: string, deleteKeys?: readonly string[]) => void;
    onDynamicContentLoad: () => void;
    onFollow: () => void;
    onPreview: (preview: ChatPreviewItem) => void;
    onScroll: () => void;
    onToggleToolDetails?: (toolKey: string) => void;
    onTtsError: (error: string) => void;
    onUserScrollIntent: () => void;
    shouldExpandToolDetails?: boolean;
    toolDetailExpansionOverrides?: ReadonlyMap<string, boolean>;
    visibility: ChatVisibilitySettings;
}

export function ChatMessagesList({
    chatRows,
    isAtBottom,
    isLoadingHistory,
    messagesContainerRef,
    messagesVirtualizer,
    onDeleteMessage,
    onDynamicContentLoad,
    onFollow,
    onPreview,
    onScroll,
    onToggleToolDetails,
    onTtsError,
    onUserScrollIntent,
    shouldExpandToolDetails = false,
    toolDetailExpansionOverrides = new Map(),
    visibility,
}: ChatMessagesListProperties) {
    const tts = useChatTextToSpeech(onTtsError);
    const virtualItems = messagesVirtualizer.getVirtualItems();
    const firstVirtualItem = virtualItems[0];
    const lastVirtualItem = virtualItems.at(-1);
    const paddingTop = firstVirtualItem?.start ?? 0;
    const paddingBottom = lastVirtualItem
        ? Math.max(messagesVirtualizer.getTotalSize() - lastVirtualItem.end, 0)
        : 0;

    return (
        <div
            ref={(element) => {
                messagesContainerRef.current = element ?? undefined;
            }}
            className="mt-3 min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-0 sm:mt-4 sm:pr-1"
            onKeyDownCapture={(event) => {
                if (isKeyboardScroll(event)) onUserScrollIntent();
            }}
            onPointerDownCapture={(event) => {
                if (isScrollbarPointer(event)) onUserScrollIntent();
            }}
            onScroll={onScroll}
            onTouchMoveCapture={onUserScrollIntent}
            onWheelCapture={onUserScrollIntent}
            style={{ overflowAnchor: "none" }}
        >
            {!isAtBottom && chatRows.length > 0 ? (
                <button
                    className="sticky top-2 z-10 float-right mb-2 rounded-full bg-accent-500 px-3 py-1 text-xs text-white shadow-lg hover:bg-accent-600 sm:mr-2"
                    onClick={onFollow}
                    type="button"
                >
                    ↓ Follow
                </button>
            ) : undefined}

            {isLoadingHistory && chatRows.length === 0 ? (
                <div className="flex items-center justify-center gap-1.5 py-10 text-primary-400">
                    <Loader2 className="size-4 animate-spin" />
                    Loading chat…
                </div>
            ) : undefined}
            {!isLoadingHistory && chatRows.length === 0 ? (
                <EmptyState message="No chat history yet. Send the first message to this session." />
            ) : undefined}
            {chatRows.length > 0 ? (
                <div className="w-full">
                    {paddingTop > 0 ? <div style={{ height: paddingTop }} /> : undefined}
                    {virtualItems.map((virtualItem) => {
                        const row = chatRows[virtualItem.index];
                        if (!row) {
                            return (
                                <div
                                    key={virtualItem.key}
                                    aria-hidden="true"
                                    className="h-0 overflow-hidden"
                                    data-index={virtualItem.index}
                                    ref={messagesVirtualizer.measureElement}
                                />
                            );
                        }
                        if (row.kind === "typing" || row.kind === "status") {
                            return (
                                <div
                                    key={virtualItem.key}
                                    className="w-full pb-3"
                                    data-chat-row-key={row.key}
                                    data-index={virtualItem.index}
                                    ref={messagesVirtualizer.measureElement}
                                >
                                    <ActivityIndicator
                                        active={row.kind === "typing"}
                                        text={row.message.text}
                                    />
                                </div>
                            );
                        }
                        return (
                            <div
                                key={virtualItem.key}
                                className="w-full pb-3"
                                data-chat-intent={row.message.intent}
                                data-chat-row-key={row.key}
                                data-index={virtualItem.index}
                                ref={messagesVirtualizer.measureElement}
                            >
                                <ChatMessageBubble
                                    onDeleteMessage={onDeleteMessage}
                                    onDynamicContentLoad={onDynamicContentLoad}
                                    onPreview={onPreview}
                                    onToggleToolDetails={onToggleToolDetails}
                                    row={row}
                                    shouldExpandToolDetails={shouldExpandToolDetails}
                                    toolDetailExpansionOverrides={
                                        toolDetailExpansionOverrides
                                    }
                                    tts={tts}
                                    visibility={visibility}
                                />
                            </div>
                        );
                    })}
                    {paddingBottom > 0 ? (
                        <div style={{ height: paddingBottom }} />
                    ) : undefined}
                </div>
            ) : undefined}
        </div>
    );
}
