import { CONFIG_REDACTION_SENTINEL } from "../../../shared/configRedaction.ts";
import { WorkspaceFileError } from "./errors.ts";

const redactionSentinelBytes = new TextEncoder().encode(CONFIG_REDACTION_SENTINEL);

function prefixTable(pattern: Uint8Array): Uint8Array {
    const table = new Uint8Array(pattern.byteLength);
    let matched = 0;
    for (let index = 1; index < pattern.byteLength; index += 1) {
        while (matched > 0 && pattern[index] !== pattern[matched]) {
            matched = table[matched - 1]!;
        }
        if (pattern[index] === pattern[matched]) matched += 1;
        table[index] = matched;
    }
    return table;
}

const redactionSentinelPrefixTable = prefixTable(redactionSentinelBytes);

/**
 * Rejects the masked-config placeholder while preserving streaming backpressure.
 * The matcher carries only a prefix length across chunks and never buffers or logs body
 * content. A stream failure lets the descriptor spool remove its partial artifact.
 * @param body Untrusted upload stream selected by a server-owned manifest ticket.
 * @returns A backpressured stream that fails on the first complete sentinel match.
 */
export function rejectRedactionSentinel(
    body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let matched = 0;
    let released = false;
    let terminal = false;

    const releaseReader = (): void => {
        if (released) return;
        released = true;
        reader.releaseLock();
    };
    const cancelReader = async (reason: unknown): Promise<void> => {
        try {
            await reader.cancel(reason);
        } catch {
            // Preserve the original guard or source failure exposed downstream.
        }
    };

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const result = await reader.read();
                if (terminal) return;
                if (result.done) {
                    terminal = true;
                    controller.close();
                    releaseReader();
                    return;
                }

                const chunk = result.value;
                for (const byte of chunk) {
                    while (matched > 0 && byte !== redactionSentinelBytes[matched]) {
                        matched = redactionSentinelPrefixTable[matched - 1]!;
                    }
                    if (byte === redactionSentinelBytes[matched]) matched += 1;
                    if (matched === redactionSentinelBytes.byteLength) {
                        throw new WorkspaceFileError("invalid-input");
                    }
                }
                controller.enqueue(chunk);
            } catch (error) {
                if (terminal) return;
                terminal = true;
                const cancellation = cancelReader(error);
                releaseReader();
                controller.error(error);
                await cancellation;
            }
        },
        async cancel(reason) {
            if (terminal) return;
            terminal = true;
            try {
                await reader.cancel(reason);
            } finally {
                releaseReader();
            }
        },
    });
}
