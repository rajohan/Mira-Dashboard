import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import {
    ArrowUp,
    Brain,
    Mic,
    MicOff,
    Minimize2,
    Paperclip,
    Pin,
    Settings,
    Settings2,
    SlidersHorizontal,
    Smile,
    Square,
    Wrench,
    X,
} from "lucide-react";
import type { ReactNode } from "react";

import type { Session } from "../../../../../contracts/sessions";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import {
    chatSpeedOptions,
    chatThinkingOptions,
    selectedChatSpeed,
} from "./chatUtilities";

const CHAT_EMOJIS = [
    "😀",
    "😄",
    "😂",
    "😊",
    "😍",
    "🥳",
    "😎",
    "🤔",
    "😅",
    "😭",
    "👍",
    "👎",
    "🙏",
    "🙌",
    "👏",
    "💪",
    "🔥",
    "✨",
    "💡",
    "✅",
    "❌",
    "⚠️",
    "❤️",
    "🚀",
];

/** Provides props for a composer overlay header. */
interface PanelHeaderProperties {
    title: string;
    closeLabel: string;
    className?: string;
    onClose: () => void;
}

/**
 * Renders a consistent title and close action for composer panels.
 * @returns Rendered a consistent title and close action for composer panels.
 */
export function PanelHeader({
    title,
    closeLabel,
    className = "",
    onClose,
}: PanelHeaderProperties) {
    return (
        <div className={`flex items-center justify-between ${className}`}>
            <span className="text-xs font-medium tracking-wide text-primary-400 uppercase">
                {title}
            </span>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="p-1 text-primary-400 hover:text-primary-100"
                aria-label={closeLabel}
            >
                <X className="size-4" />
            </Button>
        </div>
    );
}

/**
 * Renders one accessible toggle inside the chat display drawer.
 * @returns Rendered one accessible toggle inside the chat display drawer.
 */
function DisplayToggle({
    label,
    description,
    isPressed,
    isDisabled = false,
    icon,
    onToggle,
}: {
    label: string;
    description: string;
    isPressed: boolean;
    isDisabled?: boolean;
    icon: ReactNode;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            aria-pressed={isPressed}
            disabled={isDisabled}
            onClick={onToggle}
            className="flex w-full items-center gap-2 rounded-md border border-primary-700 bg-primary-900/50 px-2.5 py-2 text-left transition hover:border-primary-600 hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
            <span className={isPressed ? "text-accent-300" : "text-primary-500"}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-primary-100">
                    {label}
                </span>
                <span className="block text-[11px] text-primary-400">{description}</span>
            </span>
            <span className="shrink-0 text-[10px] tracking-wide text-primary-400 uppercase">
                {isPressed ? "On" : "Off"}
            </span>
        </button>
    );
}

/** Props for the chat composer response and action toolbar. */
interface ChatComposerToolbarProperties {
    canAttachFiles: boolean;
    canSend: boolean;
    canStop: boolean;
    compactDisabled?: boolean;
    insertEmoji: (emoji: string) => void;
    isCompacting?: boolean;
    isConnected: boolean;
    isRecording: boolean;
    isSending: boolean;
    isStopping: boolean;
    isTranscribing: boolean;
    modelSelectOptions: Array<{ label: string; value: string }>;
    onCompact?: () => void;
    onOpenAttachmentPicker: () => void;
    onSelectModel?: (value: string) => void;
    onSelectSpeed?: (value: string) => void;
    onSelectThinkingLevel?: (value: string) => void;
    onSend: () => void;
    onStop?: () => void;
    onToggleKeepThinkingAfterFinal?: () => void;
    onToggleRecording: () => void;
    onToggleThinking?: () => void;
    onToggleToolDetailsExpansion?: () => void;
    onToggleTools?: () => void;
    preferenceControlsDisabled?: boolean;
    selectedSession?: Session;
    selectedSessionKey: string;
    shouldExpandToolDetails: boolean;
    shouldKeepThinkingAfterFinal: boolean;
    shouldShowThinking?: boolean;
    shouldShowTools?: boolean;
}

/**
 * Renders response, display, emoji, recording, attachment, and send controls.
 * @returns Chat composer toolbar.
 */
