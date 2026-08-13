import { isIP } from "node:net";

import { minutesToMilliseconds } from "date-fns";
import { Redacted } from "effect";
import * as v from "valibot";

import { webAuthnRpIdSchema } from "../../../contracts/webauthn.ts";
import {
    applicationConfigurationLimits,
    configurationEnvironmentNamesForRole,
    type ApplicationConfigurationEnvironmentName,
} from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import { parseBrowserSessionIdleDurationMs } from "../../domains/security/authenticationPolicy.ts";
import { assertValidTotpEncryptionKeyRing } from "../../domains/security/mfa/totpSecretCipher.ts";
import {
    createWebAuthnRelyingPartyConfiguration,
    type WebAuthnRelyingPartyConfiguration,
} from "../../domains/security/mfa/webauthn/relyingPartyConfiguration.ts";
import { parseRecentAuthenticationWindowMs } from "../../domains/security/recentAuthentication.ts";
import { parseBrowserOrigin } from "../../rawHttp/requestSecurity.ts";
import {
    configurationGatewayToken,
    configurationGatewayUrl,
} from "./gatewayConfiguration.ts";
import {
    type ApplicationLogLevel,
    type ApplicationNodeEnvironment,
    configurationChoice,
    configurationError,
    configurationOpenClawRoot,
    configurationProjectRoot,
    configurationWebPort,
    configurationWorkspaceRoot,
    pickApplicationEnvironment,
    type PickedApplicationEnvironment,
    requiredConfigurationString,
} from "./processConfiguration.ts";

/** Immutable, validated configuration consumed by the greenfield web process. */
export interface WebConfiguration {
    readonly elevenLabsApiKey?: Redacted.Redacted<string>;
    readonly gatewayToken: Redacted.Redacted<string>;
    readonly gatewayUrl: string;
    readonly logLevel: ApplicationLogLevel;
    readonly nodeEnvironment: ApplicationNodeEnvironment;
    readonly openClawRoot: string;
    readonly port: number;
    readonly projectRoot: string;
    readonly publicOrigin: string;
    readonly recentAuthenticationWindowMs: number;
    readonly sessionIdleDurationMs: number;
    readonly totpKeyring: Redacted.Redacted<string>;
    readonly trustedProxyAddresses: readonly string[];
    readonly webAuthnRelyingParty: WebAuthnRelyingPartyConfiguration;
    readonly workspaceRoot: string;
}

const optionalEnvironmentValueSchema = v.optional(v.unknown());
const canonicalUnsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/u;

/** Valibot projection for the complete accepted web-process environment surface. */
export const webConfigurationEnvironmentSchema = v.object({
    ELEVENLABS_API_KEY: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_LOG_LEVEL: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_OPENCLAW_ROOT: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_PROJECT_ROOT: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_WORKSPACE_ROOT: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_PUBLIC_ORIGIN: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_RECENT_AUTH_MINUTES: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_SESSION_IDLE_MINUTES: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_TOTP_KEYRING: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_TRUSTED_PROXY_IPS: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_WEBAUTHN_ORIGINS: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_WEBAUTHN_RP_ID: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_WEBAUTHN_RP_NAME: optionalEnvironmentValueSchema,
    NODE_ENV: optionalEnvironmentValueSchema,
    OPENCLAW_GATEWAY_TOKEN: optionalEnvironmentValueSchema,
    OPENCLAW_GATEWAY_URL: optionalEnvironmentValueSchema,
    PORT: optionalEnvironmentValueSchema,
});

/** Registered environment names consumed by the web-process parser. */
export const webConfigurationEnvironmentNames =
    configurationEnvironmentNamesForRole("web");

function canonicalInteger(
    input: PickedApplicationEnvironment,
    field: ApplicationConfigurationEnvironmentName,
    minimum: number,
    maximum: number
): number {
    const value = requiredConfigurationString(input, field, 16);
    if (!canonicalUnsignedIntegerPattern.test(value)) {
        configurationError(field, "invalid");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        configurationError(field, "invalid");
    }
    return parsed;
}

