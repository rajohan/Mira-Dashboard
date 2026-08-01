import FS from "node:fs";
import Path from "node:path";

import type {
    Agent as AgentStatus,
    AgentMetadata,
    AgentsConfig,
} from "../../../contracts/agents.ts";
import { database } from "../database.ts";
import {
    guardedPath,
    readTextNoFollowGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.ts";
import { safePathWithinRoot } from "../lib/safePath.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { boundedTimestamp } from "../lib/values.ts";
import {
    getLatestActivityFromFile,
    getSessionFileModificationTime,
} from "./agents/activityFileSource.ts";
import {
    assertOpenedDirectoryMatches,
    ensureRealAgentsDirectory,
    getAgentsDirectory,
    getOpenclawRoot,
    getSafeAgentSessionsDirectory,
    isProcfsAvailable,
    isValidAgentId,
    mkdirChildDirectoryFromVerifiedParent,
    prepareAgentMetadataDirectoryForWrite,
    realExistingChildDirectoryFromVerifiedParent,
} from "./agents/agentPaths.ts";
import { getActiveHistoryTask } from "./agents/agentTaskHistory.ts";
import {
    type GatewaySessionSummary,
    getGatewaySessionsForAgents,
} from "./agents/gatewaySessionSource.ts";
import {
    getAgentSessionsFromFiles,
    type SessionInfo,
} from "./agents/sessionFileSource.ts";

export {
    closeStaleActiveTasks,
    getLatestCompletedTasks,
} from "./agents/agentTaskHistory.ts";
export { isProcfsAvailable, isValidAgentId } from "./agents/agentPaths.ts";

const logger = createStructuredLogger("agents");

const ACTIVE_THRESHOLD = 20_000; // < 20s = active (tool/activity)
const THINKING_THRESHOLD = 60_000; // 20s-60s = thinking, 60s+ = idle

/**
 * Removes a provider prefix from a configured model name for display.
 * @param model Configured model name.
 * @returns Model name without its provider prefix.
 */
function toDisplayModelName(model: string): string {
    if (!model) {
        return "unknown";
    }

    const slashIndex = model.indexOf("/");
    return slashIndex === -1 ? model : model.slice(slashIndex + 1);
}

/**
 * Performs resolve configured model name.
 * @param configuredModel Configured model value.
 * @param config Config value.
 * @returns Resolve configured model name result.
 */
function resolveConfiguredModelName(
    configuredModel: string | undefined,
    config: AgentsConfig
): string {
    if (!configuredModel) {
        return "unknown";
    }

    const configured = configuredModel.trim();
    if (!configured) {
        return "unknown";
    }
    const aliases = config.defaults?.models || {};
    const matchedEntry = Object.entries(aliases).find(
        ([, value]) => value?.alias === configured
    );

    if (matchedEntry) {
        return toDisplayModelName(matchedEntry[0]);
    }

    return toDisplayModelName(configured);
}

/**
 * Returns Gateway sessions for agent keys, preferring live Gateway data and falling back to cached files on failure.
 * @returns Gateway sessions for agent keys, preferring live Gateway data and falling back to cached files on failure.
 */
function nowIso(): string {
    const now = new Date();
    return now.toISOString();
}

function timestampToIso(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toISOString();
}

async function updateAgentMetadataFromVerifiedDirectory({
    realMetadataDirectory,
    realExpectedSessionsDirectory,
    agentId,
    currentTask,
}: {
    realMetadataDirectory: string;
    realExpectedSessionsDirectory: string;
    agentId: string;
    currentTask: string;
}): Promise<{ metadata: AgentMetadata; safeTask: string; ts: string }> {
    const metadataDirectoryFd = FS.openSync(
        Buffer.from(realMetadataDirectory),
        FS.constants.O_DIRECTORY | FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW
    );
    try {
        assertOpenedDirectoryMatches(metadataDirectoryFd, realExpectedSessionsDirectory);
        const safeMetadataPath = isProcfsAvailable()
            ? Path.join("/proc/self/fd", String(metadataDirectoryFd), "metadata.json")
            : Path.join(realMetadataDirectory, "metadata.json");

        let metadata: AgentMetadata = {};
        try {
            const metadataText = await readTextNoFollowGuarded(
                guardedPath(safeMetadataPath)
            );
            let parsedMetadata: unknown;
            try {
                parsedMetadata = Bun.JSON5.parse(metadataText);
            } catch (parseError) {
                logger.warn("agents.metadata_invalid", {
                    agentId,
                    error: parseError,
                    path: Path.join(realMetadataDirectory, "metadata.json"),
                });
                parsedMetadata = {};
            }
            metadata =
                parsedMetadata &&
                typeof parsedMetadata === "object" &&
                !Array.isArray(parsedMetadata)
                    ? parsedMetadata
                    : {};
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }

        const safeTask = currentTask.trim().slice(0, 100);
        const ts = nowIso();

        if (safeTask.length > 0) {
            metadata.currentTask = safeTask;
        }
        metadata.updatedAt = ts;

        assertOpenedDirectoryMatches(metadataDirectoryFd, realExpectedSessionsDirectory);
        await writeTextNoFollowGuarded(
            guardedPath(safeMetadataPath),
            JSON.stringify(metadata, undefined, 2)
        );

        return { metadata, safeTask, ts };
    } finally {
        FS.closeSync(metadataDirectoryFd);
    }
}

/**
 * Reads the configured OpenClaw agent list from a guarded configuration file.
 * @returns Parsed agent configuration, or undefined when unavailable or unsafe.
 */
export function parseAgentsConfig(): AgentsConfig | undefined {
    const configPath = Path.join(getOpenclawRoot(), "openclaw.json");

    try {
        if (!FS.existsSync(configPath)) {
            return undefined;
        }

        const configStat = FS.lstatSync(configPath);
        if (configStat.isSymbolicLink() || configStat.nlink > 1) {
            return undefined;
        }
        const realRoot = FS.realpathSync(getOpenclawRoot());
        const realPath = FS.realpathSync(configPath);
        if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${Path.sep}`)) {
            return undefined;
        }

        const fd = FS.openSync(
            Buffer.from(realPath),
            FS.constants.O_RDONLY | FS.constants.O_NOFOLLOW
        );
        let content: string;
        try {
            content = FS.readFileSync(fd, "utf8");
        } finally {
            FS.closeSync(fd);
        }
        const parsed = Bun.JSON5.parse(content) as { agents?: AgentsConfig };

        if (parsed.agents && Array.isArray(parsed.agents.list)) {
            return parsed.agents;
        }
        return undefined;
    } catch (error) {
        logger.error("agents.openclaw_config_parse_failed", {
            error,
            path: configPath,
        });
        return undefined;
    }
}

// Read agent metadata file for current task
/**
 * Reads metadata.json for an agent using validated file access.
 * @param agentId Agent identifier.
 * @returns Read metadata.json for an agent using validated file access.
 */
async function getAgentMetadata(agentId: string): Promise<AgentMetadata | undefined> {
    const sessionsDirectory = getSafeAgentSessionsDirectory(agentId);
    if (!sessionsDirectory) {
        return undefined;
    }

    try {
        const content = await readTextNoFollowGuarded(
            guardedPath(Path.join(sessionsDirectory, "metadata.json"))
        );
        return Bun.JSON5.parse(content) as AgentMetadata;
    } catch {
        return undefined;
    }
}

/**
 * Extracts a channel identifier from a canonical session key.
 * @param sessionKey Session key to inspect.
 * @returns Channel identifier when the key encodes one.
 */
function getChannelFromSessionKey(sessionKey: string): string | undefined {
    const parts = sessionKey.split(":");
    if (parts[0] === "agent") {
        return parts[2] || undefined;
    }
    if (parts[0] === "channel") {
        return parts[1] || undefined;
    }
    return undefined;
}

/**
 * Performs determine status.
 * @param lastModificationTime Last modification time value.
 * @returns Determine status result.
 */
function determineStatus(
    lastModificationTime: number | undefined
): "active" | "thinking" | "idle" {
    if (!lastModificationTime) return "idle";

    const now = Date.now();
    const elapsed = now - lastModificationTime;

    if (elapsed < ACTIVE_THRESHOLD) {
        return "active";
    }
    if (elapsed < THINKING_THRESHOLD) {
        return "thinking";
    }
    return "idle";
}

/**
 * Performs find best session for agent.
 * @param agentId Agent identifier.
 * @param sessions Sessions value.
 * @returns Find best session for agent result.
 */
function findBestSessionForAgent(
    agentId: string,
    sessions: GatewaySessionSummary[]
): GatewaySessionSummary | undefined {
    const prefix = `agent:${agentId.toLowerCase()}:`;
    const matches = sessions.filter((session) =>
        session.key.toLowerCase().startsWith(prefix)
    );

    if (matches.length === 0) {
        return undefined;
    }

    const preferredKinds = [
        ":main",
        ":discord:",
        ":telegram:",
        ":signal:",
        ":whatsapp:",
        ":slack:",
        ":imessage:",
        ":line:",
        ":irc:",
        ":googlechat:",
        ":channel:",
    ];

    return matches.toSorted((a, b) => {
        const timeA = boundedTimestamp(a.updatedAt) || 0;
        const timeB = boundedTimestamp(b.updatedAt) || 0;
        const keyA = a.key.toLowerCase();
        const keyB = b.key.toLowerCase();
        const preferredA = Number(preferredKinds.some((part) => keyA.includes(part)));
        const preferredB = Number(preferredKinds.some((part) => keyB.includes(part)));

        if (preferredA !== preferredB) {
            return preferredB - preferredA;
        }

        return timeB - timeA;
    })[0];
}

/**
 * Finds a Gateway session by key using OpenClaw's case-insensitive session-key semantics.
 * @param sessions Sessions value.
 * @param sessionKey Session key value.
 * @returns Located a Gateway session by key using OpenClaw's case-insensitive session-key semantics.
 */
function findSessionByKey(
    sessions: GatewaySessionSummary[],
    sessionKey: string
): GatewaySessionSummary | undefined {
    const normalizedKey = sessionKey.toLowerCase();
    return sessions.find((session) => session.key.toLowerCase() === normalizedKey);
}

/**
 * Returns whether Gateway reports a session as currently running.
 * @param session Session to process.
 * @returns Whether Gateway reports a session as currently running.
 */
function isGatewaySessionRunning(session: GatewaySessionSummary | undefined): boolean {
    if (!session || boundedTimestamp(session.endedAt) !== undefined) {
        return false;
    }

    return (
        session.running === true ||
        session.isRunning === true ||
        session.status === "running" ||
        Boolean(session.activeRunId || session.currentRunId)
    );
}

/** Applies live Gateway session state to a dashboard agent status. */
function applyGatewaySessionStatus(
    status: AgentStatus,
    session: GatewaySessionSummary | undefined
): void {
    if (!session) {
        return;
    }
    status.sessionKey ||= session.key;
    status.channel = getChannelFromSessionKey(session.key);

    const updatedAt = boundedTimestamp(session.updatedAt);
    if (
        updatedAt !== undefined &&
        (!status.lastActivity || updatedAt > Date.parse(status.lastActivity))
    ) {
        status.lastActivity = timestampToIso(updatedAt);
    }

    if (isGatewaySessionRunning(session)) {
        status.status = status.currentActivity ? "active" : "thinking";
    }
}

/**
 * Builds one dashboard agent status by combining config, metadata, sessions, and activity hints.
 * @param agentId Agent identifier.
 * @returns Built one dashboard agent status by combining config, metadata, sessions, and activity hints.
 */
async function getAgentStatus(agentId: string): Promise<AgentStatus> {
    // Current task priority: active history task -> metadata -> inferred activity
    const activeTask = getActiveHistoryTask(agentId);
    const metadata = await getAgentMetadata(agentId);

    // Get sessions from agent's sessions.json file
    const fileSessions = await getAgentSessionsFromFiles(agentId);

    // Find most recent session
    let latestSession: SessionInfo | undefined;
    let latestTime = 0;

    for (const session of fileSessions) {
        const sessionTime = session.updatedAt || 0;
        if (sessionTime > latestTime) {
            latestTime = sessionTime;
            latestSession = session;
        }
    }

    // Get activity from JSONL file
    const activity = await getLatestActivityFromFile(agentId);

    // Determine status from file modification time
    const fileModificationTime =
        activity?.modTime || getSessionFileModificationTime(agentId);
    const status = determineStatus(fileModificationTime);

    const sessionKey = latestSession?.key || undefined;
    const channel = sessionKey ? getChannelFromSessionKey(sessionKey) : undefined;
    const effectiveModificationTime = fileModificationTime || 0;

    const currentTask =
        activeTask?.task || metadata?.currentTask || activity?.task || undefined;

    return {
        id: agentId,
        status,
        model: "unknown", // Will be filled from config
        currentTask,
        currentActivity: activity?.activity || undefined,
        lastActivity:
            effectiveModificationTime > 0
                ? timestampToIso(effectiveModificationTime)
                : undefined,
        sessionKey,
        channel,
    };
}

/**
 * Builds all dashboard agent statuses for a parsed agent config.
 * @returns Built all dashboard agent statuses for a parsed agent config.
 */
export async function buildAgentStatuses(config: AgentsConfig): Promise<AgentStatus[]> {
    const defaultModel = config.defaults?.model?.primary || "unknown";
    const sessions = await getGatewaySessionsForAgents();

    return Promise.all(
        config.list.map(async (agent) => {
            const status = await getAgentStatus(agent.id);
            const configuredModel = resolveConfiguredModelName(
                agent.model?.primary || defaultModel,
                config
            );
            const sessionFromKey = status.sessionKey
                ? findSessionByKey(sessions, status.sessionKey)
                : undefined;
            const matchingSession =
                sessionFromKey || findBestSessionForAgent(agent.id, sessions);
            if (!sessionFromKey && matchingSession) {
                status.sessionKey = matchingSession.key;
            }
            applyGatewaySessionStatus(status, matchingSession);
            const rawSessionModel = normalizeGatewaySessionModel(matchingSession?.model);
            const sessionModel = rawSessionModel
                ? toDisplayModelName(rawSessionModel)
                : undefined;
            status.model =
                sessionModel && sessionModel !== configuredModel
                    ? sessionModel
                    : configuredModel;
            return status;
        })
    );
}

/**
 * Builds one dashboard agent status when the id exists in config.
 * @param agentId Agent identifier.
 * @param config Config value.
 * @returns Built one dashboard agent status when the id exists in config.
 */
export async function buildSingleAgentStatus(
    agentId: string,
    config: AgentsConfig
): Promise<AgentStatus | undefined> {
    const agentConfig = config.list.find((agent) => agent.id === agentId);
    if (!agentConfig) {
        return undefined;
    }

    const status = await getAgentStatus(agentId);
    const sessions = await getGatewaySessionsForAgents();
    const configuredModel = resolveConfiguredModelName(
        agentConfig.model?.primary || config.defaults?.model?.primary,
        config
    );
    const sessionFromKey = status.sessionKey
        ? findSessionByKey(sessions, status.sessionKey)
        : undefined;
    const matchingSession = sessionFromKey || findBestSessionForAgent(agentId, sessions);
    if (!sessionFromKey && matchingSession) {
        status.sessionKey = matchingSession.key;
    }
    applyGatewaySessionStatus(status, matchingSession);
    const rawSessionModel = normalizeGatewaySessionModel(matchingSession?.model);
    const sessionModel = rawSessionModel
        ? toDisplayModelName(rawSessionModel)
        : undefined;
    status.model =
        sessionModel && sessionModel !== configuredModel ? sessionModel : configuredModel;

    return status;
}

function normalizeGatewaySessionModel(model: string | undefined): string | undefined {
    if (!model || model.toLowerCase() === "unknown") {
        return undefined;
    }
    return model;
}

export async function updateAgentCurrentTask(
    agentId: string,
    currentTask: unknown
): Promise<AgentMetadata> {
    if (!isValidAgentId(agentId)) {
        throw Object.assign(new Error("Invalid agent ID"), { statusCode: 400 });
    }
    if (typeof currentTask !== "string" || currentTask.trim().length === 0) {
        throw Object.assign(new Error("Provide currentTask"), { statusCode: 400 });
    }

    const metadataPath = safePathWithinRoot(
        Path.join(agentId, "sessions", "metadata.json"),
        getAgentsDirectory()
    );
    if (!metadataPath) {
        throw Object.assign(new Error("Invalid agent ID"), { statusCode: 400 });
    }
    const metadataDirectory = Path.dirname(metadataPath);
    const realAgentsDirectory = ensureRealAgentsDirectory();
    if (!realAgentsDirectory) {
        throw Object.assign(new Error("Invalid agent metadata path"), {
            statusCode: 400,
        });
    }

    const agentsDirectory = getAgentsDirectory();
    const expectedSessionsDirectory = Path.join(agentsDirectory, agentId, "sessions");
    const canonicalExpectedSessionsDirectory = Path.join(
        realAgentsDirectory,
        agentId,
        "sessions"
    );
    const safeSessionsDirectory = prepareAgentMetadataDirectoryForWrite(
        expectedSessionsDirectory,
        agentsDirectory
    );
    if (safeSessionsDirectory !== canonicalExpectedSessionsDirectory) {
        throw Object.assign(new Error("Invalid agent metadata path"), {
            statusCode: 400,
        });
    }

    const expectedSessionsParent = Path.dirname(safeSessionsDirectory);
    let realExpectedSessionsParent: string;
    try {
        mkdirChildDirectoryFromVerifiedParent(realAgentsDirectory, agentId);
        realExpectedSessionsParent = FS.realpathSync(expectedSessionsParent);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTSUP") {
            realExpectedSessionsParent = realExistingChildDirectoryFromVerifiedParent(
                realAgentsDirectory,
                agentId
            );
        } else {
            throw error;
        }
    }
    if (
        realExpectedSessionsParent !== Path.dirname(canonicalExpectedSessionsDirectory) ||
        !FS.statSync(realExpectedSessionsParent).isDirectory()
    ) {
        throw Object.assign(new Error("Invalid agent metadata path"), {
            statusCode: 400,
        });
    }

    let realExpectedSessionsDirectory: string;
    try {
        mkdirChildDirectoryFromVerifiedParent(realExpectedSessionsParent, "sessions");
        realExpectedSessionsDirectory = FS.realpathSync(expectedSessionsDirectory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTSUP") {
            realExpectedSessionsDirectory = realExistingChildDirectoryFromVerifiedParent(
                realExpectedSessionsParent,
                "sessions"
            );
        } else {
            throw error;
        }
    }

    const realMetadataDirectory = FS.realpathSync(metadataDirectory);
    if (
        realMetadataDirectory !== realExpectedSessionsDirectory ||
        realExpectedSessionsDirectory !== canonicalExpectedSessionsDirectory ||
        !FS.statSync(realExpectedSessionsDirectory).isDirectory() ||
        !FS.statSync(realMetadataDirectory).isDirectory()
    ) {
        throw Object.assign(new Error("Invalid agent metadata path"), {
            statusCode: 400,
        });
    }

    const { metadata, safeTask, ts } = await updateAgentMetadataFromVerifiedDirectory({
        agentId,
        currentTask,
        realExpectedSessionsDirectory,
        realMetadataDirectory,
    });

    try {
        if (safeTask && safeTask.length > 0) {
            database.run("BEGIN IMMEDIATE");
            const currentActive = getActiveHistoryTask(agentId);
            if (!currentActive) {
                database
                    .prepare(
                        `INSERT INTO agent_task_history (agent_id, task, status, started_at, last_activity_at)
                         VALUES (?, ?, 'active', ?, ?)`
                    )
                    .run(agentId, safeTask, ts, ts);
            } else if (currentActive.task === safeTask) {
                database
                    .prepare(
                        `UPDATE agent_task_history SET last_activity_at = ? WHERE id = ?`
                    )
                    .run(ts, currentActive.id);
            } else {
                database
                    .prepare(
                        `UPDATE agent_task_history
                         SET status = 'completed', completed_at = ?, last_activity_at = ?
                         WHERE id = ?`
                    )
                    .run(ts, ts, currentActive.id);

                database
                    .prepare(
                        `INSERT INTO agent_task_history (agent_id, task, status, started_at, last_activity_at)
                         VALUES (?, ?, 'active', ?, ?)`
                    )
                    .run(agentId, safeTask, ts, ts);
            }
            database.run("COMMIT");
        }
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            logger.error("agents.task_history_sync_rollback_failed", {
                error: rollbackError,
            });
        }
        logger.error("agents.task_history_sync_failed", { error });
    }

    return metadata;
}
