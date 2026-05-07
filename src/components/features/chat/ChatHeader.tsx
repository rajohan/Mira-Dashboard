import { Brain, type LucideIcon, Wrench } from "lucide-react";

import type { Session } from "../../../types/session";
import { formatDuration } from "../../../utils/format";
import { formatSessionType } from "../../../utils/sessionUtils";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";

interface Option {
    value: string;
    label: string;
    description?: string;
}

interface DiagnosticToggleProps {
    active: boolean;
    icon: LucideIcon;
    label: string;
    title: string;
    onClick: () => void;
}

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
                    ? "border-accent-400/40 bg-accent-500/20 text-accent-100 shadow-[0_0_0_1px_rgba(99,102,241,0.12)] hover:bg-accent-500/25"
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

interface ChatHeaderProps {
    selectedSession: Session | null;
    selectedSessionKey: string;
    sessionOptions: Option[];
    agentOptions: Option[];
    showThinking: boolean;
    showTools: boolean;
    onToggleThinking: () => void;
    onToggleTools: () => void;
    onSelectSession: (sessionKey: string) => void;
}

function formatHeaderStatus(selectedSession: Session | null): string {
    if (!selectedSession) {
        return "Choose a session to begin";
    }

    const thinkingLevel = selectedSession.thinkingLevel || "default";

    return `${formatSessionType(selectedSession)} · ${selectedSession.model || "Unknown"} · Thinking: ${thinkingLevel} · ${formatDuration(selectedSession.updatedAt)}`;
}

export function ChatHeader({
    selectedSession,
    selectedSessionKey,
    sessionOptions,
    agentOptions,
    showThinking,
    showTools,
    onToggleThinking,
    onToggleTools,
    onSelectSession,
}: ChatHeaderProps) {
    return (
        <div className="border-b border-primary-700 pb-2 sm:pb-3">
            <div className="flex flex-col gap-2 sm:gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <p className="break-words text-xs text-primary-400 sm:truncate sm:text-sm">
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
                        <Select
                            value={selectedSessionKey}
                            onChange={onSelectSession}
                            options={sessionOptions}
                            placeholder="Select session"
                            width="w-full"
                            menuWidth="max-w-[min(42rem,calc(100vw-2rem))]"
                        />
                        {agentOptions.length > 0 ? (
                            <Select
                                value=""
                                onChange={onSelectSession}
                                options={agentOptions}
                                placeholder="Jump to agent"
                                width="w-full"
                                menuWidth="max-w-[min(42rem,calc(100vw-2rem))]"
                            />
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
