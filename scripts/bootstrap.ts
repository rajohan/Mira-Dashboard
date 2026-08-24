import { readFile } from "node:fs/promises";
import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage =
    "Usage: bun run bootstrap [production] | bun run bootstrap development [--doppler] [--no-start] [--with-browser]";

export interface BootstrapArguments {
    readonly doppler: boolean;
    readonly start: boolean;
    readonly withBrowser: boolean;
}

export interface BootstrapDependencies {
    readonly readRuntimeVersion: (root: string) => Promise<string>;
    readonly run: (
        arguments_: readonly string[],
        environment?: Readonly<Record<string, string>>
    ) => Promise<number>;
    readonly runtimeVersion: string;
}

export function parseBootstrapArguments(
    arguments_: readonly string[]
): BootstrapArguments {
    const accepted = new Set(["--doppler", "--no-start", "--with-browser"]);
    if (
        arguments_.some((argument) => !accepted.has(argument)) ||
        new Set(arguments_).size !== arguments_.length ||
        (arguments_.includes("--doppler") && arguments_.includes("--no-start"))
    ) {
        throw new TypeError(usage);
    }
    return Object.freeze({
        doppler: arguments_.includes("--doppler"),
        start: !arguments_.includes("--no-start"),
        withBrowser: arguments_.includes("--with-browser"),
    });
}

async function defaultReadRuntimeVersion(root: string): Promise<string> {
    const version = await readFile(path.join(root, ".bun-version"), "utf8");
    return version.trim();
}

/**
 * Creates the real process/filesystem bootstrap boundary.
 * @param root Canonical repository package root.
 * @returns Bootstrap dependencies bound to the current runtime.
 */
function defaultDependencies(root: string): BootstrapDependencies {
    return {
        readRuntimeVersion: defaultReadRuntimeVersion,
        runtimeVersion: Bun.version,
        run: async (arguments_, environment) =>
            runCommandProcess(
                { name: arguments_.join(" "), arguments: arguments_, environment },
                { cwd: root, environment: process.env }
            ),
    };
}

/**
 * Routes bare/production bootstrap to the complete clean-host installer and keeps the former
 * isolated local workflow behind the explicit development mode.
 * @param arguments_ Explicit bootstrap mode and development-only flags.
 * @param root Canonical repository package root.
 * @param dependencies Injectable runtime, filesystem, and process boundaries.
 * @returns Production installer or development child exit code.
 */
export async function runBootstrap(
    arguments_: readonly string[],
    root = projectRoot,
    dependencies = defaultDependencies(root)
): Promise<number> {
    const [mode, ...modeArguments] = arguments_;
    if (mode === undefined || mode === "production") {
        if (modeArguments.length > 0) throw new TypeError(usage);
        return dependencies.run([process.execPath, "scripts/productionBootstrap.ts"]);
    }
    if (mode !== "development") throw new TypeError(usage);
    const options = parseBootstrapArguments(modeArguments);
    const requiredVersion = await dependencies.readRuntimeVersion(root);
    if (dependencies.runtimeVersion !== requiredVersion) {
        throw new Error(
            `Bootstrap requires Bun ${requiredVersion}; observed ${dependencies.runtimeVersion}`
        );
    }
    const commands: ReadonlyArray<
        readonly [readonly string[], Readonly<Record<string, string>>?]
    > = [
        [[process.execPath, "install", "--frozen-lockfile"]],
        [[process.execPath, "scripts/installGitHooks.ts"]],
        [[process.execPath, "scripts/generateDocs.ts", "--check"]],
        [[process.execPath, "scripts/checkDatabaseSchema.ts"]],
        [[process.execPath, "scripts/developmentStack.ts", "--prepare-state"]],
        ...(options.withBrowser
            ? [
                  [
                      [
                          path.join(root, "node_modules", ".bin", "playwright"),
                          "install",
                          "chromium",
                          "--only-shell",
                      ],
                      { PLAYWRIGHT_BROWSERS_PATH: "node_modules/.cache/playwright" },
                  ] as const,
              ]
            : []),
    ];
    for (const [command, environment] of commands) {
        const result = await dependencies.run(command, environment);
        if (result !== 0) return result;
    }
    if (!options.start) {
        process.stdout.write("Dashboard bootstrap complete; start with `bun run dev`.\n");
        return 0;
    }
    return dependencies.run([
        process.execPath,
        options.doppler ? "scripts/developmentCommand.ts" : "scripts/developmentStack.ts",
        ...(options.doppler ? ["doppler"] : []),
    ]);
}

if (import.meta.main) {
    try {
        process.exitCode = await runBootstrap(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
