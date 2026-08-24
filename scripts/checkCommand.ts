import path from "node:path";

import {
    type CommandProcess,
    runCommandProcess,
    runCommandProcesses,
} from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage =
    "Usage: bun run check [all|boundaries|database|docs|format|hooks|lint|typecheck] [--fix]";

export type CheckCommand =
    | "all"
    | "boundaries"
    | "database"
    | "docs"
    | "format"
    | "hooks"
    | "lint"
    | "typecheck";

export interface CheckCommandArguments {
    readonly command: CheckCommand;
    readonly fix: boolean;
}

export function parseCheckCommandArguments(
    arguments_: readonly string[]
): CheckCommandArguments {
    const [candidate = "all", ...options] = arguments_;
    if (
        ![
            "all",
            "boundaries",
            "database",
            "docs",
            "format",
            "hooks",
            "lint",
            "typecheck",
        ].includes(candidate) ||
        options.some((option) => option !== "--fix") ||
        options.filter((option) => option === "--fix").length > 1 ||
        (options.includes("--fix") && candidate !== "lint" && candidate !== "format")
    ) {
        throw new TypeError(usage);
    }
    return Object.freeze({
        command: candidate as CheckCommand,
        fix: options.includes("--fix"),
    });
}

function lintCommands(root: string, fix: boolean): readonly CommandProcess[] {
    const oxlint = path.join(root, "node_modules", ".bin", "oxlint");
    return Object.freeze([
        {
            name: "lint:bun",
            arguments: [
                oxlint,
                ".",
                ...(fix ? ["--fix"] : []),
                "--tsconfig",
                "tsconfig.bun.json",
                "--ignore-pattern",
                "src/browser/**",
                "--ignore-pattern",
                ".storybook/manager.ts",
                "--ignore-pattern",
                ".storybook/preview.tsx",
            ],
        },
        {
            name: "lint:browser",
            arguments: [
                oxlint,
                "src/browser",
                ...(fix ? ["--fix"] : []),
                "--tsconfig",
                "tsconfig.browser.json",
                "--ignore-pattern",
                "**/*.stories.tsx",
                "--ignore-pattern",
                "**/storySupport/**",
                "--no-error-on-unmatched-pattern",
            ],
        },
        {
            name: "lint:storybook",
            arguments: [
                process.execPath,
                "scripts/lintStorybook.ts",
                ...(fix ? ["--fix"] : []),
            ],
        },
    ]);
}

function typecheckCommands(): readonly CommandProcess[] {
    return Object.freeze(
        ["browser", "storybook", "bun"].map((partition) => ({
            name: `typecheck:${partition}`,
            arguments: [
                process.execPath,
                "node_modules/typescript/bin/tsc",
                "-p",
                `tsconfig.${partition}.json`,
                "--noEmit",
            ],
        }))
    );
}

export async function runCheckCommand(
    arguments_: readonly string[],
    root = projectRoot
): Promise<number> {
    const { command, fix } = parseCheckCommandArguments(arguments_);
    if (command === "boundaries") {
        return runCommandProcess(
            {
                name: "boundaries",
                arguments: [process.execPath, "scripts/checkSourceBoundaries.ts"],
            },
            { cwd: root, environment: process.env }
        );
    }
    if (command === "database" || command === "docs") {
        return runCommandProcess(
            {
                name: command,
                arguments: [
                    process.execPath,
                    command === "database"
                        ? "scripts/checkDatabaseSchema.ts"
                        : "scripts/generateDocs.ts",
                    ...(command === "docs" ? ["--check"] : []),
                ],
            },
            { cwd: root, environment: process.env }
        );
    }
    if (command === "format") {
        return runCommandProcess(
            {
                name: "format",
                arguments: [
                    path.join(root, "node_modules", ".bin", "oxfmt"),
                    "--config",
                    "oxfmt.config.ts",
                    fix ? "--write" : "--check",
                    ".",
                ],
            },
            { cwd: root, environment: process.env }
        );
    }
    if (command === "hooks") {
        return runCommandProcess(
            {
                name: "hooks",
                arguments: [
                    path.join(root, "node_modules", ".bin", "lefthook"),
                    "validate",
                ],
                environment: { LEFTHOOK_CONFIG: path.join(root, "lefthook.yml") },
            },
            { cwd: root, environment: process.env }
        );
    }
    if (command === "lint") {
        return runCommandProcesses(lintCommands(root, fix), {
            cwd: root,
            environment: process.env,
        });
    }
    if (command === "typecheck") {
        return runCommandProcesses(typecheckCommands(), {
            cwd: root,
            environment: process.env,
        });
    }
    const staticResult = await runCommandProcesses(
        [...lintCommands(root, false), ...typecheckCommands()],
        { cwd: root, environment: process.env }
    );
    if (staticResult !== 0) return staticResult;
    for (const next of ["format", "hooks", "boundaries", "docs", "database"] as const) {
        const result = await runCheckCommand([next], root);
        if (result !== 0) return result;
    }
    return 0;
}

if (import.meta.main) {
    try {
        process.exitCode = await runCheckCommand(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
