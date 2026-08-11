import {
    prepareDevelopmentRuntimeState,
    resolveDevelopmentStackConfig,
    runDevelopmentStackWithPreparedState,
} from "../developmentStack.ts";
import {
    guardedDevelopmentChildCommand,
    guardedDevelopmentPrivilegedCommand,
} from "./developmentProcessGuard.ts";
import { remoteDevelopmentStateRoot } from "./developmentRuntime.ts";
import {
    acquireDevelopmentTailscaleRouteLock,
    type DevelopmentTailscaleRouteLock,
} from "./developmentTailscaleLock.ts";

interface TailscaleStatus {
    readonly Self?: {
        readonly DNSName?: string;
    };
}

interface TailscaleServeStatus {
    readonly AllowFunnel?: Readonly<Record<string, boolean>>;
    readonly TCP?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly Web?: Readonly<
        Record<
            string,
            {
                readonly Handlers?: Readonly<Record<string, { readonly Proxy?: string }>>;
            }
        >
    >;
}

export interface DevelopmentTailscaleStatus {
    readonly enabled: boolean;
    readonly origin: string;
    readonly proxyTarget: string;
}

export interface DevelopmentTailscaleCommandAdapter {
    readonly currentStatus: (
        httpsPort: number,
        proxyPort: number
    ) => Promise<DevelopmentTailscaleStatus>;
    readonly run: (command: readonly string[]) => Promise<string>;
}

export type DevelopmentTailscaleRouteLockAcquirer = (
    httpsPort: number
) => Promise<DevelopmentTailscaleRouteLock>;

const commandTimeoutMs = 15_000;
const commandForceKillGraceMs = 2000;

async function commandOutput(command: readonly string[]): Promise<string> {
    let guardedCommand: readonly string[];
    if (command[0] === "sudo") {
        if (command[1] !== "-n" || command[2] === undefined) {
            throw new TypeError("Development sudo command is invalid");
        }
        const executable = Bun.which(command[2]);
        if (executable === null) {
            throw new Error("Development privileged command is unavailable");
        }
        guardedCommand = guardedDevelopmentPrivilegedCommand([
            executable,
            ...command.slice(3),
        ]);
    } else {
        guardedCommand = guardedDevelopmentChildCommand(command);
    }
    const child = Bun.spawn([...guardedCommand], {
        env: {
            LANG: "C",
            LC_ALL: "C",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
        },
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    let didTimeout = false;
    let forceKillTimer: Timer | undefined;
    const timeout = setTimeout(() => {
        didTimeout = true;
        try {
            child.kill("SIGTERM");
        } catch {
            // The command may already have exited at the timeout boundary.
        }
        forceKillTimer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // The command may have exited during the force-kill grace period.
            }
        }, commandForceKillGraceMs);
        forceKillTimer.unref();
    }, commandTimeoutMs);
    timeout.unref();
    let exitCode: number;
    let stderr: string;
    let stdout: string;
    try {
        [exitCode, stderr, stdout] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
            new Response(child.stdout).text(),
        ]);
    } finally {
        clearTimeout(timeout);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    }
    if (didTimeout) {
        throw new Error(
            `${command[0] ?? "command"} timed out after ${commandTimeoutMs}ms`
        );
    }
    if (exitCode !== 0) {
        throw new Error(
            `${command[0] ?? "command"} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`
        );
    }
    return stdout;
}

async function commandJson<T>(command: readonly string[]): Promise<T> {
    const output = await commandOutput(command);
    try {
        return JSON.parse(output) as T;
    } catch {
        throw new Error(`${command[0] ?? "command"} returned invalid JSON`);
    }
}

/**
 * Resolves the stable MagicDNS hostname used by the remote development origin.
 * @param status Parsed Tailscale node status.
 * @returns Canonical lowercase MagicDNS hostname without a trailing dot.
 */
export function tailscaleDnsName(status: TailscaleStatus): string {
    const dnsName = status.Self?.DNSName?.trim().replace(/\.$/u, "");
    if (!dnsName || !/^[a-z0-9.-]+$/iu.test(dnsName)) {
        throw new Error("Tailscale did not report a stable MagicDNS hostname");
    }
    return dnsName.toLowerCase();
}

function publicOrigin(dnsName: string, httpsPort: number): string {
    return `https://${dnsName}:${httpsPort}`;
}

function expectedProxyTarget(proxyPort: number): string {
    return `http://127.0.0.1:${proxyPort}`;
}

function activationCleanupFailure(
    httpsPort: number,
    activationError: unknown,
    cleanupError: unknown
): AggregateError {
    return new AggregateError(
        [activationError, cleanupError],
        `Tailscale Serve activation failed and port ${httpsPort} cleanup also failed`,
        { cause: activationError }
    );
}

function observedError(error: unknown, message: string): Error {
    return error instanceof Error ? error : new Error(message, { cause: error });
}

/**
 * Maps Tailscale Serve JSON into the one exact development route owned by this stack.
 * @param status Parsed Tailscale Serve status.
 * @param dnsName Canonical MagicDNS hostname.
 * @param httpsPort Dedicated remote HTTPS port.
 * @param proxyPort Loopback remote-proxy port.
 * @returns Exact-route status, origin, and expected proxy target.
 */
