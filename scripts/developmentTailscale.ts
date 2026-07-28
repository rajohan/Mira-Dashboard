import {
    resolveDevelopmentStackConfig,
    runDevelopmentStack,
} from "./developmentStack.ts";

interface TailscaleStatus {
    Self?: {
        DNSName?: string;
    };
}

interface TailscaleServeStatus {
    TCP?: Record<string, { HTTPS?: boolean }>;
    Web?: Record<
        string,
        {
            Handlers?: Record<string, { Proxy?: string }>;
        }
    >;
}

export interface DevelopmentTailscaleStatus {
    enabled: boolean;
    origin: string;
    proxyTarget: string;
}

export interface DevelopmentTailscaleCommandAdapter {
    currentStatus: (port: number) => Promise<DevelopmentTailscaleStatus>;
    run: (command: string[]) => Promise<string>;
}

const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_FORCE_KILL_GRACE_MS = 2000;

async function commandOutput(command: string[]): Promise<string> {
    const process_ = Bun.spawn(command, {
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    let didTimeout = false;
    let forceKillTimer: Timer | undefined;
    const timeout = setTimeout(() => {
        didTimeout = true;
        try {
            process_.kill("SIGTERM");
        } catch {
            // The command may already have exited at the timeout boundary.
        }
        forceKillTimer = setTimeout(() => {
            try {
                process_.kill("SIGKILL");
            } catch {
                // The command may have exited during the force-kill grace period.
            }
        }, COMMAND_FORCE_KILL_GRACE_MS);
        forceKillTimer.unref();
    }, COMMAND_TIMEOUT_MS);
    timeout.unref();
    let exitCode: number;
    let stderr: string;
    let stdout: string;
    try {
        [exitCode, stderr, stdout] = await Promise.all([
            process_.exited,
            new Response(process_.stderr).text(),
            new Response(process_.stdout).text(),
        ]);
    } finally {
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
    }
    if (didTimeout) {
        throw new Error(`${command[0]} timed out after ${COMMAND_TIMEOUT_MS}ms`);
    }
    if (exitCode !== 0) {
        throw new Error(
            `${command[0]} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`
        );
    }
    return stdout;
}

async function commandJson<T>(command: string[]): Promise<T> {
    const output = await commandOutput(command);
    try {
        return JSON.parse(output) as T;
    } catch {
        throw new Error(`${command[0]} returned invalid JSON`);
    }
}

/** Resolves the stable MagicDNS hostname used as the WebAuthn RP ID. */
export function tailscaleDnsName(status: TailscaleStatus): string {
    const dnsName = status.Self?.DNSName?.trim().replace(/\.$/u, "");
    if (!dnsName || !/^[a-z0-9.-]+$/iu.test(dnsName)) {
        throw new Error("Tailscale did not report a stable MagicDNS hostname");
    }
    return dnsName.toLowerCase();
}

function publicOrigin(dnsName: string, port: number): string {
    return `https://${dnsName}:${port}`;
}

function expectedProxyTarget(port: number): string {
    return `http://127.0.0.1:${port}`;
}

/** Maps Tailscale Serve JSON into one exact development route status. */
export function developmentServeStatus(
    status: TailscaleServeStatus,
    dnsName: string,
    port: number
): DevelopmentTailscaleStatus {
    const origin = publicOrigin(dnsName, port);
    const proxyTarget = expectedProxyTarget(port);
    const web = status.Web?.[`${dnsName}:${port}`];
    const configuredProxy = web?.Handlers?.["/"]?.Proxy;
    const hasHttpsListener = status.TCP?.[String(port)]?.HTTPS === true;
    if (
        (configuredProxy || hasHttpsListener) &&
        (!hasHttpsListener || configuredProxy !== proxyTarget)
    ) {
        throw new Error(
            `Tailscale Serve port ${port} is already configured for another target`
        );
    }
    return {
        enabled: hasHttpsListener && configuredProxy === proxyTarget,
        origin,
        proxyTarget,
    };
}

async function currentDevelopmentServeStatus(
    port: number
): Promise<DevelopmentTailscaleStatus> {
    const [status, serveStatus] = await Promise.all([
        commandJson<TailscaleStatus>(["tailscale", "status", "--json"]),
        commandJson<TailscaleServeStatus>(["tailscale", "serve", "status", "--json"]),
    ]);
    return developmentServeStatus(serveStatus, tailscaleDnsName(status), port);
}

const defaultCommandAdapter: DevelopmentTailscaleCommandAdapter = {
    currentStatus: currentDevelopmentServeStatus,
    run: commandOutput,
};

export async function enableDevelopmentServe(
    port: number,
    commands: DevelopmentTailscaleCommandAdapter = defaultCommandAdapter
): Promise<{ didCreate: boolean; status: DevelopmentTailscaleStatus }> {
    const current = await commands.currentStatus(port);
    if (current.enabled) return { didCreate: false, status: current };
    await commands.run([
        "sudo",
        "-n",
        "tailscale",
        "serve",
        "--bg",
        `--https=${port}`,
        current.proxyTarget,
    ]);
    try {
        const enabled = await commands.currentStatus(port);
        if (!enabled.enabled) {
            throw new Error(`Tailscale Serve did not activate ${enabled.origin}`);
        }
        return { didCreate: true, status: enabled };
    } catch (activationError) {
        try {
            await commands.run([
                "sudo",
                "-n",
                "tailscale",
                "serve",
                `--https=${port}`,
                "off",
            ]);
        } catch (cleanupError) {
            throw new AggregateError(
                [activationError, cleanupError],
                `Tailscale Serve activation failed and port ${port} cleanup also failed`,
                { cause: cleanupError }
            );
        }
        throw activationError;
    }
}

async function disableDevelopmentServe(
    port: number
): Promise<DevelopmentTailscaleStatus> {
    const current = await currentDevelopmentServeStatus(port);
    if (!current.enabled) return current;
    await commandOutput(["sudo", "-n", "tailscale", "serve", `--https=${port}`, "off"]);
    return currentDevelopmentServeStatus(port);
}

async function main(): Promise<number> {
    const [command = "run"] = Bun.argv.slice(2);
    const initialConfig = resolveDevelopmentStackConfig();
    const port = initialConfig.frontendPort;
    if (command === "status") {
        console.log(JSON.stringify(await currentDevelopmentServeStatus(port)));
        return 0;
    }
    if (command === "enable") {
        const enabled = await enableDevelopmentServe(port);
        console.log(JSON.stringify(enabled.status));
        return 0;
    }
    if (command === "disable") {
        console.log(JSON.stringify(await disableDevelopmentServe(port)));
        return 0;
    }
    if (command !== "run") {
        throw new TypeError("Usage: developmentTailscale.ts [run|status|enable|disable]");
    }
    const route = await enableDevelopmentServe(port);
    const config = resolveDevelopmentStackConfig({
        ...process.env,
        MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: route.status.origin,
    });
    try {
        return await runDevelopmentStack(config);
    } finally {
        if (route.didCreate) {
            try {
                await disableDevelopmentServe(port);
            } catch (error) {
                console.error(
                    `Failed to remove the temporary Tailscale Serve route: ${
                        error instanceof Error ? error.message : "unknown error"
                    }`
                );
            }
        }
    }
}

if (import.meta.main) {
    try {
        process.exitCode = await main();
    } catch (error) {
        console.error(
            error instanceof Error ? error.message : "Tailscale dev preview failed"
        );
        process.exitCode = 1;
    }
}
