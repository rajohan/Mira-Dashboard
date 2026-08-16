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
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
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

function modelProviderLabel(model: string): string {
    const provider = model.split("/", 1)[0] ?? "other";
    if (provider.toLowerCase() === "openai") return "OpenAI";
    if (provider.toLowerCase() === "synthetic") return "Synthetic";
    return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function canonicalSelectedModel(
    model: string | undefined,
    inventory: readonly string[]
): string | undefined {
    if (model === undefined || model.includes("/")) return model;
    const matches = inventory.filter((candidate) => candidate.endsWith(`/${model}`));
    return matches.length === 1 ? matches[0] : model;
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
        <Button
            aria-pressed={pressed}
            className={cn(
                "focus-visible:ring-accent-300 flex w-full min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:opacity-45",
                pressed
                    ? "border-accent-400 bg-primary-900 data-hover:bg-primary-800 hover:bg-primary-800"
                    : "border-primary-500 bg-primary-800 data-hover:border-primary-400 data-hover:bg-primary-900 hover:border-primary-400 hover:bg-primary-900"
            )}
            disabled={disabled}
            onClick={onToggle}
            type="button"
            variant="unstyled"
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
        </Button>
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
    const selectedModel = canonicalSelectedModel(send.model, session.modelOptions);
    const modelOptions = [
        ...new Set(
            [selectedModel, session.model, ...session.modelOptions]
                .map((model) => canonicalSelectedModel(model, session.modelOptions))
                .filter(Boolean)
        ),
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
                        as={IconOnlyButton}
                        className="focus-visible:ring-accent-400 min-h-10 min-w-10 shrink-0 px-0 focus-visible:ring-offset-0 sm:min-h-9 sm:min-w-9"
                        icon={Settings2}
                        label="Chat settings"
                        size="sm"
                        variant="ghost"
                    />
                    <PopoverPanel
                        anchor={{ gap: 10, padding: 12, to: "top start" }}
                        aria-label="Chat settings"
                        className="border-primary-600 bg-primary-950 z-50 max-h-[calc(100dvh-1.5rem)] w-[min(23rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-xl border p-3 text-sm shadow-xl shadow-black/35 outline-none"
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
                            <IconOnlyButton
                                className="shrink-0 p-1.5"
                                icon={X}
                                label="Close chat settings"
                                onClick={() => close()}
                                size="sm"
                                variant="ghost"
                            />
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
                            <FormField className="space-y-1.5" label="Model">
                                <Select
                                    ariaLabel="Chat model"
                                    disabled={busy || modelOptions.length === 0}
                                    onChange={(model) =>
                                        onSendSettingsChange({ ...send, model })
                                    }
                                    options={modelOptions.map((model) => ({
                                        group: modelProviderLabel(model),
                                        label: chatModelDisplayName(model),
                                        value: model,
                                    }))}
                                    value={selectedModel ?? modelOptions[0] ?? ""}
                                />
                            </FormField>
                            {modelInventoryError !== undefined && (
                                <div
                                    aria-label="Available models warning"
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
                                            Try loading models again
                                        </Button>
                                    )}
                                </div>
                            )}
                            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                                <FormField className="space-y-1.5" label="Thinking">
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
                                <FormField className="space-y-1.5" label="Speed">
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
                                Display
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

                        <div className="border-primary-700 mt-3 flex justify-end gap-2 border-t pt-3">
                            <Button
                                disabled={busy}
                                onClick={() => {
                                    onCompact();
                                    close();
                                }}
                                size="sm"
                                variant="secondary"
                            >
                                <Icon icon={Sparkles} size="sm" tone="inherit" />
                                Compact
                            </Button>
                            <Button
                                disabled={busy}
                                onClick={() => {
                                    onReset();
                                    close();
                                }}
                                size="sm"
                                variant="danger"
                            >
                                <Icon icon={RotateCcw} size="sm" tone="inherit" />
                                Reset
                            </Button>
                        </div>
                    </PopoverPanel>
                </>
            )}
        </Popover>
    );
}
