import Path from "node:path";

import { guardedPath, readTextNoFollowGuarded } from "../../lib/guardedOps.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { getSafeAgentSessionsDirectory } from "./agentPaths.ts";

const logger = createStructuredLogger("agents");

export interface SessionInfo {
    key?: string;
    sessionId?: string;
    updatedAt?: number;
    channel?: string;
    displayName?: string;
    label?: string;
}

function isSessionInfo(value: unknown): value is SessionInfo {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const session = value as SessionInfo;
    return (
        typeof session.key === "string" &&
        (session.sessionId === undefined || typeof session.sessionId === "string") &&
        (session.updatedAt === undefined || typeof session.updatedAt === "number") &&
        (session.channel === undefined || typeof session.channel === "string") &&
        (session.displayName === undefined || typeof session.displayName === "string") &&
        (session.label === undefined || typeof session.label === "string")
    );
}

/**
 * Loads cached Gateway session summaries for an agent from guarded storage.
 * @param agentId Agent identifier.
 * @returns Cached session summaries, or an empty list when unavailable.
 */
export async function getAgentSessionsFromFiles(agentId: string): Promise<SessionInfo[]> {
    const sessionsDirectory = getSafeAgentSessionsDirectory(agentId);
    if (!sessionsDirectory) {
        return [];
    }

    try {
        const content = await readTextNoFollowGuarded(
            guardedPath(Path.join(sessionsDirectory, "sessions.json"))
        );
        const sessions = Bun.JSON5.parse(content);
        return Array.isArray(sessions)
            ? sessions.filter((session) => isSessionInfo(session))
            : [];
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        logger.error("agents.sessions_read_failed", { error });
        return [];
    }
}
