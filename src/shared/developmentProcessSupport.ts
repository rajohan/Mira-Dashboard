import { hasNoUnicodeControlOrFormat } from "./validation.ts";

const sourceCommitPattern = /^[\da-f]{40}$/u;
const startupFailureDetailMaximumLength = 512;

export type DevelopmentProcessRole = "web" | "worker";

/**
 * Parses the exact source identity passed from the development coordinator.
 * @param arguments_ Process arguments containing one lowercase Git commit.
 * @param processRole Development process used in validation diagnostics.
 * @returns The validated 40-character source commit.
 */
export function parseDevelopmentSourceCommit(
    arguments_: readonly string[],
    processRole: DevelopmentProcessRole
): string {
    const [commit] = arguments_;
    if (
        arguments_.length !== 1 ||
        commit === undefined ||
        !sourceCommitPattern.test(commit)
    ) {
        throw new TypeError(
            `Development ${processRole} requires one exact source commit`
        );
    }
    return commit;
}

function safeStartupFailureDetail(error: unknown): string | undefined {
    if (!Error.isError(error)) return;
    let message: string;
    try {
        message = error.message.trim();
    } catch {
        return;
    }
    if (
        message === "" ||
        message.length > startupFailureDetailMaximumLength ||
        !hasNoUnicodeControlOrFormat(message)
    ) {
        return;
    }
    return message;
}

/**
 * Formats one bounded, single-line startup failure without exposing stacks or unknown values.
 * @param processRole Development process that failed to start.
 * @param error Unknown startup failure.
 * @returns A stable summary with a safe error message when one is available.
 */
export function developmentStartupFailureMessage(
    processRole: DevelopmentProcessRole,
    error: unknown
): string {
    const summary = `Mira Dashboard development ${processRole} startup failed`;
    const detail = safeStartupFailureDetail(error);
    return detail === undefined ? summary : `${summary}: ${detail}`;
}
