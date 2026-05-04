import type { Session } from "../../../types/session";
import { formatDuration } from "../../../utils/format";
import { formatSessionType } from "../../../utils/sessionUtils";
import { Select } from "../../ui/Select";

interface Option {
    value: string;
    label: string;
    description?: string;
}

interface ChatHeaderProps {
    selectedSession: Session | null;
    selectedSessionKey: string;
    sessionOptions: Option[];
    agentOptions: Option[];
    onSelectSession: (sessionKey: string) => void;
}

export function ChatHeader({
    selectedSession,
    selectedSessionKey,
    sessionOptions,
    agentOptions,
    onSelectSession,
}: ChatHeaderProps) {
    return (
        <div className="border-b border-primary-700 pb-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                    <p className="truncate text-sm text-primary-400">
                        {selectedSession
                            ? `${formatSessionType(selectedSession)} · ${selectedSession.model || "Unknown"} · ${formatDuration(selectedSession.updatedAt)}`
                            : "Choose a session to begin"}
                    </p>
                </div>
                <div
                    className={[
                        "grid w-full gap-2 lg:ml-auto",
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
    );
}
