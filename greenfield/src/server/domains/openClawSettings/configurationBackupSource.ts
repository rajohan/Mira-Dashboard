import { openClawConfigurationUpstreamMaximumBytes } from "../../../contracts/openClawSettings.ts";
import { WorkspaceFileError } from "../files/errors.ts";
import type { WorkspaceFileReader } from "../files/ports.ts";
import {
    OpenClawConfigurationBackupError,
    openClawConfigurationBackupFileName,
    openClawConfigurationBackupLocator,
    openClawConfigurationBackupMimeType,
    type OpenClawConfigurationBackupSource,
} from "./configurationBackup.ts";

function sameLocator(
    left: Readonly<{ readonly rootId: string; readonly segments: readonly string[] }>,
    right: Readonly<{ readonly rootId: string; readonly segments: readonly string[] }>
): boolean {
    return (
        left.rootId === right.rootId &&
        left.segments.length === right.segments.length &&
        left.segments.every((segment, index) => segment === right.segments[index])
    );
}

function sourceFailure(error: unknown, signal?: AbortSignal): never {
    if (signal?.aborted === true) {
        throw (
            signal.reason ??
            new DOMException("OpenClaw configuration export was aborted", "AbortError")
        );
    }
    throw new OpenClawConfigurationBackupError(
        error instanceof WorkspaceFileError && error.reason === "too-large"
            ? "invalid-source"
            : "unavailable"
    );
}

/**
 * Adapts the reviewed descriptor reader to the one exact secret-bearing config source.
 * Redacted, truncated, changed, empty, or oversized representations fail closed.
 * Reader-owned bytes are erased after validation; each successful read returns a caller-owned copy.
 * @returns The exact descriptor-rooted configuration source.
 */
export function createWorkspaceFileOpenClawConfigurationBackupSource(
    reader: WorkspaceFileReader
): OpenClawConfigurationBackupSource {
    return Object.freeze({
        async read(signal?: AbortSignal): Promise<Uint8Array> {
            signal?.throwIfAborted();
            try {
                const node = await reader.describe(
                    openClawConfigurationBackupLocator,
                    signal,
                    "reveal-secrets"
                );
                if (
                    node.kind !== "file" ||
                    node.name !== openClawConfigurationBackupFileName ||
                    !sameLocator(node.locator, openClawConfigurationBackupLocator) ||
                    node.mimeType !== openClawConfigurationBackupMimeType ||
                    node.requiresSecretReveal !== true ||
                    node.sizeBytes === undefined ||
                    node.sizeBytes < 1 ||
                    node.sizeBytes > openClawConfigurationUpstreamMaximumBytes ||
                    node.sourceSizeBytes !== undefined ||
                    node.truncated === true
                ) {
                    throw new OpenClawConfigurationBackupError("invalid-source");
                }
                signal?.throwIfAborted();
                const result = await reader.read(
                    openClawConfigurationBackupLocator,
                    node.revision,
                    undefined,
                    signal,
                    "reveal-secrets"
                );
                try {
                    if (
                        result.fileName !== openClawConfigurationBackupFileName ||
                        result.mimeType !== openClawConfigurationBackupMimeType ||
                        result.revision !== node.revision ||
                        result.sizeBytes !== node.sizeBytes ||
                        result.bytes.byteLength !== node.sizeBytes ||
                        result.bytes.byteLength < 1 ||
                        result.bytes.byteLength >
                            openClawConfigurationUpstreamMaximumBytes ||
                        result.sourceSizeBytes !== undefined ||
                        result.truncated === true
                    ) {
                        throw new OpenClawConfigurationBackupError("invalid-source");
                    }
                    signal?.throwIfAborted();
                    return Uint8Array.from(result.bytes);
                } finally {
                    result.bytes.fill(0);
                }
            } catch (error) {
                if (error instanceof OpenClawConfigurationBackupError) throw error;
                return sourceFailure(error, signal);
            }
        },
    });
}
