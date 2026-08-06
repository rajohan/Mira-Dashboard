/** Process roles that consume immutable application configuration. */
export type ApplicationProcessRole = "build" | "script" | "web" | "worker";

/** Safe browser-facing representation of one configuration value. */
export type ConfigurationBrowserExposure = "none" | "presence-only" | "value";

/** Shared parser/documentation limits for immutable application configuration. */
export const applicationConfigurationLimits = Object.freeze({
    gatewayUrlMaximumLength: 2048,
    port: Object.freeze({ maximum: 65_535, minimum: 1 }),
    projectRootMaximumLength: 4096,
    publicOriginMaximumLength: 2048,
    recentAuthenticationMinutes: Object.freeze({ maximum: 60, minimum: 1 }),
    sessionIdleMinutes: Object.freeze({ maximum: 1440, minimum: 5 }),
    totpKeyringMaximumLength: 4096,
    trustedProxyAddresses: Object.freeze({ maximumItems: 32, maximumLength: 2048 }),
    webAuthnOrigins: Object.freeze({
        maximumItems: 8,
        maximumLength: 16_384,
        minimumItems: 1,
    }),
    webAuthnRpIdMaximumLength: 253,
    webAuthnRpNameMaximumLength: 128,
});

/** Stable field names used by typed server configuration. */
export type ApplicationConfigurationField =
    | "gatewayUrl"
    | "logLevel"
    | "nodeEnvironment"
    | "port"
    | "projectRoot"
    | "publicOrigin"
    | "recentAuthenticationWindowMs"
    | "sessionIdleDurationMs"
    | "totpKeyring"
    | "trustedProxyAddresses"
    | "webAuthnRelyingParty.allowedOrigins"
    | "webAuthnRelyingParty.rpId"
    | "webAuthnRelyingParty.rpName";

/** Registered environment names accepted by the application configuration parser. */
export const applicationConfigurationEnvironmentNames = [
    "NODE_ENV",
    "MIRA_DASHBOARD_PROJECT_ROOT",
    "PORT",
    "MIRA_DASHBOARD_PUBLIC_ORIGIN",
    "MIRA_DASHBOARD_TRUSTED_PROXY_IPS",
    "OPENCLAW_GATEWAY_URL",
    "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
    "MIRA_DASHBOARD_WEBAUTHN_ORIGINS",
    "MIRA_DASHBOARD_WEBAUTHN_RP_NAME",
    "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
    "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
    "MIRA_DASHBOARD_TOTP_KEYRING",
    "MIRA_DASHBOARD_LOG_LEVEL",
] as const;

export type ApplicationConfigurationEnvironmentName =
    (typeof applicationConfigurationEnvironmentNames)[number];

/** Complete documentation and operational policy for one environment field. */
export interface ApplicationConfigurationMetadata {
    readonly allowedValues: readonly string[] | null;
    readonly browserExposure: ConfigurationBrowserExposure;
    readonly defaultValue: string | null;
    readonly description: string;
    readonly environmentName: ApplicationConfigurationEnvironmentName;
    readonly field: ApplicationConfigurationField;
    readonly operationalEffect: string;
    readonly overridePolicy: {
        readonly development: boolean;
        readonly test: boolean;
    };
    readonly restartRequired: boolean;
    readonly roles: readonly ApplicationProcessRole[];
    readonly secret: boolean;
    readonly validationConstraints: string;
    readonly valueType:
        | "absolute-path"
        | "domain-name"
        | "duration-minutes"
        | "environment-mode"
        | "http-origin"
        | "http-origin-list"
        | "ip-address-list"
        | "json-secret"
        | "log-level"
        | "relying-party-name"
        | "tcp-port"
        | "websocket-url";
}

const allRoleOverrides = Object.freeze({ development: true, test: true });

function metadata(
    value: Omit<ApplicationConfigurationMetadata, "overridePolicy">
): ApplicationConfigurationMetadata {
    if (value.allowedValues !== null) Object.freeze(value.allowedValues);
    Object.freeze(value.roles);
    return Object.freeze({ ...value, overridePolicy: allRoleOverrides });
}

/**
 * Authoritative immutable registry for the first greenfield web-process configuration.
 * Generators consume this data rather than rediscovering environment reads from source.
 */
