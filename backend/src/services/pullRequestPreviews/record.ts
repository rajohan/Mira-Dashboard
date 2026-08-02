import {
    chmodSync,
    closeSync,
    constants,
    fstatSync,
    openSync,
    readSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { ensureRealDirectory } from "./fileSystem.ts";
import type { PullRequestPreviewConfig, PullRequestPreviewRecord } from "./types.ts";
import { PREVIEW_RECORD_FORMAT_VERSION } from "./types.ts";

const logger = createStructuredLogger("pull-request-preview-host");
const PREVIEW_RECORD_FILE = "active-preview.json";
const MAX_PREVIEW_RECORD_BYTES = 256 * 1024;
const COMMIT_PATTERN = /^[\da-f]{40}$/u;

function previewRecordFromJson(value: unknown): PullRequestPreviewRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("Preview record must be an object");
    }
    const record = value as Partial<PullRequestPreviewRecord>;
    if (
        record.formatVersion !== PREVIEW_RECORD_FORMAT_VERSION ||
        typeof record.number !== "number" ||
        !Number.isSafeInteger(record.number) ||
        record.number <= 0 ||
        typeof record.commitSha !== "string" ||
        !COMMIT_PATTERN.test(record.commitSha) ||
        typeof record.title !== "string" ||
        typeof record.updatedAt !== "string" ||
        typeof record.url !== "string" ||
        typeof record.worktreePath !== "string" ||
        !["failed", "running", "starting", "stopped", "stopping"].includes(
            record.status || ""
        ) ||
        (record.ownsTailscaleServe !== undefined &&
            typeof record.ownsTailscaleServe !== "boolean") ||
        typeof record.frontendPort !== "number" ||
        typeof record.backendPort !== "number"
    ) {
        throw new TypeError("Preview record is invalid");
    }
    return {
        ...record,
        ownsTailscaleServe: record.ownsTailscaleServe === true,
    } as PullRequestPreviewRecord;
}

export function readPreviewRecord(
    config: PullRequestPreviewConfig
): PullRequestPreviewRecord | undefined {
    let descriptor: number;
    try {
        descriptor = openSync(
            config.stateFile,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("Dashboard preview state must be a readable real regular file", {
            cause: error,
        });
    }

    let content: string;
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile()) {
            throw new Error(
                "Dashboard preview state must be a readable real regular file"
            );
        }
        if (stat.size > MAX_PREVIEW_RECORD_BYTES) {
            throw new Error("Dashboard preview state is too large");
        }
        const buffer = Buffer.allocUnsafe(MAX_PREVIEW_RECORD_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const chunkLength = readSync(
                descriptor,
                buffer,
                bytesRead,
                buffer.length - bytesRead,
                bytesRead
            );
            if (chunkLength === 0) break;
            bytesRead += chunkLength;
        }
        if (bytesRead > MAX_PREVIEW_RECORD_BYTES) {
            throw new Error("Dashboard preview state is too large");
        }
        content = buffer.toString("utf8", 0, bytesRead);
    } finally {
        closeSync(descriptor);
    }

    try {
        return previewRecordFromJson(JSON.parse(content) as unknown);
    } catch (error) {
        const quarantinePath = path.join(
            config.previewRoot,
            `active-preview.corrupt-${Date.now()}-${Bun.randomUUIDv7()}.json`
        );
        try {
            renameSync(config.stateFile, quarantinePath);
            chmodSync(quarantinePath, 0o600);
            logger.error("preview.invalid_state_quarantined", {
                error,
                quarantinePath,
            });
        } catch (quarantineError) {
            logger.error("preview.invalid_state_quarantine_failed", {
                error,
                quarantineError,
            });
        }
        return undefined;
    }
}

export function writePreviewRecord(
    config: PullRequestPreviewConfig,
    record: PullRequestPreviewRecord
): void {
    ensureRealDirectory(config.previewRoot);
    const temporaryPath = path.join(
        config.previewRoot,
        `.${PREVIEW_RECORD_FILE}.${Bun.randomUUIDv7()}.tmp`
    );
    try {
        writeFileSync(temporaryPath, `${JSON.stringify(record, undefined, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        renameSync(temporaryPath, config.stateFile);
        chmodSync(config.stateFile, 0o600);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}
