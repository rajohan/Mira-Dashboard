import { Brain, type LucideIcon, Wrench } from "lucide-react";

import type { Session } from "../../../types/session";
import { formatDuration } from "../../../utils/format";
import { formatSessionType } from "../../../utils/sessionUtils";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";

/** Represents option. */
interface Option {
    value: string;
    label: string;
    description?: string;
}

/** Provides props for diagnostic toggle. */
interface DiagnosticToggleProps {
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
}: DiagnosticToggleProps) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={active}
            className={[
                "gap-1.5 rounded-full border px-2.5 py-1.5 text-xs",
                active
                    ? "border-accent-400/40 bg-accent-500/20 text-accent-100 hover:bg-accent-500/25 shadow-[0_0_0_1px_rgba(99,102,241,0.12)]"
                    : "border-primary-700/80 bg-primary-900/40 text-primary-300 hover:border-primary-600 hover:bg-primary-800/80 hover:text-primary-100",
            ].join(" ")}
            onClick={onClick}
            title={title}
        >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{label}</span>
        </Button>
    );
}

/** Provides props for chat header. */
interface ChatHeaderProps {
    selectedSession: Session | null;
    selectedAgentId: string;
    selectedSessionKey: string;
    sessionOptions: Option[];
    agentOptions: Option[];
    showThinking: boolean;
    showTools: boolean;
    onToggleThinking: () => void;
    onToggleTools: () => void;
    onSelectAgent: (agentId: string) => void;
    onSelectSession: (sessionKey: string) => void;
}

/** Formats header status for display. */
function formatHeaderStatus(selectedSession: Session | null): string {
    if (!selectedSession) {
        return "Choose a session to begin";
    }

    const thinkingLevel = selectedSession.thinkingLevel || "default";

    return `${formatSessionType(selectedSession)} · ${selectedSession.model || "Unknown"} · Thinking: ${thinkingLevel} · ${formatDuration(selectedSession.updatedAt)}`;
}

/** Renders the chat header UI. */
export function ChatHeader({
    selectedSession,
    selectedAgentId,
    selectedSessionKey,
    sessionOptions,
    agentOptions,
    showThinking,
    showTools,
    onToggleThinking,
    onToggleTools,
    onSelectAgent,
    onSelectSession,
}: ChatHeaderProps) {
    return (
        <div className="border-primary-700 border-b pb-2 sm:pb-3">
            <div className="flex flex-col gap-2 sm:gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <p className="text-primary-400 text-xs break-words sm:truncate sm:text-sm">
                        {formatHeaderStatus(selectedSession)}
                    </p>
                </div>
                <div className="flex w-full flex-col gap-2 lg:ml-auto lg:w-auto lg:flex-row lg:items-center lg:justify-end">
                    <div className="flex shrink-0 flex-wrap justify-start gap-1.5 lg:justify-end">
                        <DiagnosticToggle
                            active={showThinking}
                            icon={Brain}
                            label="Thinking"
                            title="Toggle assistant thinking / working output"
                            onClick={onToggleThinking}
                        />
                        <DiagnosticToggle
                            active={showTools}
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
                                ? "sm:grid-cols-2 lg:w-[min(48rem,72vw)] xl:w-[52rem]"
                                : "lg:w-[min(24rem,36vw)] xl:w-[26rem]",
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
                        ) : null}
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
