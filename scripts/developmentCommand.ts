import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage =
    "Usage: bun run dev [run|doppler|prepare-state|reset-database|reset-state|remote] [remote] [enable|disable|status]";

const dopplerArguments = Object.freeze([
    "/usr/local/bin/doppler",
    "run",
    "--project",
    "rajohan",
    "--config",
    "prd",
    "--only-secrets",
    "OPENCLAW_GATEWAY_TOKEN,MOLTBOOK_API_KEY,ELEVENLABS_API_KEY,MIRA_DASHBOARD_SESSION_IDLE_MINUTES,MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
    "--no-exit-on-missing-only-secrets",
    "--",
    process.execPath,
    "scripts/developmentCommand.ts",
]);

export function parseDevelopmentCommandArguments(
    arguments_: readonly string[]
): readonly string[] {
    const [command = "run", option, action, ...rest] = arguments_;
    if (rest.length > 0) throw new TypeError(usage);
    if (command === "doppler") {
        if (option === undefined) return dopplerArguments;
        if (
            option !== "remote" ||
            (action !== undefined &&
                !["run", "enable", "disable", "status"].includes(action))
        ) {
            throw new TypeError(usage);
        }
        return Object.freeze([
            ...dopplerArguments,
            "remote",
            ...(action === undefined ? [] : [action]),
        ]);
    }
    if (command === "remote") {
        if (action !== undefined) throw new TypeError(usage);
        const remoteAction = option ?? "run";
        if (!["run", "enable", "disable", "status"].includes(remoteAction)) {
            throw new TypeError(usage);
        }
        return Object.freeze([
            process.execPath,
            "scripts/development/developmentTailscale.ts",
            remoteAction,
        ]);
    }
    if (option !== undefined || action !== undefined) throw new TypeError(usage);
    const optionByCommand = {
        run: undefined,
        "prepare-state": "--prepare-state",
        "reset-database": "--reset-database",
        "reset-state": "--reset-state",
    } as const;
    if (!(command in optionByCommand)) throw new TypeError(usage);
    const stackOption = optionByCommand[command as keyof typeof optionByCommand];
    return Object.freeze([
        process.execPath,
        "scripts/developmentStack.ts",
        ...(stackOption === undefined ? [] : [stackOption]),
    ]);
}

export async function runDevelopmentCommand(
    arguments_: readonly string[],
    root = projectRoot
): Promise<number> {
    return runCommandProcess(
        {
            name: "development",
            arguments: parseDevelopmentCommandArguments(arguments_),
        },
        { cwd: root, environment: process.env }
    );
}

if (import.meta.main) {
    try {
        process.exitCode = await runDevelopmentCommand(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
