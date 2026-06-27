import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/* eslint-disable unicorn/no-process-exit */

const threshold = process.argv[2];
const sourceRoots = process.argv.slice(3);

if (!threshold) {
    console.error(
        "Usage: bun scripts/runCoverage.ts <thresholdPercent> [sourceRoot ...]"
    );
    process.exit(2);
}

mkdirSync("coverage", { recursive: true });

const coverageResult = Bun.spawnSync({
    cmd: ["bun", "test", "--coverage"],
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
});
const stdout = new TextDecoder().decode(coverageResult.stdout);
const stderr = new TextDecoder().decode(coverageResult.stderr);

process.stdout.write(stdout);
process.stderr.write(stderr);
writeFileSync("coverage/test-output.log", stdout + stderr);

if (coverageResult.exitCode !== 0) {
    process.exit(coverageResult.exitCode);
}

const scriptsDirectory = import.meta.dir;
const checks = [
    [
        "bun",
        path.join(scriptsDirectory, "checkTestOutput.ts"),
        "coverage/test-output.log",
    ],
    [
        "bun",
        path.join(scriptsDirectory, "checkCoverage.ts"),
        "coverage/lcov.info",
        threshold,
        ...sourceRoots,
    ],
];

for (const command of checks) {
    const result = Bun.spawnSync({
        cmd: command,
        stderr: "inherit",
        stdin: "ignore",
        stdout: "inherit",
    });

    if (result.exitCode !== 0) {
        process.exit(result.exitCode);
    }
}
