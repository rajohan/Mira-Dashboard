import { once } from "node:events";
import path from "node:path";
import type { Writable } from "node:stream";

import { TestOutputInspector, type TestOutputViolation } from "./testOutputPolicy.ts";

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
 * Runs one Bun test process and enforces the repository test-output policy.
 * @param arguments_ Arguments passed after `bun test`.
 * @param projectRoot Repository root used as the child working directory.
 * @returns The child failure code, or one when a passing child emitted forbidden output.
 */
export async function runTestSuite(
    arguments_: readonly string[],
    projectRoot = path.resolve(import.meta.dir, "..")
): Promise<number> {
    const child = Bun.spawn([process.execPath, "test", ...arguments_], {
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
    return violation === undefined ? 0 : 1;
}

if (import.meta.main) {
    process.exitCode = await runTestSuite(process.argv.slice(2));
}
