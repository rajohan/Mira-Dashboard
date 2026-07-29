import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type TestSuite = "backend" | "frontend";

interface TestSuiteConfig {
    coverageDirectory: string;
    cwd: string;
    preload: string;
    testPattern: string;
}

function testSuiteConfig(suite: TestSuite, repoRoot: string): TestSuiteConfig {
    if (suite === "backend") {
        return {
            coverageDirectory: "coverage",
            cwd: path.join(repoRoot, "backend"),
            preload: "./test/setup.ts",
            testPattern: "test",
        };
    }
    return {
        coverageDirectory: "coverage",
        cwd: repoRoot,
        preload: "./frontend/src/test/setup.ts",
        testPattern: "frontend/src",
    };
}

function runCoverage(): number {
    const suite = process.argv[2];
    const threshold = process.argv[3];

    if (!threshold || (suite !== "backend" && suite !== "frontend")) {
        console.error(
            "Usage: bun scripts/runCoverage.ts <backend|frontend> <thresholdPercent> [sourceRoot ...]"
        );
        return 2;
    }

    const sourceRoots = process.argv.slice(4);
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const config = testSuiteConfig(suite, repoRoot);
    const coverageDirectory = path.join(config.cwd, config.coverageDirectory);
    const testOutputPath = path.join(coverageDirectory, "test-output.log");
    const lcovPath = path.join(coverageDirectory, "lcov.info");

    mkdirSync(coverageDirectory, { recursive: true });

    const coverageResult = Bun.spawnSync({
        cmd: [
            process.execPath,
            "test",
            "--config",
            path.join(repoRoot, "bunfig.toml"),
            "--preload",
            config.preload,
            config.testPattern,
            "--coverage",
            "--coverage-reporter",
            "text",
            "--coverage-reporter",
            "lcov",
            "--coverage-dir",
            coverageDirectory,
        ],
        cwd: config.cwd,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    const stdout = new TextDecoder().decode(coverageResult.stdout);
    const stderr = new TextDecoder().decode(coverageResult.stderr);

    process.stdout.write(stdout);
    process.stderr.write(stderr);
    writeFileSync(testOutputPath, stdout + stderr);

    if (!coverageResult.success) {
        if (coverageResult.signalCode) {
            process.stderr.write(
                `Coverage test process terminated by ${coverageResult.signalCode}.\n`
            );
        }
        return coverageResult.exitCode ?? 1;
    }

    const scriptsDirectory = import.meta.dir;
    const checks = [
        [
            process.execPath,
            path.join(scriptsDirectory, "checkTestOutput.ts"),
            testOutputPath,
        ],
        [
            process.execPath,
            path.join(scriptsDirectory, "checkCoverage.ts"),
            lcovPath,
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

        if (!result.success) {
            return result.exitCode ?? 1;
        }
    }

    return 0;
}

process.exitCode = runCoverage();
