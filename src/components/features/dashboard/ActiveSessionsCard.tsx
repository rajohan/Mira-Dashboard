import { Coins } from "lucide-react";

import type { Session } from "../../../hooks/useOpenClaw";
import { formatTokens, getTokenPercent } from "../../../utils/format";
import { formatSessionType } from "../../../utils/sessionUtils";
import { Badge, getSessionTypeVariant } from "../../ui/Badge";
import { Card, CardTitle } from "../../ui/Card";
import { ProgressBar } from "../../ui/ProgressBar";

interface ActiveSessionsCardProps {
    sessions: Session[];
}

export function ActiveSessionsCard({ sessions }: ActiveSessionsCardProps) {
    return (
        <Card variant="bordered">
            <CardTitle className="mb-4">Active Sessions</CardTitle>
            {sessions.length > 0 ? (
                <div className="max-h-64 space-y-2 overflow-y-auto pr-2">
                    {sessions.map((session) => {
                        const tokenPercent = getTokenPercent(
                            session.tokenCount || 0,
                            session.maxTokens || 200_000
                        );
                        return (
                            <div
                                key={session.id}
                                className="flex items-center justify-between border-b border-slate-700/50 py-2 text-sm last:border-0"
                            >
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                    <Badge
                                        variant={getSessionTypeVariant(session.type)}
                                    >
                                        {formatSessionType(session)}
                                    </Badge>
                                    <span
                                        className="truncate text-slate-300"
                                        title={
                                            session.displayLabel ||
                                            session.label ||
                                            session.displayName ||
                                            session.id
                                        }
                                    >
                                        {session.displayLabel ||
                                            session.label ||
                                            session.displayName ||
                                            session.id.slice(0, 12)}
                                    </span>
                                </div>
                                <div className="ml-2 flex flex-shrink-0 items-center gap-2">
                                    <Coins className="h-3 w-3 text-slate-400" />
                                    <span className="text-xs text-slate-400">
                                        {formatTokens(
                                            session.tokenCount || 0,
                                            session.maxTokens || 200_000
                                        )}
                                    </span>
                                    <ProgressBar
                                        percent={tokenPercent}
                                        size="sm"
                                        className="w-12"
                                    />
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <p className="text-slate-400">No active sessions</p>
            )}
        </Card>
    );
}
