import { readFileSync } from "node:fs";

/* eslint-disable unicorn/no-process-exit */

const lcovPath = process.argv[2];
const thresholdInput = process.argv[3];
const threshold = Number(thresholdInput);

if (!lcovPath || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    console.error("Usage: bun scripts/checkCoverage.ts <lcov.info> <thresholdPercent>");
    process.exit(2);
}

const lcov = readFileSync(lcovPath, "utf8");
let foundLines = 0;
let hitLines = 0;

for (const match of lcov.matchAll(/^LF:(\d+)$/gmu)) {
    foundLines += Number(match[1]);
}
for (const match of lcov.matchAll(/^LH:(\d+)$/gmu)) {
    hitLines += Number(match[1]);
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