function parseIpAddress(value: string): string | undefined {
    if (isIP(value) === 4) return value;
    if (isIP(value) !== 6) return undefined;
    const mappedIpv4 = /^::ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/iu.exec(value)?.[1];
    if (mappedIpv4 !== undefined && isIP(mappedIpv4) === 4) return mappedIpv4;
    try {
        return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
        return undefined;
    }
}

function trustedProxyAddresses(input: PickedApplicationEnvironment): readonly string[] {
    const field = "MIRA_DASHBOARD_TRUSTED_PROXY_IPS" as const;
    const raw = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.trustedProxyAddresses.maximumLength,
        true
    );
    if (raw.length === 0) return Object.freeze([]);
    const values = raw.split(",");
    if (
        values.length > applicationConfigurationLimits.trustedProxyAddresses.maximumItems
    ) {
        configurationError(field, "invalid");
    }
    const canonical = values.map((value) => {
        if (value.length === 0 || value !== value.trim()) {
            configurationError(field, "invalid");
        }
        return parseIpAddress(value) ?? configurationError(field, "invalid");
    });
    if (new Set(canonical).size !== canonical.length) {
        configurationError(field, "invalid");
    }
    return Object.freeze(canonical.toSorted());
}

function publicOrigin(input: PickedApplicationEnvironment): string {
    const field = "MIRA_DASHBOARD_PUBLIC_ORIGIN" as const;
    const value = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.publicOriginMaximumLength
    );
    try {
        return parseBrowserOrigin(value);
    } catch {
        return configurationError(field, "invalid");
    }
}

function webAuthnOrigins(input: PickedApplicationEnvironment): readonly string[] {
    const field = "MIRA_DASHBOARD_WEBAUTHN_ORIGINS" as const;
    const raw = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.webAuthnOrigins.maximumLength
    );
    const values = raw.split(",");
    if (
        values.length < applicationConfigurationLimits.webAuthnOrigins.minimumItems ||
        values.length > applicationConfigurationLimits.webAuthnOrigins.maximumItems
    ) {
        configurationError(field, "invalid");
    }
    for (const value of values) {
        if (value.length === 0 || value !== value.trim()) {
            configurationError(field, "invalid");
        }
    }
    if (new Set(values).size !== values.length) {
        configurationError(field, "invalid");
    }
    return Object.freeze(values);
}

function webAuthnRelyingPartyName(input: PickedApplicationEnvironment): string {
    const field = "MIRA_DASHBOARD_WEBAUTHN_RP_NAME" as const;
    const value = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.webAuthnRpNameMaximumLength
    );
    if (value.normalize("NFC") !== value) configurationError(field, "invalid");
    return value;
}

function webAuthnConfiguration(
    input: PickedApplicationEnvironment,
    origin: string
): WebAuthnRelyingPartyConfiguration {
    const rpIdField = "MIRA_DASHBOARD_WEBAUTHN_RP_ID" as const;
    const originsField = "MIRA_DASHBOARD_WEBAUTHN_ORIGINS" as const;
    const rpId = requiredConfigurationString(
        input,
        rpIdField,
        applicationConfigurationLimits.webAuthnRpIdMaximumLength
    );
    const rpName = webAuthnRelyingPartyName(input);
    const origins = webAuthnOrigins(input);

    if (!v.safeParse(webAuthnRpIdSchema, rpId, { abortEarly: true }).success) {
        configurationError(rpIdField, "invalid");
    }
    let configuration: WebAuthnRelyingPartyConfiguration;
    try {
        configuration = createWebAuthnRelyingPartyConfiguration({
            allowedOrigins: origins,
            rpId,
            rpName,
        });
    } catch {
        // RP ID and name have already passed the complete factory policy above;
        // construction failures at this point belong to the origin allowlist.
        return configurationError(originsField, "inconsistent");
    }
    if (!configuration.allowedOrigins.includes(origin)) {
        configurationError(originsField, "inconsistent");
    }
    return configuration;
}

