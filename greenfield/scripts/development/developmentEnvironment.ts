import { readDevelopmentPrivateFile } from "./developmentPrivateFile.ts";
import type { DevelopmentStackConfig } from "./developmentStackConfig.ts";

const inheritedEnvironmentNames = [
    "COLORTERM",
    "FORCE_COLOR",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "TERM",
    "TMPDIR",
    "TZ",
] as const;

function inheritedChildEnvironment(
    environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
    const inherited: Record<string, string> = {};
    for (const name of inheritedEnvironmentNames) {
        const value = environment[name];
        if (value !== undefined) inherited[name] = value;
    }
    return inherited;
}

async function gatewayToken(
    config: DevelopmentStackConfig,
    environment: Readonly<Record<string, string | undefined>>
): Promise<string> {
    let token: string | undefined;
    if (config.gatewayTokenFile === undefined) {
        token = environment.OPENCLAW_GATEWAY_TOKEN?.trim();
    } else {
        let tokenFileContents: string;
        try {
            tokenFileContents = await readDevelopmentPrivateFile(
                config.gatewayTokenFile,
                { forbiddenModeBits: 0o077, maximumBytes: 4097 }
            );
        } catch (error) {
            throw new Error("Development Gateway token file is invalid", {
                cause: error,
            });
        }
        token = tokenFileContents.trim();
    }
    if (
        token === undefined ||
        token === "" ||
        token.length > 4096 ||
        /[\p{Cc}\p{Cf}]/u.test(token)
    ) {
        throw new Error(
            "Dashboard dev requires OPENCLAW_GATEWAY_TOKEN or MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE"
        );
    }
    return token;
}

function moltbookApiKey(
    environment: Readonly<Record<string, string | undefined>>
): string {
    const value = environment.MOLTBOOK_API_KEY;
    if (value === undefined) {
        throw new Error("Dashboard dev requires MOLTBOOK_API_KEY");
    }
    return value;
}

function optionalConfiguration(
    target: Record<string, string>,
    environment: Readonly<Record<string, string | undefined>>,
    name:
        | "MIRA_DASHBOARD_LOG_LEVEL"
        | "MIRA_DASHBOARD_RECENT_AUTH_MINUTES"
        | "MIRA_DASHBOARD_SESSION_IDLE_MINUTES"
): void {
    const value = environment[name];
    if (value !== undefined) target[name] = value;
}

/**
 * Creates the explicit secret-minimized web and worker child environments.
 * @param config Validated development stack configuration.
 * @param serializedKeyring Isolated development TOTP keyring.
 * @param environment Source environment from which reviewed values are copied.
 * @returns Separate minimized environments for the web and worker children.
 */
