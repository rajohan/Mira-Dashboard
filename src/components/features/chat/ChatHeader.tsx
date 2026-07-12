import { Bot, MessagesSquare } from "lucide-react";

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
                            "grid w-full grid-cols-2 gap-2",
                            agentOptions.length > 0
                                ? "lg:w-[min(32rem,48vw)]"
                                : "grid-cols-1 lg:w-[min(20rem,34vw)]",
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
                                icon={<Bot className="size-4" />}
                                compactOnMobile
                                className="justify-center px-2 sm:justify-start"
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
                            icon={<MessagesSquare className="size-4" />}
                            compactOnMobile
                            className="justify-center px-2 sm:justify-start"
                            menuWidth="max-w-[min(42rem,calc(100vw-2rem))]"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
