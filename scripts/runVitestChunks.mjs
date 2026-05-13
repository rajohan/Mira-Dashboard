#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DEFAULT_CHUNK_SIZE = 30;

const passthroughArgs = [];
let chunkLimit = Number.POSITIVE_INFINITY;
let chunkSize = DEFAULT_CHUNK_SIZE;

for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--chunk-size=")) {
        const value = Number(arg.slice("--chunk-size=".length));
        if (Number.isInteger(value) && value > 0) chunkSize = value;
    } else if (arg.startsWith("--limit-chunks=")) {
        const value = Number(arg.slice("--limit-chunks=".length));
        if (Number.isInteger(value) && value > 0) chunkLimit = value;
    } else {
        passthroughArgs.push(arg);
    }
}

/** Collects frontend test files recursively from a directory. */
function collectTests(directory) {
    if (!existsSync(directory)) return [];

    const entries = readdirSync(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === "dist") continue;
            files.push(...collectTests(fullPath));
            continue;
        }

        if (!entry.isFile()) continue;
        if (/\.test\.tsx?$/.test(entry.name)) {
            files.push(path.relative(ROOT, fullPath));
        }
    }

    return files;
}

/** Splits test files into stable chunks for smaller Vitest processes. */
function chunk(files) {
    const chunks = [];
    for (let index = 0; index < files.length; index += chunkSize) {
        chunks.push(files.slice(index, index + chunkSize));
    }
    return chunks;
}

/** Detects whether the current Vitest invocation should emit coverage. */
function hasCoverageEnabled(args) {
    return args.some(
        (arg) =>
            arg === "--coverage" ||
            arg === "--coverage.enabled" ||
            arg === "--coverage.enabled=true"
    );
}

const testFiles = collectTests(path.join(ROOT, "src")).sort();

if (testFiles.length === 0) {
    console.log("No frontend test files found.");
    process.exit(0);
}

const chunks = chunk(testFiles).slice(0, chunkLimit);
const coverageEnabled = hasCoverageEnabled(passthroughArgs);
const coverageRoot = path.join(ROOT, "coverage", "chunks");

if (coverageEnabled) {
    rmSync(coverageRoot, { force: true, recursive: true });
}

console.log(
    `Running ${testFiles.length} frontend test files in ${chunks.length} chunks (chunk size ${chunkSize}).`
);

const vitestEntrypoint = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const start = Date.now();

for (const [index, files] of chunks.entries()) {
    const label = `${index + 1}/${chunks.length}`;
    const chunkArgs = [...passthroughArgs];

    if (coverageEnabled) {
        // Per-chunk coverage is partial, so merged LCOV thresholds are checked after all chunks.
        chunkArgs.push(
            `--coverage.reportsDirectory=coverage/chunks/chunk-${index + 1}`,
            "--coverage.thresholds.lines=0",
            "--coverage.thresholds.functions=0",
            "--coverage.thresholds.branches=0",
            "--coverage.thresholds.statements=0"
        );
    }

    console.log(`\n[vitest chunk ${label}] ${files[0]} … ${files.at(-1)}`);

    const result = spawnSync(
        process.execPath,
        [
            vitestEntrypoint,
            "run",
            ...files,
            "--pool=forks",
            "--maxWorkers=4",
            "--reporter=dot",
            ...chunkArgs,
        ],
        {
            cwd: ROOT,
            env: process.env,
            stdio: "inherit",
        }
    );

    if (result.status !== 0) {
        const status = result.status ?? 1;
        console.error(`\n[vitest chunk ${label}] failed with exit code ${status}.`);
        process.exit(status);
    }
}

const elapsedSeconds = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nAll frontend test chunks passed in ${elapsedSeconds}s.`);

if (coverageEnabled) {
    console.log("Coverage reports written to coverage/chunks/chunk-*/.");
}