export async function developmentProcessEnvironments(
    config: DevelopmentStackConfig,
    serializedKeyring: string,
    environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<Readonly<{ web: Record<string, string>; worker: Record<string, string> }>> {
    const token = await gatewayToken(config, environment);
    const moltbookCredential = moltbookApiKey(environment);
    const shared = {
        ...inheritedChildEnvironment(environment),
        MIRA_DASHBOARD_OPENCLAW_ROOT: config.openClawRoot,
        MIRA_DASHBOARD_PROJECT_ROOT: config.stateRoot,
        MIRA_DASHBOARD_WORKSPACE_ROOT: config.workspaceRoot,
        NODE_ENV: "development",
        OPENCLAW_GATEWAY_URL: config.gatewayUrl,
    };
    const web: Record<string, string> = {
        ...shared,
        MIRA_DASHBOARD_PUBLIC_ORIGIN: config.publicOrigin,
        MIRA_DASHBOARD_TOTP_KEYRING: serializedKeyring,
        MIRA_DASHBOARD_TRUSTED_PROXY_IPS: "127.0.0.1,::1",
        MIRA_DASHBOARD_WEBAUTHN_ORIGINS: config.publicOrigin,
        MIRA_DASHBOARD_WEBAUTHN_RP_ID: config.rpId,
        MIRA_DASHBOARD_WEBAUTHN_RP_NAME: "Mira Dashboard Development",
        OPENCLAW_GATEWAY_TOKEN: token,
        PORT: String(config.backendPort),
    };
    const worker: Record<string, string> = {
        ...shared,
        MOLTBOOK_API_KEY: moltbookCredential,
        OPENCLAW_GATEWAY_TOKEN: "source-development-no-gateway-credential",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9/",
    };
    const moltbookAgentName = environment.MOLTBOOK_AGENT_NAME;
    if (moltbookAgentName !== undefined) {
        worker.MOLTBOOK_AGENT_NAME = moltbookAgentName;
    }
    for (const name of [
        "MIRA_DASHBOARD_LOG_LEVEL",
        "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
        "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
    ] as const) {
        optionalConfiguration(web, environment, name);
        if (name === "MIRA_DASHBOARD_LOG_LEVEL") {
            optionalConfiguration(worker, environment, name);
        }
    }
    return Object.freeze({ web, worker });
}

/**
 * Creates the credential-free child environments used only by a managed PR preview.
 * Sentinel values satisfy the ordinary process parsers but grant no external authority;
 * the web process receives its sole Gateway capability through the mounted Unix socket.
 * @param config Validated managed-preview stack configuration.
 * @param serializedKeyring Ephemeral preview-local session keyring.
 * @returns Exact credential-free web and worker child environments.
 */
export function managedPreviewProcessEnvironments(
    config: DevelopmentStackConfig,
    serializedKeyring: string
): Readonly<{ web: Record<string, string>; worker: Record<string, string> }> {
    const shared = {
        HOME: "/home/preview",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        MIRA_DASHBOARD_OPENCLAW_ROOT: config.openClawRoot,
        MIRA_DASHBOARD_PROJECT_ROOT: config.stateRoot,
        MIRA_DASHBOARD_WORKSPACE_ROOT: config.workspaceRoot,
        NODE_ENV: "development",
        OPENCLAW_GATEWAY_TOKEN: "managed-preview-no-bearer-credential",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9/",
        PATH: "/usr/bin:/bin",
    };
    return Object.freeze({
        web: {
            ...shared,
            MIRA_DASHBOARD_PUBLIC_ORIGIN: config.publicOrigin,
            MIRA_DASHBOARD_TOTP_KEYRING: serializedKeyring,
            MIRA_DASHBOARD_TRUSTED_PROXY_IPS: "127.0.0.1,::1",
            MIRA_DASHBOARD_WEBAUTHN_ORIGINS: config.publicOrigin,
            MIRA_DASHBOARD_WEBAUTHN_RP_ID: config.rpId,
            MIRA_DASHBOARD_WEBAUTHN_RP_NAME: "Mira Dashboard PR Preview",
            PORT: String(config.backendPort),
        },
        worker: {
            ...shared,
            MOLTBOOK_API_KEY: "managed-preview-no-moltbook-credential",
        },
    });
}

/**
 * Creates the explicit Bun HTML/HMR proxy child environment.
 * @param config Validated development stack configuration.
 * @param environment Source environment from which reviewed values are copied.
 * @returns A minimized frontend child environment.
 */
export function developmentFrontendEnvironment(
    config: DevelopmentStackConfig,
    environment: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
    const frontendEnvironment: Record<string, string> = {
        ...inheritedChildEnvironment(environment),
        DASHBOARD_API_TARGET: config.apiTarget,
        HOST: config.frontendHost,
        MIRA_DASHBOARD_DEV_COOKIE_NAMESPACE: `__Host-mira_dashboard_dev_${config.frontendPort}`,
        MIRA_DASHBOARD_DEV_HOT_RELOAD: config.hotReload ? "1" : "0",
        MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: config.publicOrigin,
        PORT: String(config.frontendPort),
    };
    if (config.publicOrigin.startsWith("https://")) {
        frontendEnvironment.MIRA_DASHBOARD_DEV_REMOTE_PROXY_PORT = String(
            config.remoteProxyPort
        );
    }
    return frontendEnvironment;
}
