import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseSseMemoryQualificationEvidence } from "./sseMemoryEvidence.ts";
import { runSseMemoryScenario } from "./sseMemoryScenario.ts";
import {
    buildSystemdLauncherCommand,
    createSseMemoryUnitName,
    runSystemdQualification,
} from "./systemdLauncher.ts";
import { assertSseMemoryUnitName } from "./unitIdentity.ts";

type QualificationCliArguments =
    | { mode: "child"; resultPath: string; unitName: string }
    | { mode: "parent" };

function requiredExecutable(name: string): string {
    const executable = Bun.which(name);
    if (executable === null) {
        throw new Error(`${name} is required for the SSE memory qualification`);
    }
    return executable;
}

/**
 * Parses the intentionally narrow parent/child qualification interface.
 * @param arguments_ Command-line arguments after the Bun entrypoint.
 * @returns Parent mode or a child result path.
 */
export function parseSseMemoryCliArguments(
    arguments_: readonly string[]
): QualificationCliArguments {
    if (arguments_.length === 0) {
        return { mode: "parent" };
    }
    if (
        arguments_.length === 3 &&
        arguments_[0] === "--child" &&
        arguments_[2]?.startsWith("--unit=")
    ) {
        const resultPath = arguments_[1]?.startsWith("--result=")
            ? arguments_[1].slice("--result=".length)
            : "";
        const unitName = arguments_[2].slice("--unit=".length);
        if (path.isAbsolute(resultPath) && !resultPath.includes("\0")) {
            assertSseMemoryUnitName(unitName);
            return { mode: "child", resultPath, unitName };
        }
    }
    throw new TypeError(
        "Usage: runSseMemoryQualification.ts [--child --result=/absolute/path --unit=mira-dashboard-sse-memory-<uuid>]"
    );
}

async function runChild(resultPath: string, unitName: string): Promise<void> {
    const evidence = await runSseMemoryScenario(unitName);
    const temporaryPath = `${resultPath}.tmp`;
    await Bun.write(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`);
    await rename(temporaryPath, resultPath);
}

async function runParent(): Promise<void> {
    const temporaryDirectory = await mkdtemp(
        path.join(tmpdir(), "mira-dashboard-sse-memory-")
    );
    const resultPath = path.join(temporaryDirectory, "evidence.json");
    try {
        const command = buildSystemdLauncherCommand({
            bunExecutable: process.execPath,
            childEntrypoint: import.meta.path,
            envExecutable: requiredExecutable("env"),
            environment: process.env,
            repositoryRoot: path.resolve(import.meta.dir, "../.."),
            resultPath,
            systemctlExecutable: requiredExecutable("systemctl"),
            systemdRunExecutable: requiredExecutable("systemd-run"),
            unitName: createSseMemoryUnitName(),
        });
        const result = await runSystemdQualification(command);
        if (result.exitCode !== 0) {
            const diagnostic = result.stderr.trim() || result.stdout.trim();
            throw new Error(
                `SSE memory qualification child exited ${result.exitCode}${diagnostic ? `: ${diagnostic}` : ""}`
            );
        }
        const evidence = parseSseMemoryQualificationEvidence(
            await Bun.file(resultPath).text()
        );
        process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
}

async function main(arguments_: readonly string[]): Promise<void> {
    const parsed = parseSseMemoryCliArguments(arguments_);
    if (parsed.mode === "child") {
        await runChild(parsed.resultPath, parsed.unitName);
        return;
    }
    await runParent();
}

if (import.meta.main) {
    try {
        await main(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(
            `${error instanceof Error ? error.message : "SSE memory qualification failed"}\n`
        );
        process.exitCode = 1;
    }
}