export function developmentServeStatus(
    status: TailscaleServeStatus,
    dnsName: string,
    httpsPort: number,
    proxyPort: number
): DevelopmentTailscaleStatus {
    const origin = publicOrigin(dnsName, httpsPort);
    const proxyTarget = expectedProxyTarget(proxyPort);
    const expectedWebKey = `${dnsName}:${httpsPort}`;
    const portWebKeys = Object.keys(status.Web ?? {}).filter((key) =>
        key.endsWith(`:${httpsPort}`)
    );
    const handlers = status.Web?.[expectedWebKey]?.Handlers;
    const allowsFunnel = status.AllowFunnel?.[expectedWebKey] === true;
    const handlerPaths = Object.keys(handlers ?? {});
    const configuredProxy = handlers?.["/"]?.Proxy;
    const tcpHandler = status.TCP?.[String(httpsPort)];
    const tcpHandlerKeys = Object.keys(tcpHandler ?? {});
    const hasExactHttpsListener =
        tcpHandlerKeys.length === 1 &&
        tcpHandlerKeys[0] === "HTTPS" &&
        tcpHandler?.HTTPS === true;
    const isExactRoute =
        !allowsFunnel &&
        hasExactHttpsListener &&
        portWebKeys.length === 1 &&
        portWebKeys[0] === expectedWebKey &&
        handlerPaths.length === 1 &&
        handlerPaths[0] === "/" &&
        configuredProxy === proxyTarget;
    if (
        (tcpHandler !== undefined || portWebKeys.length > 0 || allowsFunnel) &&
        !isExactRoute
    ) {
        throw new Error(
            `Tailscale Serve port ${httpsPort} is already configured for another target`
        );
    }
    return Object.freeze({
        enabled: isExactRoute,
        origin,
        proxyTarget,
    });
}

async function currentDevelopmentServeStatus(
    httpsPort: number,
    proxyPort: number
): Promise<DevelopmentTailscaleStatus> {
    const [status, serveStatus] = await Promise.all([
        commandJson<TailscaleStatus>(["tailscale", "status", "--json"]),
        commandJson<TailscaleServeStatus>(["tailscale", "serve", "status", "--json"]),
    ]);
    return developmentServeStatus(
        serveStatus,
        tailscaleDnsName(status),
        httpsPort,
        proxyPort
    );
}

const defaultCommandAdapter: DevelopmentTailscaleCommandAdapter = Object.freeze({
    currentStatus: currentDevelopmentServeStatus,
    run: commandOutput,
});

async function withDevelopmentTailscaleRouteLock<T>(
    httpsPort: number,
    operation: () => Promise<T>,
    acquireRouteLock: DevelopmentTailscaleRouteLockAcquirer
): Promise<T> {
    const lock = await acquireRouteLock(httpsPort);
    try {
        return await operation();
    } finally {
        await lock.release();
    }
}

async function enableDevelopmentServeLocked(
    httpsPort: number,
    proxyPort: number,
    commands: DevelopmentTailscaleCommandAdapter
): Promise<Readonly<{ didCreate: boolean; status: DevelopmentTailscaleStatus }>> {
    const current = await commands.currentStatus(httpsPort, proxyPort);
    if (current.enabled) return Object.freeze({ didCreate: false, status: current });
    try {
        await commands.run([
            "sudo",
            "-n",
            "tailscale",
            "serve",
            "--bg",
            `--https=${httpsPort}`,
            current.proxyTarget,
        ]);
        const enabled = await commands.currentStatus(httpsPort, proxyPort);
        if (!enabled.enabled) {
            throw new Error(`Tailscale Serve did not activate ${enabled.origin}`);
        }
        return Object.freeze({ didCreate: true, status: enabled });
    } catch (activationError) {
        let cleanupError: unknown = null;
        try {
            await commands.run([
                "sudo",
                "-n",
                "tailscale",
                "serve",
                `--https=${httpsPort}`,
                "off",
            ]);
        } catch (error) {
            cleanupError = error;
        }
        if (cleanupError !== null) {
            throw activationCleanupFailure(httpsPort, activationError, cleanupError);
        }
        throw activationError;
    }
}

/**
 * Enables only the exact HTTPS-to-loopback route and records cleanup ownership.
 * @param httpsPort Dedicated remote HTTPS port.
 * @param proxyPort Loopback remote-proxy port.
 * @param commands Validated command adapter.
 * @param acquireRouteLock Host lock adapter, injectable for isolated unit tests.
 * @returns Verified route status and whether this invocation created the route.
 */
export async function enableDevelopmentServe(
    httpsPort: number,
    proxyPort: number,
    commands: DevelopmentTailscaleCommandAdapter = defaultCommandAdapter,
    acquireRouteLock: DevelopmentTailscaleRouteLockAcquirer = acquireDevelopmentTailscaleRouteLock
): Promise<Readonly<{ didCreate: boolean; status: DevelopmentTailscaleStatus }>> {
    return withDevelopmentTailscaleRouteLock(
        httpsPort,
        () => enableDevelopmentServeLocked(httpsPort, proxyPort, commands),
        acquireRouteLock
    );
}

