import { Brain, type LucideIcon, Minimize2, Wrench } from "lucide-react";

import type { Session } from "../../../types/session";
import { formatDuration, formatTokens, getTokenPercent } from "../../../utils/format";
import { formatSessionType } from "../../../utils/sessionUtilities";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";

/** Represents option. */
interface Option {
    value: string;
    label: string;
    description?: string;
}

/** Provides props for diagnostic toggle. */
interface DiagnosticToggleProperties {
    active: boolean;
    icon: LucideIcon;
    label: string;
    title: string;
    onClick: () => void;
}

/** Renders the diagnostic toggle UI. */
function DiagnosticToggle({
    active,
    icon: Icon,
    label,
    title,
    onClick,
}: DiagnosticToggleProperties) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={active}
            className={[
                "gap-1.5 rounded-full border px-2.5 py-1.5 text-xs",
                active
                    ? "border-accent-400/40 bg-accent-500/20 text-accent-100 shadow-[0_0_0_1px_rgba(99,102,241,0.12)] hover:bg-accent-500/25"
                    : "border-primary-700/80 bg-primary-900/40 text-primary-300 hover:border-primary-600 hover:bg-primary-800/80 hover:text-primary-100",
            ].join(" ")}
            onClick={onClick}
            title={title}
        >
            <Icon className="size-3.5" aria-hidden="true" />
            <span>{label}</span>
        </Button>
    );
}

/** Provides props for chat header. */
interface ChatHeaderProperties {
    selectedSession: Session | undefined;
    selectedAgentId: string;
    selectedSessionKey: string;
    sessionOptions: Option[];
    agentOptions: Option[];
    shouldShowThinking: boolean;
    shouldShowTools: boolean;
    sessionControlsDisabled: boolean;
    isCompacting: boolean;
    onToggleThinking: () => void;
    onToggleTools: () => void;
    onSelectAgent: (agentId: string) => void;
    onSelectSession: (sessionKey: string) => void;
    onSelectThinkingLevel: (thinkingLevel: string) => void;
    onSelectSpeed: (speed: string) => void;
    onCompact: () => void;
}

/** Normalizes legacy thinking labels to OpenClaw's canonical level ids. */
export function normalizeThinkingLevel(level: string): string | undefined {
    const key = level.trim().toLowerCase();
    const collapsed = key.replaceAll(/[\s_-]+/g, "");
    if (collapsed === "adaptive" || collapsed === "auto") return "adaptive";
    if (collapsed === "max") return "max";
    if (collapsed === "xhigh" || collapsed === "extrahigh") return "xhigh";
    if (collapsed === "off") return "off";
    if (["on", "enable", "enabled"].includes(collapsed)) return "low";
    if (["min", "minimal", "think"].includes(collapsed)) return "minimal";
    if (["low", "thinkhard"].includes(collapsed)) {
        return "low";
    }
    if (["mid", "med", "medium", "thinkharder", "harder"].includes(collapsed)) {
        return "medium";
    }
    if (["high", "ultra", "ultrathink", "thinkhardest", "highest"].includes(collapsed)) {
        return "high";
    }
    return undefined;
}

/** Returns the model-supported thinking options exposed by OpenClaw. */
export function chatThinkingOptions(session: Session | undefined): Option[] {
    const levels = session?.thinkingLevels?.length
        ? session.thinkingLevels
        : (session?.thinkingOptions || [])
              .map((label) => ({ id: normalizeThinkingLevel(label), label }))
              .filter((level): level is { id: string; label: string } =>
                  Boolean(level.id)
              );
    const currentLevel = session?.thinkingLevel;
    const options = levels.map((level) => ({
        label: level.label || level.id,
        value: level.id,
    }));

    if (currentLevel && options.every((option) => option.value !== currentLevel)) {
        options.push({ label: currentLevel, value: currentLevel });
    }

    const defaultLabel = session?.thinkingDefault
        ? `Default (${session.thinkingDefault})`
        : "Default";
    return [{ label: defaultLabel, value: "" }, ...options];
}

/** Returns the OpenClaw fast-mode choices. */
export function chatSpeedOptions(session?: Session): Option[] {
    const effectiveMode = session?.effectiveFastMode;
    const effectiveLabel =
        effectiveMode === "auto"
            ? "Auto"
            : effectiveMode === true
              ? "Fast"
              : effectiveMode === false
                ? "Standard"
                : undefined;
    const defaultLabel = effectiveLabel ? `Default (${effectiveLabel})` : "Default";
    return [
        { label: defaultLabel, value: "" },
        { label: "Fast", value: "on" },
        { label: "Standard", value: "off" },
        { label: "Auto", value: "auto" },
    ];
}

