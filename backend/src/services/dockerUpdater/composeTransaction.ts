import fs from "node:fs";
import path from "node:path";

import { YAML } from "bun";

import { runProcess } from "../../lib/processes.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { dirtyDockerUpdaterPaths } from "../gitHygiene.ts";
import {
    composeCommandPath,
    composeFileServiceImageField,
    getComposeCommand,
    getComposeCommandPaths,
    managedComposePath,
} from "./composeProject.ts";
import { serviceLabel } from "./support.ts";
import type { JsonRecord, ManagedServiceRow } from "./types.ts";

const logger = createStructuredLogger("docker-updater");
const composeUpdateLocks = new Map<string, { promise: Promise<void> }>();

function setNestedValue(target: JsonRecord, dottedPath: string, value: string) {
    const rawParts = dottedPath.split(".");
    const parts =
        rawParts[0] === "services" && rawParts.at(-1) === "image" && rawParts.length > 3
            ? ["services", rawParts.slice(1, -1).join("."), "image"]
            : rawParts;
    const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
    for (const part of parts) {
        if (unsafeKeys.has(part)) {
            throw new Error(`Unsafe compose image field segment: ${part}`);
        }
    }
    let current = target;
    const parentParts = parts.slice(0, -1);
    for (const part of parentParts) {
        if (!Object.hasOwn(current, part)) {
            throw new Error(`Compose image field path does not exist: ${dottedPath}`);
        }
        const next = current[part];
        if (
            !next ||
            typeof next !== "object" ||
            Object.getPrototypeOf(next) !== Object.prototype
        ) {
            throw new Error(`Compose image field path is not an object: ${dottedPath}`);
        }
        current = next as JsonRecord;
    }
    const lastPart = parts.at(-1) as string;
    if (!Object.hasOwn(current, lastPart)) {
        throw new Error(`Compose image field path does not exist: ${dottedPath}`);
    }
    current[lastPart] = value;
}

function composeImageFieldServiceName(dottedPath: string): string | undefined {
    const rawParts = dottedPath.split(".");
    if (rawParts[0] !== "services" || rawParts.at(-1) !== "image") {
        return undefined;
    }
    if (rawParts.length < 3) {
        return undefined;
    }
    return rawParts.slice(1, -1).join(".");
}

function escapeRegExp(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function leadingWhitespaceLength(value: string): number {
    return value.match(/^\s*/)?.[0].length ?? 0;
}

function isBlankOrCommentLine(value: string): boolean {
    const trimmed = value.trim();
    return trimmed === "" || trimmed.startsWith("#");
}

function firstChildIndent(lines: string[], startIndex: number, parentIndent: number) {
    let childIndent: number | undefined;
    for (let index = startIndex; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || isBlankOrCommentLine(line)) continue;
        const indent = leadingWhitespaceLength(line);
        if (indent <= parentIndent) break;
        childIndent = indent;
        break;
    }
    return childIndent;
}

function isComplexYamlScalar(value: string): boolean {
    const trimmed = value.trimStart();
    return (
        trimmed.startsWith(">") ||
        trimmed.startsWith("|") ||
        trimmed.startsWith("&") ||
        trimmed.startsWith("!")
    );
}

