import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

const defaultFrontendPort = 3205;
const defaultBackendPort = 3206;
const defaultRemoteProxyPort = 3207;
const defaultTailscalePort = 3445;
const defaultGatewayUrl = "ws://127.0.0.1:18789/";
const rpIdPattern =
    /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/u;

export interface DevelopmentStackConfig {
    readonly apiTarget: string;
    readonly backendHost: "127.0.0.1";
    readonly backendPort: number;
    readonly databasePath: string;
    readonly frontendHost: "127.0.0.1";
    readonly frontendPort: number;
    readonly gatewayTokenFile?: string;
    readonly gatewayUrl: string;
    readonly hotReload: boolean;
    readonly keyringPath: string;
    readonly openClawRoot: string;
    readonly publicOrigin: string;
    readonly remoteProxyPort: number;
    readonly repositoryRoot: string;
    readonly rpId: string;
    readonly stateOwner: string;
    readonly stateRoot: string;
    readonly tailscalePort: number;
    readonly workspaceRoot: string;
}

export interface ManagedPreviewStackConfig extends DevelopmentStackConfig {
    readonly gatewaySocket: string;
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

function absoluteNonRootPath(
    name: string,
    value: string | undefined,
    fallback?: string
): string | undefined {
    const configured = value?.trim() || fallback;
    if (configured === undefined) return;
    if (!path.isAbsolute(configured)) throw new TypeError(`${name} must be absolute`);
    const resolved = path.resolve(configured);
    if (resolved === path.parse(resolved).root) {
        throw new TypeError(`${name} must not be a filesystem root`);
    }
    return resolved;
}

function pathContains(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate);
    return (
        relative === "" ||
        (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
    );
}

function pathsOverlap(left: string, right: string): boolean {
    return pathContains(left, right) || pathContains(right, left);
}

function defaultDevelopmentStateRoot(
    environment: Readonly<Record<string, string | undefined>>,
    repositoryRoot: string,
    hostProjectRoot: string
): string {
    const projectStateRoot = path.join(
        hostProjectRoot,
        "development",
        "state",
        "source-local"
    );
    if (!pathsOverlap(repositoryRoot, projectStateRoot)) return projectStateRoot;
    const xdgStateRoot = absoluteNonRootPath(
        "XDG_STATE_HOME",
        environment.XDG_STATE_HOME,
        path.join(os.homedir(), ".local", "state")
    );
    if (xdgStateRoot === undefined) throw new Error("XDG state root is missing");
    const fallback = path.join(
        xdgStateRoot,
        "mira-dashboard",
        "development",
        "source-local"
    );
    if (pathsOverlap(repositoryRoot, fallback)) {
        throw new TypeError(
            "MIRA_DASHBOARD_DEV_STATE_ROOT must be configured outside the repository"
        );
    }
    return fallback;
}

function configurationFlag(name: string, value: string | undefined): boolean {
    const configured = value?.trim();
    if (configured === undefined || configured === "" || configured === "1") {
        return true;
    }
    if (configured === "0") return false;
    throw new TypeError(`${name} must be 0 or 1`);
}

function publicOrigin(value: string | undefined, frontendPort: number): URL {
    let origin: URL;
    try {
        origin = new URL(value?.trim() || `http://localhost:${frontendPort}`);
    } catch {
        throw new TypeError("MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN must be a valid URL");
    }
    const localhost =
        origin.hostname === "localhost" || origin.hostname.endsWith(".localhost");
    if (
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && localhost)) ||
        origin.username !== "" ||
        origin.password !== "" ||
        (origin.pathname !== "" && origin.pathname !== "/") ||
        origin.search !== "" ||
        origin.hash !== "" ||
        isIP(origin.hostname) !== 0
    ) {
        throw new TypeError(
            "Development public origin must be HTTPS or localhost HTTP on a stable DNS name"
        );
    }
    return origin;
}