/** Returns the selected fast-mode override value. */
export function selectedChatSpeed(session: Session | undefined): string {
    if (session?.fastMode === "auto") return "auto";
    if (session?.fastMode === true) return "on";
    if (session?.fastMode === false) return "off";
    return "";
}

/** Formats header status for display. */
function formatHeaderStatus(selectedSession: Session | undefined): string {
    if (!selectedSession) {
        return "Choose a session to begin";
    }

    const usedTokens = Math.max(0, selectedSession.tokenCount || 0);
    const maxTokens = Math.max(0, selectedSession.maxTokens || 0);
    const contextText = maxTokens
        ? selectedSession.totalTokensFresh === false
            ? `~${formatTokens(usedTokens, maxTokens)} (stale)`
            : `${formatTokens(usedTokens, maxTokens)} (${getTokenPercent(usedTokens, maxTokens)}%)`
        : "Unknown";

    return `${formatSessionType(selectedSession)} · ${selectedSession.model || "Unknown"} · Context: ${contextText} · ${formatDuration(selectedSession.updatedAt)}`;
}

/** Renders the chat header UI. */
export function ChatHeader({
    selectedSession,
    selectedAgentId,
    selectedSessionKey,
    sessionOptions,
    agentOptions,
    shouldShowThinking,
    shouldShowTools,
    sessionControlsDisabled,
    isCompacting,
    onToggleThinking,
    onToggleTools,
    onSelectAgent,
    onSelectSession,
    onSelectThinkingLevel,
    onSelectSpeed,
    onCompact,
}: ChatHeaderProperties) {
    const thinkingOptions = chatThinkingOptions(selectedSession);
    const speedOptions = chatSpeedOptions(selectedSession);

    return (
        <div className="border-b border-primary-700 pb-2 sm:pb-3">
            <div className="flex flex-col gap-2 sm:gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-xs wrap-break-word text-primary-400 sm:truncate sm:text-sm">
                            {formatHeaderStatus(selectedSession)}
                        </p>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="rounded-full border border-primary-700/80 px-2 py-1 text-xs"
                            disabled={
                                !selectedSession ||
                                sessionControlsDisabled ||
                                isCompacting
                            }
                            onClick={onCompact}
                            title="Compact the selected session context"
                        >
                            <Minimize2 className="size-3.5" aria-hidden="true" />
                            {isCompacting ? "Compacting…" : "Compact"}
                        </Button>
                    </div>
                </div>
                <div className="flex w-full flex-col gap-2 lg:ml-auto lg:w-auto lg:flex-row lg:items-center lg:justify-end">
                    <div className="flex shrink-0 flex-wrap justify-start gap-1.5 lg:justify-end">
                        <DiagnosticToggle
                            active={shouldShowThinking}
                            icon={Brain}
                            label="Thinking"
                            title="Toggle assistant thinking / working output"
                            onClick={onToggleThinking}
                        />
                        <DiagnosticToggle
                            active={shouldShowTools}
                            icon={Wrench}
                            label="Tools"
                            title="Toggle tool calls and tool result output"
                            onClick={onToggleTools}
                        />
                    </div>
                    <div
                        className={[
                            "grid w-full gap-2",
                            agentOptions.length > 0
                                ? "sm:grid-cols-2 xl:grid-cols-4 lg:w-[min(54rem,78vw)] xl:w-228"
                                : "sm:grid-cols-3 lg:w-[min(42rem,60vw)] xl:w-168",
                        ].join(" ")}
                    >
                        {agentOptions.length > 0 ? (
                            <Select
                                value={selectedAgentId}
                                onChange={onSelectAgent}
                                options={agentOptions}
                                placeholder="Select agent"
                                ariaLabel="Agent"
                                width="w-full"
                                menuWidth="max-w-[min(42rem,calc(100vw-2rem))]"
                            />
                        ) : undefined}
                        <Select
                            value={selectedSessionKey}
                            onChange={onSelectSession}
                            options={sessionOptions}
                            placeholder="Select session"
                            ariaLabel="Session"
                            width="w-full"
                            menuWidth="max-w-[min(42rem,calc(100vw-2rem))]"
                        />
                        <Select
                            value={selectedSession?.thinkingLevel || ""}
                            onChange={onSelectThinkingLevel}
                            options={thinkingOptions}
                            placeholder="Thinking"
                            ariaLabel="Thinking level"
                            width="w-full"
                            disabled={!selectedSession || sessionControlsDisabled}
                        />
                        <Select
                            value={selectedChatSpeed(selectedSession)}
                            onChange={onSelectSpeed}
                            options={speedOptions}
                            placeholder="Speed"
                            ariaLabel="Speed"
                            width="w-full"
                            disabled={!selectedSession || sessionControlsDisabled}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