export const applicationConfigurationRegistry: readonly ApplicationConfigurationMetadata[] =
    Object.freeze([
        metadata({
            allowedValues: Object.freeze(["development", "production", "test"]),
            browserExposure: "value",
            defaultValue: "production",
            description: "Runtime mode used for fail-closed production trust policy.",
            environmentName: "NODE_ENV",
            field: "nodeEnvironment",
            operationalEffect:
                "Controls production-only security and diagnostic behavior.",
            restartRequired: true,
            roles: Object.freeze(["web", "worker", "build", "script"]),
            secret: false,
            validationConstraints: "Exactly one enumerated runtime mode.",
            valueType: "environment-mode",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "none",
            defaultValue: null,
            description:
                "Lexically normalized absolute Dashboard host-layout root; startup must resolve and validate its real directory before deriving managed paths.",
            environmentName: "MIRA_DASHBOARD_PROJECT_ROOT",
            field: "projectRoot",
            operationalEffect:
                "Selects the stable development, production-state, runtime, release, preview, and worktree hierarchy; it is not a checkout path.",
            restartRequired: true,
            roles: Object.freeze(["web", "worker", "build", "script"]),
            secret: false,
            validationConstraints: `Non-root normalized absolute path, at most ${applicationConfigurationLimits.projectRootMaximumLength} code units; realpath validation is staged for startup.`,
            valueType: "absolute-path",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "none",
            defaultValue: "3100",
            description: "Loopback HTTP listener port for the greenfield web process.",
            environmentName: "PORT",
            field: "port",
            operationalEffect:
                "Changes the local listener endpoint used by the reverse proxy.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: false,
            validationConstraints: `Canonical decimal integer from ${applicationConfigurationLimits.port.minimum} through ${applicationConfigurationLimits.port.maximum}.`,
            valueType: "tcp-port",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "value",
            defaultValue: null,
            description:
                "Canonical browser origin used for cookies and request-origin checks.",
            environmentName: "MIRA_DASHBOARD_PUBLIC_ORIGIN",
            field: "publicOrigin",
            operationalEffect:
                "Defines the browser trust boundary behind the reverse proxy.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: false,
            validationConstraints: `Canonical HTTP(S) origin at most ${applicationConfigurationLimits.publicOriginMaximumLength} code units; HTTPS is required in production.`,
            valueType: "http-origin",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "none",
            defaultValue: "",
            description: "Canonical comma-separated proxy peer IP allowlist.",
            environmentName: "MIRA_DASHBOARD_TRUSTED_PROXY_IPS",
            field: "trustedProxyAddresses",
            operationalEffect:
                "Allows overwritten forwarding headers only from exact peers.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: false,
            validationConstraints: `Zero to ${applicationConfigurationLimits.trustedProxyAddresses.maximumItems} unique canonical IP addresses, comma-separated, at most ${applicationConfigurationLimits.trustedProxyAddresses.maximumLength} code units.`,
            valueType: "ip-address-list",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "none",
            defaultValue: "ws://127.0.0.1:18789",
            description:
                "Direct-loopback OpenClaw Gateway endpoint for bootstrap verification.",
            environmentName: "OPENCLAW_GATEWAY_URL",
            field: "gatewayUrl",
            operationalEffect:
                "Selects the one-shot native Gateway verification endpoint.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: false,
            validationConstraints: `Canonical direct-loopback WebSocket URL at most ${applicationConfigurationLimits.gatewayUrlMaximumLength} code units.`,
            valueType: "websocket-url",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "value",
            defaultValue: null,
            description: "Stable WebAuthn relying-party domain identifier.",
            environmentName: "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
            field: "webAuthnRelyingParty.rpId",
            operationalEffect:
                "Binds every WebAuthn credential and ceremony to one RP ID.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: false,
            validationConstraints: `Lowercase canonical domain name at most ${applicationConfigurationLimits.webAuthnRpIdMaximumLength} code units.`,
            valueType: "domain-name",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "value",
            defaultValue: null,
            description: "Canonical comma-separated WebAuthn browser-origin allowlist.",
            environmentName: "MIRA_DASHBOARD_WEBAUTHN_ORIGINS",
            field: "webAuthnRelyingParty.allowedOrigins",
            operationalEffect: "Restricts WebAuthn ceremonies to reviewed HTTPS origins.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: false,
            validationConstraints: `${applicationConfigurationLimits.webAuthnOrigins.minimumItems} to ${applicationConfigurationLimits.webAuthnOrigins.maximumItems} unique canonical browser origins, comma-separated, at most ${applicationConfigurationLimits.webAuthnOrigins.maximumLength} code units.`,
            valueType: "http-origin-list",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "value",
            defaultValue: "Mira Dashboard",
            description: "Human-readable relying-party name shown by authenticators.",
            environmentName: "MIRA_DASHBOARD_WEBAUTHN_RP_NAME",
            field: "webAuthnRelyingParty.rpName",
            operationalEffect:
                "Changes the relying-party label in registration ceremonies.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: false,
            validationConstraints: `Trimmed NFC text without control characters, at most ${applicationConfigurationLimits.webAuthnRpNameMaximumLength} code units.`,
            valueType: "relying-party-name",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "value",
            defaultValue: "30",
            description: "Browser-session idle lifetime in whole minutes.",
            environmentName: "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
            field: "sessionIdleDurationMs",
            operationalEffect: "Controls when inactive browser sessions expire.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: false,
            validationConstraints: `Canonical whole minutes from ${applicationConfigurationLimits.sessionIdleMinutes.minimum} through ${applicationConfigurationLimits.sessionIdleMinutes.maximum}.`,
            valueType: "duration-minutes",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "value",
            defaultValue: "10",
            description: "Recent password or MFA verification window in whole minutes.",
            environmentName: "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
            field: "recentAuthenticationWindowMs",
            operationalEffect:
                "Controls step-up freshness for sensitive account operations.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: false,
            validationConstraints: `Canonical whole minutes from ${applicationConfigurationLimits.recentAuthenticationMinutes.minimum} through ${applicationConfigurationLimits.recentAuthenticationMinutes.maximum}.`,
            valueType: "duration-minutes",
        }),
        metadata({
            allowedValues: null,
            browserExposure: "presence-only",
            defaultValue: null,
            description: "Versioned AES-256-GCM keyring for persisted TOTP secrets.",
            environmentName: "MIRA_DASHBOARD_TOTP_KEYRING",
            field: "totpKeyring",
            operationalEffect: "Selects active and retained TOTP encryption keys.",
            restartRequired: true,
            roles: Object.freeze(["web"]),
            secret: true,
            validationConstraints: `Version 1 JSON with one to eight unique AES-256 keys and one active key, at most ${applicationConfigurationLimits.totpKeyringMaximumLength} code units.`,
            valueType: "json-secret",
        }),
        metadata({
            allowedValues: Object.freeze(["debug", "error", "info", "warn"]),
            browserExposure: "value",
            defaultValue: "info",
            description: "Minimum structured application log severity.",
            environmentName: "MIRA_DASHBOARD_LOG_LEVEL",
            field: "logLevel",
            operationalEffect: "Changes structured diagnostic verbosity.",
            restartRequired: true,
            roles: Object.freeze(["web", "worker", "script"]),
            secret: false,
            validationConstraints: "Exactly one enumerated structured-log level.",
            valueType: "log-level",
        }),
    ]);

/**
 * Returns registered environment names consumed by one process role.
 * @param role Application process role.
 * @returns Frozen registry-order projection for that role only.
 */
export function configurationEnvironmentNamesForRole(
    role: ApplicationProcessRole
): readonly ApplicationConfigurationEnvironmentName[] {
    return Object.freeze(
        applicationConfigurationRegistry
            .filter((entry) => entry.roles.includes(role))
            .map((entry) => entry.environmentName)
    );
}

/**
 * Returns the immutable registry entry for one accepted environment name.
 * @param environmentName Registered process-environment name.
 * @returns Immutable metadata for the field.
 */
export function configurationMetadata(
    environmentName: ApplicationConfigurationEnvironmentName
): ApplicationConfigurationMetadata {
    const entry = applicationConfigurationRegistry.find(
        (candidate) => candidate.environmentName === environmentName
    );
    if (entry === undefined) {
        throw new Error(
            `Application configuration registry is missing ${environmentName}`
        );
    }
    return entry;
}
