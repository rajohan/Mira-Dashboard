import path from "node:path";

import { runCommandProcess } from "./commandProcess.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const usage = "Usage: bun run storybook [dev|build]";
const storybookAllowedHostEnvironmentName = "MIRA_DASHBOARD_STORYBOOK_ALLOWED_HOST";

export function parseTailscaleDnsName(status: string): string | undefined {
    try {
        const parsed = JSON.parse(status) as { Self?: { DNSName?: unknown } };
        const dnsName = parsed.Self?.DNSName;
        if (typeof dnsName !== "string") return;
        const host = dnsName.endsWith(".") ? dnsName.slice(0, -1) : dnsName;
        return host === "" ? undefined : host;
    } catch {
        return;
    }
}

function storybookEnvironment(
    environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | undefined>> {
    if (environment[storybookAllowedHostEnvironmentName] !== undefined) {
        return environment;
    }
    const tailscale = Bun.which("tailscale");
    if (tailscale === null) return environment;
    const status = Bun.spawnSync([tailscale, "status", "--json"], {
        stdout: "pipe",
        stderr: "ignore",
    });
    if (status.exitCode !== 0) return environment;
    const allowedHost = parseTailscaleDnsName(status.stdout.toString());
    return allowedHost === undefined
        ? environment
        : { ...environment, [storybookAllowedHostEnvironmentName]: allowedHost };
}

export function parseStorybookCommandArguments(
    arguments_: readonly string[],
    environment: Readonly<Record<string, string | undefined>> = process.env
): readonly string[] {
    const [command = "dev", ...rest] = arguments_;
    if (rest.length > 0 || (command !== "dev" && command !== "build")) {
        throw new TypeError(usage);
    }
    const port = environment.MIRA_DASHBOARD_STORYBOOK_PORT ?? "6007";
    const numericPort = Number(port);
    const host = environment.MIRA_DASHBOARD_STORYBOOK_HOST;
    if (
        !/^\d{1,5}$/u.test(port) ||
        !Number.isSafeInteger(numericPort) ||
        numericPort < 1 ||
        numericPort > 65_535 ||
        (host !== undefined && !/^(?:127\.0\.0\.1|localhost|\[::1\])$/u.test(host))
    ) {
        throw new TypeError(usage);
    }
    return Object.freeze([
        path.join(
            projectRoot,
            "node_modules",
            "storybook",
            "dist",
            "bin",
            "dispatcher.js"
        ),
        command,
        ...(command === "dev"
            ? [
                  "--port",
                  port,
                  ...(host === undefined ? [] : ["--host", host]),
                  "--no-open",
                  "--disable-telemetry",
              ]
            : [
                  "--output-dir",
                  "dist/storybook",
                  "--test",
                  "--quiet",
                  "--disable-telemetry",
              ]),
    ]);
}

export async function runStorybookCommand(
    arguments_: readonly string[],
    root = projectRoot
): Promise<number> {
    const environment = storybookEnvironment(process.env);
    return runCommandProcess(
        {
            name: "storybook",
            arguments: [
                process.execPath,
                ...parseStorybookCommandArguments(arguments_, environment),
            ],
        },
        { cwd: root, environment }
    );
}

if (import.meta.main) {
    try {
        process.exitCode = await runStorybookCommand(Bun.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
        process.exitCode = 1;
    }
}
