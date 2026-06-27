import { readFileSync } from "node:fs";

/* eslint-disable unicorn/no-process-exit */

const outputPath = process.argv[2];

if (!outputPath) {
    console.error("Usage: bun scripts/checkTestOutput.ts <test-output.log>");
    process.exit(2);
}

const output = readFileSync(outputPath, "utf8");
const disallowedPatterns = [
    /not wrapped in act/i,
    /current testing environment is not configured to support act/i,
];
const matchedPattern = disallowedPatterns.find((pattern) => pattern.test(output));

if (matchedPattern) {
    console.error(
        `Test output contains disallowed warning matching ${matchedPattern.toString()}`
    );
    process.exit(1);
}

console.log("Test output warning check passed");
