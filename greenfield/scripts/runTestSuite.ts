import { once } from "node:events";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import { TestOutputInspector, type TestOutputViolation } from "./testOutputPolicy.ts";

interface TestTimingsInventory {
    readonly files: Readonly<Record<string, number>>;
    readonly version: 1;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function parseTestTimingsInventory(value: unknown): TestTimingsInventory {
    if (!isUnknownRecord(value)) {
        throw new TypeError("Test timings must be an object");
    }
    const { files: rawFiles, version } = value;
    if (version !== 1 || !isUnknownRecord(rawFiles)) {
        throw new TypeError("Test timings must contain version 1 and a file map");
    }

    const files: Record<string, number> = {};
    for (const [filePath, duration] of Object.entries(rawFiles)) {
        if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
            throw new TypeError(`Invalid test timing duration: ${filePath}`);
        }
        files[filePath] = duration;
    }
    return { files, version };
}

/**
 * Removes deleted test paths that Bun intentionally retains while merging timings.
 * @param timingsPath Timing inventory written by Bun.
 * @param projectRoot Root used to resolve repository-relative test paths.
 */
export async function pruneMissingTestTimings(
    timingsPath: string,
    projectRoot: string
): Promise<void> {
    const resolvedTimingsPath = path.resolve(projectRoot, timingsPath);
    const timingsFile = Bun.file(resolvedTimingsPath);
    const rawInventory: unknown = await timingsFile.json();
    const inventory = parseTestTimingsInventory(rawInventory);
    const entriesWithExistence = await Promise.all(
        Object.entries(inventory.files).map(async ([filePath, duration]) => {
            const testFile = Bun.file(path.resolve(projectRoot, filePath));
            return {
                duration,
                exists: await testFile.exists(),
                filePath,
            };
        })
    );
    const retainedEntries = entriesWithExistence.filter((entry) => entry.exists);

    const temporaryPath = `${resolvedTimingsPath}.${process.pid}.tmp`;
    try {
        await writeFile(
            temporaryPath,
            `${JSON.stringify(
                {
                    files: Object.fromEntries(
                        retainedEntries.map(({ duration, filePath }) => [
                            filePath,
                            duration,
                        ])
                    ),
                    version: inventory.version,
                },
                null,
                4
            )}\n`,
            { encoding: "utf8", mode: 0o600 }
        );
        await rename(temporaryPath, resolvedTimingsPath);
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

async function pruneUpdatedTestTimings(
    arguments_: readonly string[],
    projectRoot: string
): Promise<void> {
    if (!arguments_.includes("--update-timings")) return;
    const inlinePath = arguments_
        .find((argument) => argument.startsWith("--timings="))
        ?.slice("--timings=".length);
    const timingsIndex = arguments_.indexOf("--timings");
    const timingsPath =
        inlinePath ?? (timingsIndex === -1 ? undefined : arguments_[timingsIndex + 1]);
    if (timingsPath === undefined || timingsPath.length === 0) {
        throw new TypeError("--update-timings requires a timings file");
    }
    await pruneMissingTestTimings(timingsPath, projectRoot);
}

async function relayOutput(
    stream: ReadableStream<Uint8Array>,
    destination: Writable,
    inspector: TestOutputInspector
): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;

            inspector.inspect(decoder.decode(result.value, { stream: true }));
            if (!destination.write(result.value)) await once(destination, "drain");
        }
        inspector.inspect(decoder.decode());
    } finally {
        reader.releaseLock();
    }
}

function firstViolation(
    stdout: TestOutputInspector,
    stderr: TestOutputInspector
): TestOutputViolation | undefined {
    return stdout.violation ?? stderr.violation;
}

/**
 * Runs one test process and enforces the repository test-output policy.
 * @param command Exact executable and arguments for the child process.
 * @param projectRoot Repository root used as the child working directory.
 * @returns The child failure code, or one when a passing child emitted forbidden output.
 */
export async function runTestProcess(
    command: readonly string[],
    projectRoot: string
): Promise<number> {
    const child = Bun.spawn([...command], {
        cwd: projectRoot,
        stderr: "pipe",
        stdin: "inherit",
        stdout: "pipe",
    });
    const stdoutInspector = new TestOutputInspector();
    const stderrInspector = new TestOutputInspector();

    const [exitCode] = await Promise.all([
        child.exited,
        relayOutput(child.stdout, process.stdout, stdoutInspector),
        relayOutput(child.stderr, process.stderr, stderrInspector),
    ]);
    const violation = firstViolation(stdoutInspector, stderrInspector);
    if (violation !== undefined) {
        process.stderr.write(`Test output policy failed: ${violation.description}.\n`);
    }

    if (exitCode !== 0) return exitCode;
    if (violation !== undefined) return 1;
    return 0;
}

/**
 * Runs one Bun test process and updates its optional scheduling inventory.
 * @param arguments_ Arguments passed after `bun test`.
 * @param projectRoot Repository root used as the child working directory.
 * @returns The child failure code, or one when a passing child emitted forbidden output.
 */
export async function runTestSuite(
    arguments_: readonly string[],
    projectRoot = path.resolve(import.meta.dir, "..")
): Promise<number> {
    const exitCode = await runTestProcess(
        [process.execPath, "test", ...arguments_],
        projectRoot
    );
    if (exitCode !== 0) return exitCode;
    await pruneUpdatedTestTimings(arguments_, projectRoot);
    return 0;
}

if (import.meta.main) {
    process.exitCode = await runTestSuite(process.argv.slice(2));
}