function updateComposeImageLine(
    raw: string,
    composeImageField: string,
    targetImageReference: string
): string | undefined {
    const serviceName = composeImageFieldServiceName(composeImageField);
    if (!serviceName) return undefined;

    const lineEnding = raw.includes("\r\n") ? "\r\n" : "\n";
    const hasTrailingLineEnding = raw.endsWith("\n");
    const lines = raw.split(/\r?\n/);
    if (hasTrailingLineEnding) lines.pop();

    const servicesLineIndex = lines.findIndex((line) =>
        /^services\s*:\s*(?:#.*)?$/.test(line)
    );
    if (servicesLineIndex === -1) return undefined;

    const servicesLine = lines[servicesLineIndex];
    if (servicesLine === undefined) return undefined;
    const servicesIndent = leadingWhitespaceLength(servicesLine);
    const serviceChildIndent = firstChildIndent(
        lines,
        servicesLineIndex + 1,
        servicesIndent
    );
    if (serviceChildIndent === undefined) return undefined;
    const escapedServiceName = escapeRegExp(serviceName);
    const serviceLinePattern = new RegExp(
        String.raw`^(\s*)(?:"${escapedServiceName}"|'${escapedServiceName}'|${escapedServiceName})\s*:\s*(?:#.*)?$`
    );
    let serviceLineIndex = -1;
    let serviceIndent = -1;
    for (let index = servicesLineIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        if (isBlankOrCommentLine(line)) continue;
        const indent = leadingWhitespaceLength(line);
        if (indent <= servicesIndent) break;
        if (indent !== serviceChildIndent) continue;
        const match = line.match(serviceLinePattern);
        if (!match) continue;
        serviceLineIndex = index;
        serviceIndent = match[1]?.length ?? 0;
        break;
    }
    if (serviceLineIndex === -1) return undefined;
    const servicePropertyIndent = firstChildIndent(
        lines,
        serviceLineIndex + 1,
        serviceIndent
    );
    if (servicePropertyIndent === undefined) return undefined;

    for (let index = serviceLineIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        if (isBlankOrCommentLine(line)) continue;
        const indent = leadingWhitespaceLength(line);
        if (indent <= serviceIndent) break;
        if (indent !== servicePropertyIndent) continue;
        const match = line.match(
            /^(\s*image\s*:\s*)(?:(['"])(.*?)\2|([^#]*?))(\s*(?:#.*)?)$/
        );
        if (!match) continue;
        const prefix = match[1];
        const quote = match[2] ?? "";
        const unquotedValue = match[4] ?? "";
        if (!quote && isComplexYamlScalar(unquotedValue)) {
            return undefined;
        }
        const suffix = match[5] ?? "";
        const nextValue = quote
            ? `${quote}${targetImageReference}${quote}`
            : targetImageReference;
        lines[index] = `${prefix}${nextValue}${suffix}`;
        return `${lines.join(lineEnding)}${hasTrailingLineEnding ? lineEnding : ""}`;
    }

    return undefined;
}

function serializeComposeUpdate(
    raw: string,
    document: JsonRecord,
    composeImageField: string,
    targetImageReference: string
): string {
    return (
        updateComposeImageLine(raw, composeImageField, targetImageReference) ??
        YAML.stringify(document)
    );
}

function writeFileWithMetadata(
    targetPath: string,
    content: string,
    stats: Pick<fs.Stats, "mode" | "uid" | "gid">
) {
    const mode = stats.mode & 0o7777;
    const fd = fs.openSync(
        targetPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        mode
    );
    let isCommitted = false;
    try {
        fs.writeFileSync(fd, content, "utf8");
        fs.fchmodSync(fd, mode);
        const currentStats = fs.fstatSync(fd);
        if (currentStats.uid !== stats.uid || currentStats.gid !== stats.gid) {
            try {
                fs.fchownSync(fd, stats.uid, stats.gid);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EPERM") {
                    throw error;
                }
            }
        }
        fs.fsyncSync(fd);
        isCommitted = true;
    } finally {
        fs.closeSync(fd);
        if (!isCommitted) {
            try {
                fs.unlinkSync(targetPath);
            } catch {
                // Preserve the original write failure.
            }
        }
    }
}

function composeUpdateLockKey(service: ManagedServiceRow): string {
    return composeCommandPath(service.compose_path);
}

export async function withComposeUpdateLock<T>(
    service: ManagedServiceRow,
    action: () => Promise<T>,
    signal?: AbortSignal
): Promise<T> {
    const key = composeUpdateLockKey(service);
    const wasPrevious = composeUpdateLocks.get(key)?.promise ?? Promise.resolve();
    const current = Promise.withResolvers<void>();
    const release = current.resolve;
    async function waitForCurrent(): Promise<void> {
        await wasPrevious;
        await current.promise;
    }
    const next = { promise: waitForCurrent() };
    composeUpdateLocks.set(key, next);
    try {
        if (signal) {
            signal.throwIfAborted();
            const aborted = Promise.withResolvers<never>();
            const abort = () => aborted.reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            try {
                await Promise.race([wasPrevious, aborted.promise]);
            } finally {
                signal.removeEventListener("abort", abort);
            }
            signal.throwIfAborted();
        } else {
            await wasPrevious;
        }
        return await action();
    } finally {
        release();
        if (composeUpdateLocks.get(key) === next) {
            composeUpdateLocks.delete(key);
        }
    }
}

export async function applyComposeUpdateUnlocked(
    service: ManagedServiceRow,
    targetImageReference: string,
    signal?: AbortSignal
) {
    signal?.throwIfAborted();
    if (!service.compose_image_field) {
        throw new Error(
            `Service ${serviceLabel(service)} is missing compose image field`
        );
    }
    const composeImageField = service.compose_image_field;
    const configuredComposePath = service.compose_path;
    const composePath = managedComposePath(configuredComposePath);
    const commandComposePaths = getComposeCommandPaths(configuredComposePath).map(
        (commandComposePath) => managedComposePath(commandComposePath)
    );
    const dirtyBefore = await dirtyDockerUpdaterPaths(
        [composePath, ...commandComposePaths],
        signal
    );
    signal?.throwIfAborted();
    const raw = fs.readFileSync(composePath, "utf8");
    const originalStats = fs.statSync(composePath);
    const document = YAML.parse(raw) as JsonRecord;
    setNestedValue(document, composeImageField, targetImageReference);
    let isComposeStarted = false;
    const commandRollbacks: Array<{
        composePath: string;
        rollbackTempPath: string;
        tempPath: string;
    }> = [];
    const temporaryPath = path.join(
        path.dirname(composePath),
        `${path.basename(composePath)}.tmp-${Bun.randomUUIDv7()}`
    );
    const rollbackTemporaryPath = path.join(
        path.dirname(composePath),
        `${path.basename(composePath)}.rollback-${Bun.randomUUIDv7()}`
    );
    try {
        writeFileWithMetadata(rollbackTemporaryPath, raw, originalStats);
        writeFileWithMetadata(
            temporaryPath,
            serializeComposeUpdate(
                raw,
                document,
                composeImageField,
                targetImageReference
            ),
            originalStats
        );
        fs.renameSync(temporaryPath, composePath);
        for (const commandComposePath of commandComposePaths) {
            const realCommandComposePath = managedComposePath(commandComposePath);
            if (realCommandComposePath === composePath) continue;
            const commandImageField = composeFileServiceImageField(
                realCommandComposePath,
                service.service_name
            );
            if (!commandImageField) continue;
            const commandRaw = fs.readFileSync(realCommandComposePath, "utf8");
            const commandStats = fs.statSync(realCommandComposePath);
            const commandDocument = YAML.parse(commandRaw) as JsonRecord;
            setNestedValue(commandDocument, commandImageField, targetImageReference);
            const commandTemporaryPath = path.join(
                path.dirname(realCommandComposePath),
                `${path.basename(realCommandComposePath)}.tmp-${Bun.randomUUIDv7()}`
            );
            const commandRollbackTemporaryPath = path.join(
                path.dirname(realCommandComposePath),
                `${path.basename(realCommandComposePath)}.rollback-${Bun.randomUUIDv7()}`
            );
            writeFileWithMetadata(commandRollbackTemporaryPath, commandRaw, commandStats);
            commandRollbacks.push({
                composePath: realCommandComposePath,
                rollbackTempPath: commandRollbackTemporaryPath,
                tempPath: commandTemporaryPath,
            });
            writeFileWithMetadata(
                commandTemporaryPath,
                serializeComposeUpdate(
                    commandRaw,
                    commandDocument,
                    commandImageField,
                    targetImageReference
                ),
                commandStats
            );
            fs.renameSync(commandTemporaryPath, realCommandComposePath);
        }
        const command = getComposeCommand(
            configuredComposePath,
            service.service_name,
            commandComposePaths
        );
        isComposeStarted = true;
        const { code, stderr, stdout } = await runProcess(command.file, command.args, {
            cwd: command.cwd,
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
            signal,
            timeoutMs: 180_000,
        });
        if (code !== 0) {
            throw new Error(
                `${command.file} ${command.args.join(" ")} failed with exit code ${code}: ${
                    stderr.trim() || stdout.trim()
                }`
            );
        }
        try {
            fs.unlinkSync(rollbackTemporaryPath);
        } catch {
            // The rollback file is only a best-effort safety net after success.
        }
        for (const rollback of commandRollbacks) {
            try {
                fs.unlinkSync(rollback.rollbackTempPath);
            } catch {
                // Extra compose rollbacks are best-effort after success too.
            }
        }
        const changedPaths = [
            composePath,
            ...commandRollbacks.map((rollback) => rollback.composePath),
        ];
        return {
            changedPaths: dirtyBefore
                ? changedPaths.filter(
                      (changedPath) => !dirtyBefore.has(path.resolve(changedPath))
                  )
                : [],
            stdout: String(stdout),
            stderr: String(stderr),
        };
    } catch (error) {
        try {
            fs.unlinkSync(temporaryPath);
        } catch {
            // The temp file may have already been atomically moved into place.
        }
        for (const rollback of [...commandRollbacks].toReversed()) {
            try {
                fs.unlinkSync(rollback.tempPath);
            } catch {
                // The temp file may have already been atomically moved into place.
            }
            try {
                if (fs.existsSync(rollback.rollbackTempPath)) {
                    fs.renameSync(rollback.rollbackTempPath, rollback.composePath);
                }
            } catch (rollbackError) {
                logger.error("docker_updater.compose_restore_failed", {
                    composePath: rollback.composePath,
                    rollbackError,
                });
            }
        }
        let isRestored = false;
        try {
            if (fs.existsSync(rollbackTemporaryPath)) {
                fs.renameSync(rollbackTemporaryPath, composePath);
                isRestored = true;
            }
        } catch (rollbackError) {
            logger.error("docker_updater.compose_restore_failed", {
                composePath,
                rollbackError,
            });
        }
        if (isRestored && isComposeStarted) {
            try {
                const command = getComposeCommand(
                    configuredComposePath,
                    service.service_name,
                    commandComposePaths
                );
                const rollbackResult = await runProcess(command.file, command.args, {
                    cwd: command.cwd,
                    env: process.env,
                    maxBuffer: 10 * 1024 * 1024,
                    timeoutMs: 180_000,
                });
                if (rollbackResult.code !== 0) {
                    logger.error("docker_updater.restored_compose_apply_failed", {
                        code: rollbackResult.code,
                        output:
                            rollbackResult.stderr.trim() || rollbackResult.stdout.trim(),
                    });
                }
            } catch (rollbackError) {
                logger.error("docker_updater.restored_compose_apply_failed", {
                    composePath,
                    rollbackError,
                });
            }
        }
        throw error;
    }
}
