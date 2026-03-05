import { Coins } from "lucide-react";

import type { Session } from "../../../types/session";
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
                                key={
                                    session.key ||
                                    session.id ||
                                    `session-${Math.random()}`
                                }
                                className="flex items-center justify-between border-b border-primary-700/50 py-2 text-sm last:border-0"
                            >
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                    <Badge variant={getSessionTypeVariant(session.type)}>
                                        {formatSessionType(session)}
                                    </Badge>
                                    <span
                                        className="truncate text-primary-300"
                                        title={
                                            session.displayLabel ||
                                            session.label ||
                                            session.displayName ||
                                            session.id ||
                                            "unknown"
                                        }
                                    >
                                        {session.displayLabel ||
                                            session.label ||
                                            session.displayName ||
                                            (session.id || session.key)?.slice(0, 12) ||
                                            "unknown"}
                                    </span>
                                </div>
                                <div className="ml-2 flex flex-shrink-0 items-center gap-2">
                                    <Coins className="h-3 w-3 text-primary-400" />
                                    <span className="text-xs text-primary-400">
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
                <p className="text-primary-400">No active sessions</p>
            )}
        </Card>
    );
}