async function disableDevelopmentServeLocked(
    httpsPort: number,
    proxyPort: number
): Promise<DevelopmentTailscaleStatus> {
    const current = await currentDevelopmentServeStatus(httpsPort, proxyPort);
    if (!current.enabled) return current;
    await commandOutput([
        "sudo",
        "-n",
        "tailscale",
        "serve",
        `--https=${httpsPort}`,
        "off",
    ]);
    return currentDevelopmentServeStatus(httpsPort, proxyPort);
}

async function disableDevelopmentServe(
    httpsPort: number,
    proxyPort: number
): Promise<DevelopmentTailscaleStatus> {
    return withDevelopmentTailscaleRouteLock(
        httpsPort,
        () => disableDevelopmentServeLocked(httpsPort, proxyPort),
        acquireDevelopmentTailscaleRouteLock
    );
}

async function main(): Promise<number> {
    const [command = "run"] = Bun.argv.slice(2);
    const initialConfig = resolveDevelopmentStackConfig();
    const httpsPort = initialConfig.tailscalePort;
    const proxyPort = initialConfig.remoteProxyPort;
    if (command === "status") {
        process.stdout.write(
            `${JSON.stringify(
                await currentDevelopmentServeStatus(httpsPort, proxyPort)
            )}\n`
        );
        return 0;
    }
    if (command === "enable") {
        const enabled = await enableDevelopmentServe(httpsPort, proxyPort);
        process.stdout.write(`${JSON.stringify(enabled.status)}\n`);
        return 0;
    }
    if (command === "disable") {
        process.stdout.write(
            `${JSON.stringify(await disableDevelopmentServe(httpsPort, proxyPort))}\n`
        );
        return 0;
    }
    if (command !== "run") {
        throw new TypeError("Usage: developmentTailscale.ts [run|status|enable|disable]");
    }

    const routeLock = await acquireDevelopmentTailscaleRouteLock(httpsPort);
    let interrupted = false;
    const deferTermination = () => {
        interrupted = true;
    };
    process.on("SIGINT", deferTermination);
    process.on("SIGTERM", deferTermination);
    let route: Awaited<ReturnType<typeof enableDevelopmentServe>> | undefined;
    let stateSession:
        | Awaited<ReturnType<typeof prepareDevelopmentRuntimeState>>
        | undefined;
    let result = 0;
    let operationFailure: unknown;
    try {
        const currentRoute = await currentDevelopmentServeStatus(httpsPort, proxyPort);
        const configuredStateRoot = process.env.MIRA_DASHBOARD_DEV_STATE_ROOT?.trim();
        const config = resolveDevelopmentStackConfig({
            ...process.env,
            MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: currentRoute.origin,
            MIRA_DASHBOARD_DEV_STATE_ROOT:
                configuredStateRoot ||
                remoteDevelopmentStateRoot(initialConfig.stateRoot),
        });
        stateSession = await prepareDevelopmentRuntimeState(config);
        if (!interrupted) {
            route = await enableDevelopmentServeLocked(
                httpsPort,
                proxyPort,
                defaultCommandAdapter
            );
            if (!interrupted) {
                result = await runDevelopmentStackWithPreparedState(config, stateSession);
            }
        }
    } catch (error) {
        operationFailure = error;
    }

    const cleanupFailures: unknown[] = [];
    try {
        if (route?.didCreate === true) {
            const disabled = await disableDevelopmentServeLocked(httpsPort, proxyPort);
            if (disabled.enabled) {
                throw new Error(
                    `Tailscale Serve route on port ${httpsPort} remained enabled`
                );
            }
        }
    } catch (error) {
        cleanupFailures.push(error);
    }
    try {
        await stateSession?.release();
    } catch (error) {
        cleanupFailures.push(error);
    }
    process.removeListener("SIGINT", deferTermination);
    process.removeListener("SIGTERM", deferTermination);
    try {
        await routeLock.release();
    } catch (error) {
        cleanupFailures.push(error);
    }

    if (cleanupFailures.length > 0) {
        const cleanupError =
            cleanupFailures.length === 1
                ? observedError(cleanupFailures[0], "Remote development cleanup failed")
                : new AggregateError(
                      cleanupFailures,
                      "Remote development cleanup failed"
                  );
        if (operationFailure !== undefined) {
            throw new AggregateError(
                [operationFailure, cleanupError],
                `Remote development failed and cleanup did not complete: ${
                    operationFailure instanceof Error
                        ? operationFailure.message
                        : "unknown runtime failure"
                }`,
                { cause: operationFailure }
            );
        }
        throw cleanupError;
    }
    if (operationFailure !== undefined) {
        throw observedError(operationFailure, "Remote development failed");
    }
    return result;
}

if (import.meta.main) {
    try {
        process.exitCode = await main();
    } catch (error) {
        process.stderr.write(
            `${error instanceof Error ? error.message : "Tailscale dev preview failed"}\n`
        );
        process.exitCode = 1;
    }
}
