import path from "node:path";

/** Captured result from one Drizzle Kit process. */
export interface DrizzleKitCommandResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

/** Injectable Drizzle Kit process boundary used by tooling tests. */
export type RunDrizzleKitCommand = (
    arguments_: readonly string[]
) => DrizzleKitCommandResult;

const projectRoot = path.resolve(import.meta.dir, "..");
const drizzleKitEntrypoint = path.join(
    projectRoot,
    "node_modules",
    "drizzle-kit",
    "bin.cjs"
);

function executeDrizzleKit(arguments_: readonly string[]): DrizzleKitCommandResult {
    const result = Bun.spawnSync(
        [process.execPath, drizzleKitEntrypoint, ...arguments_],
        {
            cwd: projectRoot,
            stderr: "pipe",
            stdout: "pipe",
        }
    );
    const stderr = result.stderr.toString().trim();
    const stdout = result.stdout.toString().trim();

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    return { exitCode: result.exitCode, stderr, stdout };
}

/**
 * Validates one JSON-mode Drizzle Kit result.
 * @param result Captured command result.
 * @param expectedStatus Required JSON status.
 */
export function assertDrizzleKitOutput(
    result: DrizzleKitCommandResult,
    expectedStatus: string
): void {
    if (result.exitCode !== 0) {
        throw new Error(
            `drizzle-kit exited ${result.exitCode}: ${result.stderr || result.stdout || "no output"}`
        );
    }

    let output: unknown;
    try {
        output = JSON.parse(result.stdout) as unknown;
    } catch {
        throw new Error("drizzle-kit returned invalid JSON");
    }
    if (typeof output !== "object" || output === null || Array.isArray(output)) {
        throw new Error("drizzle-kit returned invalid JSON object");
    }
    const status = (output as Record<string, unknown>).status;
    if (status !== expectedStatus) {
        throw new Error(
            `drizzle-kit returned status ${String(status)}; expected ${expectedStatus}`
        );
    }
}

/**
 * Verifies migration-history consistency and schema-to-snapshot drift.
 * @param runCommand Drizzle Kit process adapter.
 */
export function checkDatabaseSchema(
    runCommand: RunDrizzleKitCommand = executeDrizzleKit
): void {
    assertDrizzleKitOutput(
        runCommand(["check", "--config", "drizzle.config.ts", "--output", "json"]),
        "ok"
    );
    assertDrizzleKitOutput(
        runCommand([
            "generate",
            "--config",
            "drizzle.config.ts",
            "--output",
            "json",
            "--explain",
        ]),
        "no_changes"
    );
}

if (import.meta.main) checkDatabaseSchema();
