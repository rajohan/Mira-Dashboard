import { runCommand, runJsonCommand } from "./commands.ts";
import type { PullRequestPreviewConfig } from "./types.ts";

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

export interface PreviewTailscaleRoute {
    enabled: boolean;
    url: string;
}

function tailscaleDnsName(status: TailscaleStatus): string {
    const dnsName = status.Self?.DNSName?.trim().replace(/\.$/u, "");
    if (!dnsName || !/^[a-z0-9.-]+$/iu.test(dnsName)) {
        throw new Error("Tailscale did not report a stable MagicDNS hostname");
    }
    return dnsName.toLowerCase();
}

export async function inspectTailscaleServe(
    config: PullRequestPreviewConfig,
    signal?: AbortSignal
): Promise<PreviewTailscaleRoute> {
    const [status, serveStatus] = await Promise.all([
        runJsonCommand<TailscaleStatus>("tailscale", ["status", "--json"], {
            signal,
        }),
        runJsonCommand<TailscaleServeStatus>(
            "tailscale",
            ["serve", "status", "--json"],
            { signal }
        ),
    ]);
    const dnsName = tailscaleDnsName(status);
    const port = config.frontendPort;
    const proxyTarget = `http://127.0.0.1:${port}`;
    const web = serveStatus.Web?.[`${dnsName}:${port}`];
    const configuredProxy = web?.Handlers?.["/"]?.Proxy;
    const hasHttpsListener = serveStatus.TCP?.[String(port)]?.HTTPS === true;
    if (
        (configuredProxy || hasHttpsListener) &&
        (!hasHttpsListener || configuredProxy !== proxyTarget)
    ) {
        throw Object.assign(
            new Error(`Tailscale Serve port ${port} is configured for another target`),
            { statusCode: 409 }
        );
    }
    return {
        enabled: hasHttpsListener,
        url: `https://${dnsName}:${port}`,
    };
}

export async function enableTailscaleServe(
    config: PullRequestPreviewConfig,
    expectedUrl: string,
    onOwnershipChange: (isOwned: boolean) => void,
    signal?: AbortSignal
): Promise<void> {
    const current = await inspectTailscaleServe(config, signal);
    if (current.url !== expectedUrl) {
        throw new Error("Tailscale MagicDNS hostname changed during preview startup");
    }
    if (current.enabled) {
        throw Object.assign(
            new Error(
                `Tailscale Serve port ${config.frontendPort} became active during preview startup`
            ),
            { statusCode: 409 }
        );
    }
    await runCommand(
        "sudo",
        [
            "-n",
            "tailscale",
            "serve",
            "--bg",
            `--https=${config.frontendPort}`,
            `http://127.0.0.1:${config.frontendPort}`,
        ],
        { signal }
    );
    onOwnershipChange(true);
    try {
        const enabled = await inspectTailscaleServe(config, signal);
        if (!enabled.enabled || enabled.url !== expectedUrl) {
            throw new Error("Tailscale Serve did not expose the ready preview service");
        }
    } catch (error) {
        try {
            await disableOwnedTailscaleServe(config, true);
            onOwnershipChange(false);
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                "Tailscale Serve activation failed and its route could not be removed",
                { cause: error }
            );
        }
        throw error;
    }
}

export async function disableOwnedTailscaleServe(
    config: PullRequestPreviewConfig,
    isOwned: boolean
): Promise<void> {
    if (!isOwned) return;
    const [status, serveStatus] = await Promise.all([
        runJsonCommand<TailscaleStatus>("tailscale", ["status", "--json"]),
        runJsonCommand<TailscaleServeStatus>("tailscale", [
            "serve",
            "status",
            "--json",
        ]),
    ]);
    const dnsName = tailscaleDnsName(status);
    const port = config.frontendPort;
    const proxyTarget = `http://127.0.0.1:${port}`;
    const web = serveStatus.Web?.[`${dnsName}:${port}`];
    const configuredProxy = web?.Handlers?.["/"]?.Proxy;
    const hasHttpsListener = serveStatus.TCP?.[String(port)]?.HTTPS === true;
    if (!configuredProxy && !hasHttpsListener) return;
    if (!hasHttpsListener || configuredProxy !== proxyTarget) {
        throw Object.assign(
            new Error(
                `Refusing to remove Tailscale Serve port ${port} because it is configured for another target`
            ),
            { statusCode: 409 }
        );
    }
    await runCommand("sudo", ["-n", "tailscale", "serve", `--https=${port}`, "off"]);
}
