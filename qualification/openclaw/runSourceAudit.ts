import path from "node:path";

import {
    assertOpenClawAuditMatchesReviewed,
    loadReviewedOpenClawFixtures,
    writeOpenClawAuditCandidate,
} from "./reviewedFixtures.ts";
import { auditInstalledOpenClaw } from "./sourceAudit.ts";

type SourceAuditCliArguments =
    | { mode: "check"; sourceRoot: string }
    | { mode: "write"; outputDirectory: string; sourceRoot: string };

const usage =
    "Usage: runSourceAudit.ts --source-root=/absolute/openclaw/package (--check-reviewed | --output=/absolute/candidate/<version>)";

function readAbsolutePathOption(argument: string | undefined, prefix: string): string {
    const value = argument?.startsWith(prefix) ? argument.slice(prefix.length) : "";
    if (!value || value.includes("\0") || !path.isAbsolute(value)) {
        throw new TypeError(usage);
    }
    return path.resolve(value);
}

/**
 * Parses the deliberately explicit host-audit CLI interface.
 * @param arguments_ Arguments after the Bun entrypoint.
 * @returns One explicit check or candidate-write operation.
 */
export function parseSourceAuditCliArguments(
    arguments_: readonly string[]
): SourceAuditCliArguments {
    if (arguments_.length !== 2) throw new TypeError(usage);
    const sourceRootArguments = arguments_.filter((argument) =>
        argument.startsWith("--source-root=")
    );
    if (sourceRootArguments.length !== 1) throw new TypeError(usage);
    const sourceRootArgument = sourceRootArguments[0];
    const sourceRoot = readAbsolutePathOption(sourceRootArgument, "--source-root=");
    const operation = arguments_.find((argument) => argument !== sourceRootArgument);
    if (operation === "--check-reviewed") {
        return { mode: "check", sourceRoot };
    }
    if (operation?.startsWith("--output=")) {
        return {
            mode: "write",
            outputDirectory: readAbsolutePathOption(operation, "--output="),
            sourceRoot,
        };
    }
    throw new TypeError(usage);
}

/**
 * Runs an explicit host audit and emits only redacted protocol metadata.
 * @param arguments_ Arguments after the Bun entrypoint.
 * @returns Redacted status metadata safe for standard output.
 */
export async function runSourceAuditCli(arguments_: readonly string[]): Promise<unknown> {
    const options = parseSourceAuditCliArguments(arguments_);
    const observed = await auditInstalledOpenClaw(options.sourceRoot);
    if (options.mode === "check") {
        const reviewed = await loadReviewedOpenClawFixtures();
        assertOpenClawAuditMatchesReviewed(observed, reviewed.audit);
        return {
            artifactCount: observed.sourceArtifacts.length,
            protocolVersion: observed.source.protocolVersion,
            status: "MATCH",
            version: observed.source.version,
        };
    }
    await writeOpenClawAuditCandidate(observed, options.outputDirectory);
    return {
        artifactCount: observed.sourceArtifacts.length,
        protocolVersion: observed.source.protocolVersion,
        status: "CANDIDATE_WRITTEN",
        version: observed.source.version,
    };
}

if (import.meta.main) {
    try {
        const result = await runSourceAuditCli(Bun.argv.slice(2));
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "OpenClaw source audit failed";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
