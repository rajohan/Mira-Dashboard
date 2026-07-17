import { useEffect, useState } from "react";

import type { ChatRow } from "./chatTypes";
import type { ChatCompactionStatus } from "./domain/chatProjection";

const ACTIVE_COMPACTION_TIMEOUT_MS = 5 * 60_000;
const COMPLETED_COMPACTION_VISIBILITY_MS = 5000;

/** Keeps explicit compaction lifecycle feedback bounded like OpenClaw Control UI. */
export function useChatCompactionIndicator(
    status: ChatCompactionStatus | undefined
): ChatCompactionStatus | undefined {
    const [expiredKey, setExpiredKey] = useState("");
    const duration =
        status?.phase === "active"
            ? ACTIVE_COMPACTION_TIMEOUT_MS
            : COMPLETED_COMPACTION_VISIBILITY_MS;
    const statusKey = status?.key;
    const statusTimestamp = Date.parse(status?.timestamp || "");
    const expiresAt = Number.isNaN(statusTimestamp)
        ? undefined
        : statusTimestamp + duration;
    const hasAlreadyExpired = expiresAt !== undefined && expiresAt <= Date.now();

    useEffect(() => {
        if (!statusKey) {
            return;
        }
        const remaining = Math.max(0, (expiresAt ?? Date.now() + duration) - Date.now());
        if (remaining === 0) {
            setExpiredKey(statusKey);
            return;
        }
        const timeout = setTimeout(() => setExpiredKey(statusKey), remaining);
        return () => clearTimeout(timeout);
    }, [duration, expiresAt, statusKey]);

    return hasAlreadyExpired || status?.key === expiredKey ? undefined : status;
}

/** Converts visible lifecycle feedback into the existing activity-row contract. */
export function compactionIndicatorRow(status: ChatCompactionStatus): ChatRow {
    return {
        key: `compaction-${status.key}`,
        kind: status.phase === "active" ? "typing" : "status",
        message: {
            content: status.text,
            role: "assistant",
            text: status.text,
        },
    };
}

/** Keeps one activity row visible while preferring explicit compaction feedback. */
export function projectChatActivityRows(
    rows: ChatRow[],
    compactionStatus: ChatCompactionStatus | undefined,
    isActiveSession: boolean,
    sessionKey: string
): ChatRow[] {
    if (compactionStatus) {
        return [
            ...rows.filter((row) => row.kind !== "typing"),
            compactionIndicatorRow(compactionStatus),
        ];
    }
    if (!isActiveSession || !sessionKey || rows.some((row) => row.kind === "typing")) {
        return rows;
    }
    return [
        ...rows,
        {
            key: `typing-session-${sessionKey}`,
            kind: "typing",
            message: { content: "Thinking", role: "assistant", text: "Thinking" },
        },
    ];
}
