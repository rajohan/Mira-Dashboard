import { isIP } from "node:net";

import type { DevelopmentProxyConfiguration } from "./developmentProxy.ts";

const defaultFrontendPort = 3205;
const defaultBackendPort = 3206;
const defaultRemoteProxyPort = 3207;
const stableDnsNamePattern =
    /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/u;

export interface DevelopmentFrontendConfiguration extends DevelopmentProxyConfiguration {
    readonly host: "127.0.0.1";
    readonly hotReload: boolean;
    readonly ingressSocket?: string;
    readonly port: number;
    readonly remoteProxyPort?: number;
}

function configuredPort(
    name: string,
    value: string | undefined,
    fallback: number
): number {
    const configured = value?.trim();
    if (configured === undefined || configured === "") return fallback;
    if (!/^\d+$/u.test(configured)) {
        throw new TypeError(`${name} must be an integer between 1 and 65535`);
    }
    const port = Number(configured);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError(`${name} must be an integer between 1 and 65535`);
    }
    return port;
}

function loopbackApiTarget(value: string | undefined): Readonly<{
    port: number;
    target: string;
}> {
    const configured = value?.trim() || `http://127.0.0.1:${defaultBackendPort}`;
    const match = configured.match(/^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/u);
    if (match === null) {
        throw new TypeError(
            "DASHBOARD_API_TARGET must be an explicit loopback HTTP origin"
        );
    }
    const port = configuredPort(
        "DASHBOARD_API_TARGET port",
        match[1],
        defaultBackendPort
    );
    return Object.freeze({ port, target: `http://127.0.0.1:${port}` });
}

function publicOrigin(value: string | undefined, frontendPort: number): string {
    let origin: URL;
    try {
        origin = new URL(value?.trim() || `http://localhost:${frontendPort}`);
    } catch {
        throw new TypeError("MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN must be a valid URL");
    }
    const hostname = origin.hostname.toLowerCase();
    const localhost = hostname === "localhost" || hostname.endsWith(".localhost");
    if (
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && localhost)) ||
        origin.username !== "" ||
        origin.password !== "" ||
        origin.pathname !== "/" ||
        origin.search !== "" ||
        origin.hash !== "" ||
        hostname.length > 253 ||
        isIP(hostname) !== 0 ||
        !stableDnsNamePattern.test(hostname)
    ) {
        throw new TypeError(
            "Development public origin must be HTTPS or localhost HTTP on a stable DNS name"
        );
    }
    return origin.origin;
}

function hotReloadFlag(value: string | undefined): boolean {
    const configured = value?.trim();
    if (configured === undefined || configured === "" || configured === "1") return true;
    if (configured === "0") return false;
    throw new TypeError("MIRA_DASHBOARD_DEV_HOT_RELOAD must be 0 or 1");
}

/**
 * Validates the complete standalone Bun frontend environment before opening a listener.
 * @param environment Raw frontend child environment.
 * @returns Immutable loopback listener and proxy configuration.
 */
export function resolveDevelopmentFrontendConfiguration(
    environment: Readonly<Record<string, string | undefined>> = process.env
): DevelopmentFrontendConfiguration {
    const host = environment.HOST?.trim() || "127.0.0.1";
    if (host !== "127.0.0.1") {
        throw new TypeError("Dashboard development frontend must bind to 127.0.0.1");
    }
    const port = configuredPort("PORT", environment.PORT, defaultFrontendPort);
    const api = loopbackApiTarget(environment.DASHBOARD_API_TARGET);
    const ingressSocket = environment.MIRA_DASHBOARD_DEV_INGRESS_SOCKET?.trim();
    if (
        ingressSocket !== undefined &&
        ingressSocket !== "" &&
        ingressSocket !== "/run/mira-preview/ingress/preview.sock"
    ) {
        throw new TypeError("Managed Preview ingress socket is invalid");
    }
    const resolvedPublicOrigin = publicOrigin(
        environment.MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN,
        port
    );
    const remoteProxyPort = resolvedPublicOrigin.startsWith("https://")
        ? configuredPort(
              "MIRA_DASHBOARD_DEV_REMOTE_PROXY_PORT",
              environment.MIRA_DASHBOARD_DEV_REMOTE_PROXY_PORT,
              defaultRemoteProxyPort
          )
        : undefined;
    if (api.port === port || remoteProxyPort === port || remoteProxyPort === api.port) {
        throw new TypeError(
            "Development frontend, backend, and remote proxy ports must differ"
        );
    }
    const cookieNamespace =
        environment.MIRA_DASHBOARD_DEV_COOKIE_NAMESPACE?.trim() ||
        `__Host-mira_dashboard_dev_${port}`;
    if (!/^__Host-[A-Za-z0-9_]{1,96}$/u.test(cookieNamespace)) {
        throw new TypeError("Development cookie namespace is invalid");
    }
    return Object.freeze({
        apiTarget: api.target,
        cookieNamespace,
        host,
        hotReload: hotReloadFlag(environment.MIRA_DASHBOARD_DEV_HOT_RELOAD),
        ...(ingressSocket ? { ingressSocket } : {}),
        port,
        publicOrigin: resolvedPublicOrigin,
        ...(remoteProxyPort === undefined ? {} : { remoteProxyPort }),
    });
}
