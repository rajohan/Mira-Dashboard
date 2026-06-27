import { readFileSync } from "node:fs";

/* eslint-disable unicorn/no-process-exit */

const lcovPath = process.argv[2];
const thresholdInput = process.argv[3];
const allowedRoots = process.argv.slice(4);
const threshold = Number(thresholdInput);

if (!lcovPath || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    console.error(
        "Usage: bun scripts/checkCoverage.ts <lcov.info> <thresholdPercent> [sourceRoot ...]"
    );
    process.exit(2);
}

const lcov = readFileSync(lcovPath, "utf8");
let foundLines = 0;
let hitLines = 0;
let shouldCountCurrentFile = allowedRoots.length === 0;

for (const match of lcov.matchAll(/^(SF|LF|LH):(.+)$/gmu)) {
    const kind = match[1];
    const value = match[2];
    if (!kind || !value) continue;
    if (kind === "SF") {
        shouldCountCurrentFile =
            allowedRoots.length === 0 ||
            allowedRoots.some((root) => value.startsWith(root));
    } else if (shouldCountCurrentFile && kind === "LF") {
        foundLines += Number(value);
    } else if (shouldCountCurrentFile && kind === "LH") {
        hitLines += Number(value);
    }
}

if (foundLines === 0) {
    console.error(`No line coverage entries found in ${lcovPath}`);
    process.exit(1);
}

const percent = (hitLines / foundLines) * 100;
const formattedPercent = percent.toFixed(2);

if (percent < threshold) {
    console.error(
        `Coverage ${formattedPercent}% is below required ${threshold.toFixed(2)}% (${hitLines}/${foundLines} lines)`
    );
    process.exit(1);
}

console.log(
    `Coverage ${formattedPercent}% meets required ${threshold.toFixed(2)}% (${hitLines}/${foundLines} lines)`
);
