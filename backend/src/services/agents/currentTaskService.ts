import FS from "node:fs";
import Path from "node:path";

import type { AgentMetadata } from "../../../../contracts/agents.ts";
import { database } from "../../database.ts";
import {
    guardedPath,
    readTextNoFollowGuarded,
    writeTextNoFollowGuarded,
} from "../../lib/guardedOps.ts";
import { safePathWithinRoot } from "../../lib/safePath.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    assertOpenedDirectoryMatches,
    ensureRealAgentsDirectory,
    getAgentsDirectory,
    isProcfsAvailable,
    isValidAgentId,
    mkdirChildDirectoryFromVerifiedParent,
    prepareAgentMetadataDirectoryForWrite,
    realExistingChildDirectoryFromVerifiedParent,
} from "./agentPaths.ts";
import { getActiveHistoryTask } from "./agentTaskHistory.ts";

const logger = createStructuredLogger("agents");

function nowIso(): string {
    const now = new Date();
    return now.toISOString();
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