function totpKeyring(input: PickedApplicationEnvironment): Redacted.Redacted<string> {
    const field = "MIRA_DASHBOARD_TOTP_KEYRING" as const;
    const raw = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.totpKeyringMaximumLength
    );
    try {
        assertValidTotpEncryptionKeyRing(raw);
    } catch {
        return configurationError(field, "invalid");
    }
    return Object.freeze(Redacted.make(raw, { label: "totp-keyring" }));
}

function elevenLabsApiKey(
    input: PickedApplicationEnvironment
): Redacted.Redacted<string> | undefined {
    const field = "ELEVENLABS_API_KEY" as const;
    if (input[field] === null || input[field] === undefined) return undefined;
    if (input[field] === "") return configurationError(field, "invalid");
    const raw = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.elevenLabsApiKeyMaximumLength
    );
    return Object.freeze(Redacted.make(raw, { label: "elevenlabs-api-key" }));
}

function durationMs(
    input: PickedApplicationEnvironment,
    field: "MIRA_DASHBOARD_RECENT_AUTH_MINUTES" | "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
    parsePolicy: (value: number) => number
): number {
    const limits =
        field === "MIRA_DASHBOARD_RECENT_AUTH_MINUTES"
            ? applicationConfigurationLimits.recentAuthenticationMinutes
            : applicationConfigurationLimits.sessionIdleMinutes;
    const minutes = canonicalInteger(input, field, limits.minimum, limits.maximum);
    try {
        return parsePolicy(minutesToMilliseconds(minutes));
    } catch {
        return configurationError(field, "invalid");
    }
}

/**
 * Parses an injected untrusted environment record into immutable web configuration.
 * Only registered names are observed; the source object is never modified.
 * @param source Untrusted injected environment-like record.
 * @returns Deeply frozen, domain-validated web configuration.
 * @throws {ApplicationConfigurationError} With only a field and stable reason.
 */
export function parseWebConfiguration(
    source: Readonly<Record<string, unknown>>
): WebConfiguration {
    const input = pickApplicationEnvironment(
        "web",
        webConfigurationEnvironmentNames,
        source,
        (projection) => v.parse(webConfigurationEnvironmentSchema, projection)
    );
    const nodeEnvironment = configurationChoice(input, "NODE_ENV", [
        "development",
        "production",
        "test",
    ] as const);
    const origin = publicOrigin(input);
    if (nodeEnvironment === "production" && new URL(origin).protocol !== "https:") {
        configurationError("MIRA_DASHBOARD_PUBLIC_ORIGIN", "inconsistent");
    }
    const speechApiKey = elevenLabsApiKey(input);
    const configuration = Object.freeze({
        ...(speechApiKey === undefined ? {} : { elevenLabsApiKey: speechApiKey }),
        gatewayToken: configurationGatewayToken(input),
        gatewayUrl: configurationGatewayUrl(input),
        logLevel: configurationChoice(input, "MIRA_DASHBOARD_LOG_LEVEL", [
            "debug",
            "error",
            "info",
            "warn",
        ] as const),
        nodeEnvironment,
        openClawRoot: configurationOpenClawRoot(input),
        port: configurationWebPort(input),
        projectRoot: configurationProjectRoot(input),
        publicOrigin: origin,
        recentAuthenticationWindowMs: durationMs(
            input,
            "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
            parseRecentAuthenticationWindowMs
        ),
        sessionIdleDurationMs: durationMs(
            input,
            "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
            parseBrowserSessionIdleDurationMs
        ),
        totpKeyring: totpKeyring(input),
        trustedProxyAddresses: trustedProxyAddresses(input),
        webAuthnRelyingParty: webAuthnConfiguration(input, origin),
        workspaceRoot: configurationWorkspaceRoot(input),
    } satisfies WebConfiguration);
    return configuration;
}
