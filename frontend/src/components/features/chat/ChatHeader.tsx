import { Bot, Brain, Cpu, Gauge, MessagesSquare } from "lucide-react";
import { useEffect, useState } from "react";

import type { Session } from "../../../../../contracts/sessions";
import { cn } from "../../../utils/cn";
import { formatDuration, formatTokens, getTokenPercent } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Select } from "../../ui/Select";
import { selectedChatSpeedLabel, selectedChatThinkingLabel } from "./chatUtilities";

const HEADER_STATUS_REFRESH_MS = 5000;

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

/**
 * Formats header status for display.
 * @param selectedSession Selected session value.
 * @param referenceTime Reference time value.
 * @returns Formatted header status for display.
 */
function formatHeaderStatus(
    selectedSession: Session | undefined,
    referenceTime: number
): string {
    if (!selectedSession) {
        return "Choose a session to begin";
    }

    const usedTokens = Math.max(0, selectedSession.tokenCount || 0);
    const maxTokens = Math.max(0, selectedSession.maxTokens || 0);
    let contextText = "Unknown";
    if (maxTokens) {
        contextText =
            selectedSession.totalTokensFresh === false
                ? `~${formatTokens(usedTokens, maxTokens)} (stale)`
                : `${formatTokens(usedTokens, maxTokens)} (${getTokenPercent(usedTokens, maxTokens)}%)`;
    }
    const updatedAtRef =
        typeof selectedSession.updatedAt === "number" &&
        Number.isFinite(selectedSession.updatedAt)
            ? selectedSession.updatedAt
            : 0;

    return `Context: ${contextText} · ${formatDuration(selectedSession.updatedAt, {
        includeSeconds: true,
        referenceTime: Math.max(referenceTime, updatedAtRef),
    })}`;
}

/**
 * Renders the chat header UI.
 * @returns Rendered the chat header UI.
 */
export function ChatHeader({
    selectedSession,
    selectedAgentId,
    selectedSessionKey,
    sessionOptions,
    agentOptions,
    onSelectAgent,
    onSelectSession,
}: ChatHeaderProperties) {
    const [referenceTime, setReferenceTime] = useState(() => Date.now());

    useEffect(() => {
        if (selectedSession?.updatedAt === undefined) return;

        const timer = setInterval(() => {
            setReferenceTime(Date.now());
        }, HEADER_STATUS_REFRESH_MS);

        return () => {
            clearInterval(timer);
        };
    }, [selectedSession?.updatedAt]);

    return (
        <div className="border-b border-primary-700 pb-2 sm:pb-3">
            <div className="flex flex-col gap-2 sm:gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center">
                        <p className="text-xs wrap-break-word text-primary-400 sm:truncate sm:text-sm">
                            {formatHeaderStatus(selectedSession, referenceTime)}
                        </p>
                        {selectedSession ? (
                            <div
                                className="flex flex-wrap items-center gap-1.5"
                                data-testid="chat-session-badges"
                            >
                                <Badge
                                    aria-label={`Model: ${selectedSession.model || "Unknown"}`}
                                    className="whitespace-nowrap"
                                    title="Model"
                                >
                                    <Cpu aria-hidden="true" className="size-3.5" />
                                    {selectedSession.model || "Unknown"}
                                </Badge>
                                <Badge
                                    aria-label={`Thinking: ${selectedChatThinkingLabel(selectedSession)}`}
                                    className="whitespace-nowrap"
                                    title="Thinking"
                                >
                                    <Brain aria-hidden="true" className="size-3.5" />
                                    {selectedChatThinkingLabel(selectedSession)}
                                </Badge>
                                <Badge
                                    aria-label={`Speed: ${selectedChatSpeedLabel(selectedSession)}`}
                                    className="whitespace-nowrap"
                                    title="Speed"
                                >
                                    <Gauge aria-hidden="true" className="size-3.5" />
                                    {selectedChatSpeedLabel(selectedSession)}
                                </Badge>
                            </div>
                        ) : undefined}
                    </div>
                </div>
                <div className="flex w-full flex-col gap-2 lg:ml-auto lg:w-auto lg:flex-row lg:items-center lg:justify-end">
                    <div
                        className={cn(
                            "grid w-full grid-cols-2 gap-2",
                            agentOptions.length > 0
                                ? "lg:w-[min(32rem,48vw)]"
                                : "grid-cols-1 lg:w-[min(20rem,34vw)]"
                        )}
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
