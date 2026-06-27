import { readFileSync } from "node:fs";

function checkTestOutput(): number {
    const outputPath = process.argv[2];

    if (!outputPath) {
        console.error("Usage: bun scripts/checkTestOutput.ts <test-output.log>");
        return 2;
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
        return 1;
    }

    console.log("Test output warning check passed");
    return 0;
}

process.exitCode = checkTestOutput();
