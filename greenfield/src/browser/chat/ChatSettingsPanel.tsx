import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import {
    Brain,
    Pin,
    RotateCcw,
    Settings2,
    SlidersHorizontal,
    Sparkles,
    Wrench,
    X,
    type LucideIcon,
} from "lucide-react";

import { cn } from "../lib/classNames.ts";
import { Button } from "../ui/Button.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Select } from "../ui/Select.tsx";
import { chatModelDisplayName } from "./chatModelPresentation.ts";
import type {
    ChatDisplaySettings,
    ChatSendSettings,
    ChatSessionOption,
} from "./chatTypes.ts";
/* eslint-disable jsx-a11y/prefer-tag-over-role -- Headless UI PopoverPanel owns dialog visibility and focus without native dialog top-layer behavior. */

interface ChatSettingsPanelProps {
    readonly busy?: boolean;
    readonly display: ChatDisplaySettings;
    readonly modelInventoryError?: string;
    readonly onCompact: () => void;
    readonly onDisplayChange: (settings: ChatDisplaySettings) => void;
    readonly onRetryModels?: () => void;
    readonly onReset: () => void;
    readonly onSendSettingsChange: (settings: ChatSendSettings) => void;
    readonly send: ChatSendSettings;
    readonly session: ChatSessionOption;
}

function DisplayToggle({
    description,
    disabled = false,
    icon,
    label,
    onToggle,
    pressed,
}: Readonly<{
    description: string;
    disabled?: boolean;
    icon: LucideIcon;
    label: string;
    onToggle: () => void;
    pressed: boolean;
}>) {
    return (
        <button
            aria-pressed={pressed}
            className={cn(
                "focus-visible:ring-accent-300 flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45",
                pressed
                    ? "border-accent-400 bg-primary-900"
                    : "border-primary-500 bg-primary-800 hover:border-primary-400 hover:bg-primary-900"
            )}
            disabled={disabled}
            onClick={onToggle}
            type="button"
        >
            <span
                className={cn(
                    "shrink-0",
                    pressed ? "text-accent-300" : "text-primary-400"
                )}
            >
                <Icon icon={icon} size="sm" tone="inherit" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="text-primary-50 block text-xs font-medium">{label}</span>
                <span className="text-primary-300 mt-0.5 block text-[11px] leading-4">
                    {description}
                </span>
            </span>
            <span className="text-primary-300 shrink-0 text-[10px] font-medium tracking-wide uppercase">
                {pressed ? "On" : "Off"}
            </span>
        </button>
    );
}

/**
 * Renders provider and display controls in a composer-anchored popover.
 * @returns Compact settings trigger and responsive popover.
 */
