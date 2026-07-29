import { useEffect, useState } from "react";

import type { ChatRow } from "./chatTypes";
import type { ChatCompactionStatus } from "./domain/chatProjection";
import type { ChatRunState } from "./domain/chatState";

const ACTIVE_COMPACTION_TIMEOUT_MS = 5 * 60_000;
const COMPLETED_COMPACTION_VISIBILITY_MS = 5000;

/**
 * Keeps explicit compaction lifecycle feedback bounded like OpenClaw Control UI.
 * @param status Status value.
 * @returns Chat compaction indicator state and actions.
 */
export function useChatCompactionIndicator(
    status: ChatCompactionStatus | undefined
): ChatCompactionStatus | undefined {
    const [expiredStatusIdentity, setExpiredStatusIdentity] = useState("");
    const [mountedAt] = useState(() => Date.now());
    const duration =
        status?.phase === "active"
            ? ACTIVE_COMPACTION_TIMEOUT_MS
            : COMPLETED_COMPACTION_VISIBILITY_MS;
    const statusIdentity = status
        ? `${status.key}:${status.phase}:${status.timestamp}`
        : "";
    const statusTimestamp = Date.parse(status?.timestamp || "");
    const expiresAt = Number.isNaN(statusTimestamp)
        ? undefined
        : statusTimestamp + duration;
    const expiredBeforeMount = expiresAt !== undefined && expiresAt <= mountedAt;

    useEffect(() => {
        if (!statusIdentity || expiredBeforeMount) {
            return;
        }
        const remaining = Math.max(0, (expiresAt ?? Date.now() + duration) - Date.now());
        const timeout = setTimeout(
            () => setExpiredStatusIdentity(statusIdentity),
            remaining
        );
        return () => clearTimeout(timeout);
    }, [duration, expiredBeforeMount, expiresAt, statusIdentity]);

    return expiredBeforeMount || statusIdentity === expiredStatusIdentity
        ? undefined
        : status;
}

/**
 * Converts visible lifecycle feedback into the existing activity-row contract.
 * @returns Converted visible lifecycle feedback into the existing activity-row contract.
 */
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

interface ChatActivityProjectionOptions {
    activeRuns: readonly Pick<ChatRunState, "runId">[];
    compactionStatus: ChatCompactionStatus | undefined;
    isActiveSession: boolean;
    rows: ChatRow[];
    sessionKey: string;
}

/**
 * Keeps one activity row visible while preferring explicit compaction feedback.
 * @returns Project chat activity rows result.
 */
export function projectChatActivityRows({
    activeRuns,
    compactionStatus,
    isActiveSession,
    rows,
    sessionKey,
}: ChatActivityProjectionOptions): ChatRow[] {
    if (compactionStatus?.phase === "active") {
        return [
            ...rows.filter((row) => row.kind !== "typing"),
            compactionIndicatorRow(compactionStatus),
        ];
    }
    if (compactionStatus) {
        return [...rows, compactionIndicatorRow(compactionStatus)];
    }
    if (
        !isActiveSession ||
        !sessionKey ||
        rows.some(
            (row) =>
                row.kind === "typing" ||
                (row.kind === "stream" &&
                    activeRuns.some((run) => run.runId === row.message.runId))
        )
    ) {
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
