import type { Session } from "../../../types/session";
import { formatDuration, formatTokens, getTokenPercent } from "../../../utils/format";
import { formatSessionType } from "../../../utils/sessionUtilities";
import { Select } from "../../ui/Select";

/** Represents option. */
interface Option {
    value: string;
    label: string;
    description?: string;
}

/** Provides props for chat header. */
interface ChatHeaderProperties {
    selectedSession: Session | undefined;
    selectedAgentId: string;
    selectedSessionKey: string;
    sessionOptions: Option[];
    agentOptions: Option[];
    onSelectAgent: (agentId: string) => void;
    onSelectSession: (sessionKey: string) => void;
    shouldShowThinking?: boolean;
    shouldShowTools?: boolean;
    sessionControlsDisabled?: boolean;
    isCompacting?: boolean;
    onToggleThinking?: () => void;
    onToggleTools?: () => void;
    onSelectThinkingLevel?: (value: string) => void;
    onSelectSpeed?: (value: string) => void;
    onCompact?: () => void;
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

/** Converts legacy labels to unique canonical thinking choices. */
function normalizeThinkingOptions(labels: string[]) {
    const seenIds = new Set<string>();
    const levels: Array<{ id: string; label: string }> = [];
    for (const label of labels) {
        const id = normalizeThinkingLevel(label);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        levels.push({ id, label });
    }
    return levels;
}

/** Returns the model-supported thinking options exposed by OpenClaw. */
export function chatThinkingOptions(session: Session | undefined): Option[] {
    const levels = session?.thinkingLevels?.length
        ? session.thinkingLevels
        : normalizeThinkingOptions(session?.thinkingOptions || []);
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
    onSelectAgent,
    onSelectSession,
}: ChatHeaderProperties) {
    return (
        <div className="border-b border-primary-700 pb-2 sm:pb-3">
            <div className="flex flex-col gap-2 sm:gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-xs wrap-break-word text-primary-400 sm:truncate sm:text-sm">
                            {formatHeaderStatus(selectedSession)}
                        </p>
                    </div>
                </div>
                <div className="flex w-full flex-col gap-2 lg:ml-auto lg:w-auto lg:flex-row lg:items-center lg:justify-end">
                    <div
                        className={[
                            "grid w-full gap-2",
                            agentOptions.length > 0
                                ? "sm:grid-cols-2 lg:w-[min(36rem,54vw)]"
                                : "lg:w-[min(24rem,40vw)]",
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
                    </div>
                </div>
            </div>
        </div>
    );
}