function gatewayUrl(value: string | undefined): string {
    let url: URL;
    try {
        url = new URL(value?.trim() || defaultGatewayUrl);
    } catch {
        throw new TypeError("MIRA_DASHBOARD_DEV_GATEWAY_URL must be a loopback URL");
    }
    if (
        url.protocol !== "ws:" ||
        (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
        url.port === "" ||
        url.pathname !== "/" ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
    ) {
        throw new TypeError("MIRA_DASHBOARD_DEV_GATEWAY_URL must be a loopback URL");
    }
    return url.href;
}

/**
 * Resolves one isolated source-watched Dashboard development stack.
 * @param environment Raw configuration environment.
 * @param repositoryRoot Absolute self-contained source root.
 * @returns Validated immutable development stack configuration.
 */
export function resolveDevelopmentStackConfig(
    environment: Readonly<Record<string, string | undefined>>,
    repositoryRoot: string
): DevelopmentStackConfig {
    const root = path.resolve(repositoryRoot);
    const frontendPort = configuredPort(
        "MIRA_DASHBOARD_DEV_FRONTEND_PORT",
        environment.MIRA_DASHBOARD_DEV_FRONTEND_PORT,
        defaultFrontendPort
    );
    const backendPort = configuredPort(
        "MIRA_DASHBOARD_DEV_BACKEND_PORT",
        environment.MIRA_DASHBOARD_DEV_BACKEND_PORT,
        defaultBackendPort
    );
    const remoteProxyPort = configuredPort(
        "MIRA_DASHBOARD_DEV_REMOTE_PROXY_PORT",
        environment.MIRA_DASHBOARD_DEV_REMOTE_PROXY_PORT,
        defaultRemoteProxyPort
    );
    const tailscalePort = configuredPort(
        "MIRA_DASHBOARD_DEV_TAILSCALE_PORT",
        environment.MIRA_DASHBOARD_DEV_TAILSCALE_PORT,
        defaultTailscalePort
    );
    if (new Set([frontendPort, backendPort, remoteProxyPort, tailscalePort]).size !== 4) {
        throw new TypeError(
            "Development frontend, backend, remote proxy, and Tailscale ports must differ"
        );
    }
    const hostProjectRoot = absoluteNonRootPath(
        "MIRA_DASHBOARD_PROJECT_ROOT",
        environment.MIRA_DASHBOARD_PROJECT_ROOT,
        path.join(os.homedir(), "projects", "mira-dashboard")
    );
    if (hostProjectRoot === undefined)
        throw new Error("Dashboard project root is missing");
    const configuredStateRoot = environment.MIRA_DASHBOARD_DEV_STATE_ROOT?.trim();
    const stateRoot = absoluteNonRootPath(
        "MIRA_DASHBOARD_DEV_STATE_ROOT",
        configuredStateRoot,
        configuredStateRoot
            ? undefined
            : defaultDevelopmentStateRoot(environment, root, hostProjectRoot)
    );
    if (stateRoot === undefined) throw new Error("Development state root is missing");
    const origin = publicOrigin(
        environment.MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN,
        frontendPort
    );
    const rpId = origin.hostname.toLowerCase();
    if (rpId.length > 253 || !rpIdPattern.test(rpId)) {
        throw new TypeError("Development WebAuthn relying-party id is invalid");
    }
    return Object.freeze({
        apiTarget: `http://127.0.0.1:${backendPort}`,
        backendHost: "127.0.0.1",
        backendPort,
        databasePath: path.join(stateRoot, "production", "state", "mira-dashboard.db"),
        frontendHost: "127.0.0.1",
        frontendPort,
        gatewayTokenFile: absoluteNonRootPath(
            "MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE",
            environment.MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE
        ),
        gatewayUrl: gatewayUrl(environment.MIRA_DASHBOARD_DEV_GATEWAY_URL),
        hotReload: configurationFlag(
            "MIRA_DASHBOARD_DEV_HOT_RELOAD",
            environment.MIRA_DASHBOARD_DEV_HOT_RELOAD
        ),
        keyringPath: path.join(stateRoot, "totp-keyring.json"),
        openClawRoot: path.join(stateRoot, "openclaw-home"),
        publicOrigin: origin.origin,
        remoteProxyPort,
        repositoryRoot: root,
        rpId,
        stateOwner: "mira-dashboard-source-development-v1",
        stateRoot,
        tailscalePort,
        workspaceRoot: path.join(stateRoot, "workspace"),
    });
}

/**
 * Resolves the explicit sandbox-only preview profile without copying ambient secrets.
 * @param environment Scrubbed Bubblewrap environment.
 * @param repositoryRoot Read-only candidate worktree root.
 * @returns Validated managed-preview stack configuration.
 */
export function resolveManagedPreviewStackConfig(
    environment: Readonly<Record<string, string | undefined>>,
    repositoryRoot: string
): ManagedPreviewStackConfig {
    const stateRoot = absoluteNonRootPath(
        "MIRA_DASHBOARD_DEV_STATE_ROOT",
        environment.MIRA_DASHBOARD_DEV_STATE_ROOT
    );
    const gatewaySocket = absoluteNonRootPath(
        "MIRA_DASHBOARD_DEV_GATEWAY_SOCKET",
        environment.MIRA_DASHBOARD_DEV_GATEWAY_SOCKET
    );
    const configuredOrigin = environment.MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN?.trim();
    if (
        stateRoot === undefined ||
        gatewaySocket === undefined ||
        configuredOrigin === undefined ||
        configuredOrigin === "" ||
        gatewaySocket !== "/run/mira-preview/gateway/gateway.sock"
    ) {
        throw new TypeError("Managed preview configuration is invalid");
    }
    const config = resolveDevelopmentStackConfig(
        {
            MIRA_DASHBOARD_DEV_BACKEND_PORT: "3206",
            MIRA_DASHBOARD_DEV_FRONTEND_PORT: "3205",
            MIRA_DASHBOARD_DEV_GATEWAY_URL: "ws://127.0.0.1:9/",
            MIRA_DASHBOARD_DEV_HOT_RELOAD: "0",
            MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: configuredOrigin,
            MIRA_DASHBOARD_DEV_REMOTE_PROXY_PORT: "3207",
            MIRA_DASHBOARD_DEV_STATE_ROOT: stateRoot,
            MIRA_DASHBOARD_DEV_TAILSCALE_PORT: "3445",
            MIRA_DASHBOARD_PROJECT_ROOT: "/state/project-authority-unavailable",
        },
        repositoryRoot
    );
    if (config.hotReload || config.stateRoot !== stateRoot) {
        throw new TypeError("Managed preview configuration is invalid");
    }
    return Object.freeze({ ...config, gatewaySocket });
}