export function ChatSettingsPanel({
    busy = false,
    display,
    modelInventoryError,
    onCompact,
    onDisplayChange,
    onRetryModels,
    onReset,
    onSendSettingsChange,
    send,
    session,
}: ChatSettingsPanelProps) {
    const modelOptions = [
        ...new Set([send.model, session.model, ...session.modelOptions].filter(Boolean)),
    ] as string[];
    const thinkingOptions = [
        ...new Set(
            [send.thinking, session.thinking, ...session.thinkingOptions].filter(Boolean)
        ),
    ] as string[];
    return (
        <Popover className="relative shrink-0">
            {({ close }) => (
                <>
                    <PopoverButton
                        aria-label="Chat settings"
                        className="text-primary-300 hover:bg-primary-700 hover:text-primary-50 focus-visible:ring-accent-400 inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-lg bg-transparent px-0 text-sm font-medium outline-none focus-visible:ring-2 sm:min-h-9 sm:min-w-9"
                        title="Chat settings"
                    >
                        <Icon icon={Settings2} size="sm" tone="inherit" />
                    </PopoverButton>
                    <PopoverPanel
                        anchor={{ gap: 10, padding: 12, to: "top start" }}
                        aria-label="Chat settings"
                        className="border-primary-400 bg-primary-700 z-50 max-h-[calc(100dvh-1.5rem)] w-[min(23rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-xl border p-3 text-sm outline-none"
                        data-testid="chat-settings-surface"
                        role="dialog"
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-primary-50 font-semibold">
                                    Chat settings
                                </p>
                                <p className="text-primary-300 mt-0.5 text-xs">
                                    Response preferences and local display controls
                                </p>
                            </div>
                            <Button
                                aria-label="Close chat settings"
                                className="shrink-0 p-1.5"
                                onClick={() => close()}
                                size="sm"
                                variant="ghost"
                            >
                                <Icon icon={X} size="sm" tone="inherit" />
                            </Button>
                        </div>

                        <section
                            aria-labelledby="chat-response-settings-heading"
                            className="border-primary-700 mt-3 space-y-3 border-t pt-3"
                        >
                            <p
                                className="text-primary-300 text-xs font-medium tracking-wide uppercase"
                                id="chat-response-settings-heading"
                            >
                                Response
                            </p>
                            <FormField label="Model">
                                <Select
                                    ariaLabel="Chat model"
                                    disabled={busy || modelOptions.length === 0}
                                    onChange={(model) =>
                                        onSendSettingsChange({ ...send, model })
                                    }
                                    options={modelOptions.map((model) => ({
                                        label: chatModelDisplayName(model),
                                        value: model,
                                    }))}
                                    value={send.model ?? modelOptions[0] ?? ""}
                                />
                            </FormField>
                            {modelInventoryError !== undefined && (
                                <div
                                    aria-label="Chat model inventory warning"
                                    className="border-primary-500 bg-primary-800 rounded-lg border p-2"
                                    role="alert"
                                >
                                    <p className="text-primary-200 text-xs wrap-break-word">
                                        {modelInventoryError}
                                    </p>
                                    {onRetryModels !== undefined && (
                                        <Button
                                            className="mt-2 w-full justify-center"
                                            onClick={onRetryModels}
                                            size="sm"
                                            variant="secondary"
                                        >
                                            Retry model inventory
                                        </Button>
                                    )}
                                </div>
                            )}
                            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                                <FormField label="Thinking">
                                    <Select
                                        ariaLabel="Thinking level"
                                        disabled={busy || thinkingOptions.length === 0}
                                        onChange={(thinking) =>
                                            onSendSettingsChange({ ...send, thinking })
                                        }
                                        options={thinkingOptions.map((thinking) => ({
                                            label: thinking,
                                            value: thinking,
                                        }))}
                                        value={send.thinking ?? thinkingOptions[0] ?? ""}
                                    />
                                </FormField>
                                <FormField label="Speed">
                                    <Select
                                        ariaLabel="Response speed"
                                        disabled={busy}
                                        onChange={(speed) =>
                                            onSendSettingsChange({
                                                ...send,
                                                fastMode: speed === "fast",
                                                speed,
                                            })
                                        }
                                        options={[
                                            { label: "Standard", value: "standard" },
                                            { label: "Fast", value: "fast" },
                                        ]}
                                        value={send.speed}
                                    />
                                </FormField>
                            </div>
                        </section>

                        <section
                            aria-labelledby="chat-display-settings-heading"
                            className="border-primary-700 mt-3 space-y-2 border-t pt-3"
                        >
                            <p
                                className="text-primary-300 text-xs font-medium tracking-wide uppercase"
                                id="chat-display-settings-heading"
                            >
                                Display in this browser
                            </p>
                            <DisplayToggle
                                description="Show thinking and working updates"
                                icon={Brain}
                                label="Show thinking"
                                onToggle={() =>
                                    onDisplayChange({
                                        ...display,
                                        showThinking: !display.showThinking,
                                    })
                                }
                                pressed={display.showThinking}
                            />
                            <DisplayToggle
                                description="Retain thinking after a run completes"
                                disabled={!display.showThinking}
                                icon={Pin}
                                label="Keep thinking after final answer"
                                onToggle={() =>
                                    onDisplayChange({
                                        ...display,
                                        keepThinkingAfterFinal:
                                            !display.keepThinkingAfterFinal,
                                    })
                                }
                                pressed={display.keepThinkingAfterFinal}
                            />
                            <DisplayToggle
                                description="Show tool calls and results"
                                icon={Wrench}
                                label="Show tools"
                                onToggle={() =>
                                    onDisplayChange({
                                        ...display,
                                        showTools: !display.showTools,
                                    })
                                }
                                pressed={display.showTools}
                            />
                            <DisplayToggle
                                description="Expand current and future tool bubbles"
                                disabled={!display.showTools}
                                icon={SlidersHorizontal}
                                label="Expand tool details"
                                onToggle={() =>
                                    onDisplayChange({
                                        ...display,
                                        toolsExpanded: !display.toolsExpanded,
                                    })
                                }
                                pressed={display.toolsExpanded}
                            />
                        </section>

                        <div className="border-primary-700 mt-3 grid grid-cols-1 gap-2 border-t pt-3 sm:grid-cols-2">
                            <Button
                                className="w-full min-w-0 justify-center"
                                disabled={busy}
                                onClick={() => {
                                    onCompact();
                                    close();
                                }}
                                variant="secondary"
                            >
                                <Icon icon={Sparkles} size="sm" tone="inherit" />
                                Compact context
                            </Button>
                            <Button
                                className="w-full min-w-0 justify-center"
                                disabled={busy}
                                onClick={() => {
                                    onReset();
                                    close();
                                }}
                                variant="danger"
                            >
                                <Icon icon={RotateCcw} size="sm" tone="inherit" />
                                Reset provider transcript
                            </Button>
                        </div>
                    </PopoverPanel>
                </>
            )}
        </Popover>
    );
}