export function ChatComposerToolbar({
    canAttachFiles,
    canSend,
    canStop,
    compactDisabled,
    insertEmoji,
    isCompacting,
    isConnected,
    isRecording,
    isSending,
    isStopping,
    isTranscribing,
    modelSelectOptions,
    onCompact,
    onOpenAttachmentPicker,
    onSelectModel,
    onSelectSpeed,
    onSelectThinkingLevel,
    onSend,
    onStop,
    onToggleKeepThinkingAfterFinal,
    onToggleRecording,
    onToggleThinking,
    onToggleToolDetailsExpansion,
    onToggleTools,
    preferenceControlsDisabled,
    selectedSession,
    selectedSessionKey,
    shouldExpandToolDetails,
    shouldKeepThinkingAfterFinal,
    shouldShowThinking,
    shouldShowTools,
}: ChatComposerToolbarProperties) {
    return (
        <div className="flex min-h-10 items-center justify-between rounded-b-lg border-t border-primary-600 bg-primary-700 px-2 py-1">
            <div className="flex items-center gap-1">
                <Popover className="relative">
                    {({ close }) => (
                        <>
                            <PopoverButton
                                aria-label="Model and response settings"
                                title="Response settings"
                                className="flex items-center rounded p-1.5 text-primary-400 outline-none hover:bg-primary-700 hover:text-primary-100 data-focus:bg-primary-700 data-focus:text-primary-100"
                            >
                                <Settings2 className="size-4" />
                            </PopoverButton>
                            <PopoverPanel
                                anchor={{ to: "top start", gap: 11 }}
                                className="z-50 w-72 space-y-3 rounded-lg border border-primary-600 bg-primary-800 p-3 text-sm shadow-xl outline-none"
                            >
                                <PanelHeader
                                    title="Response settings"
                                    closeLabel="Close response settings"
                                    onClose={() => close()}
                                />
                                <div className="space-y-1">
                                    <div className="text-xs font-medium text-primary-400">
                                        Model
                                    </div>
                                    <Select
                                        ariaLabel="Model"
                                        width="w-full"
                                        value={selectedSession?.model || ""}
                                        disabled={
                                            !selectedSessionKey ||
                                            preferenceControlsDisabled
                                        }
                                        onChange={(value) => onSelectModel?.(value)}
                                        options={modelSelectOptions}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <div className="text-xs font-medium text-primary-400">
                                        Thinking
                                    </div>
                                    <Select
                                        ariaLabel="Thinking"
                                        width="w-full"
                                        value={selectedSession?.thinkingLevel || ""}
                                        disabled={
                                            !selectedSessionKey ||
                                            preferenceControlsDisabled
                                        }
                                        onChange={(value) =>
                                            onSelectThinkingLevel?.(value)
                                        }
                                        options={chatThinkingOptions(selectedSession)}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <div className="text-xs font-medium text-primary-400">
                                        Speed
                                    </div>
                                    <Select
                                        ariaLabel="Speed"
                                        width="w-full"
                                        value={selectedChatSpeed(selectedSession)}
                                        disabled={
                                            !selectedSessionKey ||
                                            preferenceControlsDisabled
                                        }
                                        onChange={(value) => onSelectSpeed?.(value)}
                                        options={chatSpeedOptions(selectedSession)}
                                    />
                                </div>
                                <Button
                                    variant="primary"
                                    size="sm"
                                    className="w-full justify-center"
                                    disabled={
                                        !selectedSessionKey ||
                                        compactDisabled ||
                                        isCompacting
                                    }
                                    onClick={() => onCompact?.()}
                                >
                                    <Minimize2 className="size-4" />
                                    {isCompacting ? "Compacting…" : "Compact context"}
                                </Button>
                            </PopoverPanel>
                        </>
                    )}
                </Popover>
                <Popover className="relative">
                    {({ close }) => (
                        <>
                            <PopoverButton
                                aria-label="Chat display settings"
                                title="Chat display settings"
                                disabled={!selectedSessionKey}
                                className="flex items-center rounded p-1.5 text-primary-400 outline-none hover:bg-primary-700 hover:text-primary-100 disabled:cursor-not-allowed disabled:opacity-40 data-focus:bg-primary-700 data-focus:text-primary-100"
                            >
                                <Settings className="size-4" />
                            </PopoverButton>
                            <PopoverPanel
                                anchor={{ to: "top start", gap: 11 }}
                                className="z-50 w-80 space-y-2 rounded-lg border border-primary-600 bg-primary-800 p-3 text-sm shadow-xl outline-none"
                            >
                                <PanelHeader
                                    title="Chat display"
                                    closeLabel="Close chat display settings"
                                    onClose={() => close()}
                                />
                                <DisplayToggle
                                    label="Show thinking"
                                    description="Show thinking and working updates"
                                    isPressed={Boolean(shouldShowThinking)}
                                    icon={<Brain className="size-4" />}
                                    onToggle={() => onToggleThinking?.()}
                                />
                                <DisplayToggle
                                    label="Show tools"
                                    description="Show tool calls and results"
                                    isPressed={Boolean(shouldShowTools)}
                                    icon={<Wrench className="size-4" />}
                                    onToggle={() => onToggleTools?.()}
                                />
                                <DisplayToggle
                                    label="Keep thinking after final answer"
                                    description="Retain thinking after a run completes"
                                    isPressed={shouldKeepThinkingAfterFinal}
                                    isDisabled={!shouldShowThinking}
                                    icon={<Pin className="size-4" />}
                                    onToggle={() => onToggleKeepThinkingAfterFinal?.()}
                                />
                                <DisplayToggle
                                    label="Expand tool call details"
                                    description="Apply to current and future tool bubbles"
                                    isPressed={shouldExpandToolDetails}
                                    icon={<SlidersHorizontal className="size-4" />}
                                    onToggle={() => onToggleToolDetailsExpansion?.()}
                                />
                            </PopoverPanel>
                        </>
                    )}
                </Popover>
            </div>
            <div className="flex items-center gap-1">
                <Popover className="relative">
                    {({ close }) => (
                        <>
                            <PopoverButton
                                as={Button}
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={
                                    !isConnected || !selectedSessionKey || isSending
                                }
                                className="rounded-full p-2 text-primary-400 hover:bg-primary-600 hover:text-primary-100 focus:bg-primary-600 focus:text-primary-100 disabled:opacity-40"
                                title="Insert emoji"
                                aria-label="Insert emoji"
                            >
                                <Smile className="size-5" />
                            </PopoverButton>
                            <PopoverPanel
                                anchor={{ to: "top end", gap: 8 }}
                                className="z-50 w-80 rounded-xl border border-primary-700 bg-primary-900 p-2 shadow-2xl outline-none"
                            >
                                <PanelHeader
                                    title="Emoji"
                                    closeLabel="Close emoji picker"
                                    onClose={() => close()}
                                    className="mb-2 px-1"
                                />
                                <div className="grid max-h-64 grid-cols-6 gap-1 overflow-y-auto">
                                    {CHAT_EMOJIS.map((emoji) => (
                                        <Button
                                            key={emoji}
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                                insertEmoji(emoji);
                                                close();
                                            }}
                                            className="p-2.5 text-xl hover:bg-primary-800 focus:bg-primary-800"
                                            aria-label={`Insert ${emoji}`}
                                        >
                                            {emoji}
                                        </Button>
                                    ))}
                                </div>
                            </PopoverPanel>
                        </>
                    )}
                </Popover>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onToggleRecording}
                    disabled={
                        !isConnected || !selectedSessionKey || isSending || isTranscribing
                    }
                    title={isRecording ? "Stop recording" : "Record voice input"}
                    aria-label={isRecording ? "Stop recording" : "Record voice input"}
                    className={[
                        "h-8 rounded-full border",
                        isRecording
                            ? "gap-1.5 border-red-500 bg-red-500 px-2.5 text-white shadow-sm shadow-red-950/40 hover:border-red-400 hover:bg-red-600 hover:text-white"
                            : "border-transparent px-2 text-primary-400 hover:bg-primary-600 hover:text-primary-100",
                    ].join(" ")}
                >
                    {isRecording ? (
                        <>
                            <span className="size-2 animate-pulse rounded-full bg-white" />
                            <MicOff className="size-4" />
                            <span className="hidden text-xs font-medium sm:inline">
                                Recording
                            </span>
                        </>
                    ) : (
                        <Mic className="size-4" />
                    )}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onOpenAttachmentPicker}
                    disabled={!canAttachFiles}
                    title="Attach files"
                    aria-label="Attach files"
                    className="rounded-full p-2 text-primary-400 hover:bg-primary-600 hover:text-primary-100"
                >
                    <Paperclip className="size-4" />
                </Button>
                {(canStop || isStopping) && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onStop}
                        disabled={!canStop}
                        title="Stop"
                        aria-label="Stop"
                        className="size-8 shrink-0 rounded-full border border-red-500/60 bg-transparent p-0 text-red-500/80 hover:border-red-500/90 hover:text-red-500"
                    >
                        <Square className="size-3.5 fill-current" />
                    </Button>
                )}
                <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={onSend}
                    disabled={!canSend || isRecording || isTranscribing || isStopping}
                    title="Send"
                    aria-label="Send"
                    className="size-8 shrink-0 rounded-full p-0"
                >
                    <ArrowUp className="size-4" />
                </Button>
            </div>
        </div>
    );
}
