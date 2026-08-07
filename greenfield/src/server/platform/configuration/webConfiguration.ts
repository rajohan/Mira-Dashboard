import { isIP } from "node:net";
import path from "node:path";

import { minutesToMilliseconds } from "date-fns";
import { Redacted } from "effect";
import * as v from "valibot";

import { webAuthnRpIdSchema } from "../../../contracts/webauthn.ts";
import {
    applicationConfigurationLimits,
    configurationMetadata,
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
import { parseGatewayCredentialVerifierUrl } from "../gateway/gatewayCredentialVerifier.ts";
import {
    ApplicationConfigurationError,
    type ApplicationConfigurationFailureReason,
} from "./applicationConfigurationError.ts";

export type ApplicationNodeEnvironment = "development" | "production" | "test";
export type ApplicationLogLevel = "debug" | "error" | "info" | "warn";

/** Immutable, validated configuration consumed by the greenfield web process. */
export interface WebConfiguration {
    readonly gatewayUrl: string;
    readonly logLevel: ApplicationLogLevel;
    readonly nodeEnvironment: ApplicationNodeEnvironment;
    readonly port: number;
    readonly projectRoot: string;
    readonly publicOrigin: string;
    readonly recentAuthenticationWindowMs: number;
    readonly sessionIdleDurationMs: number;
    readonly totpKeyring: Redacted.Redacted<string>;
    readonly trustedProxyAddresses: readonly string[];
    readonly webAuthnRelyingParty: WebAuthnRelyingPartyConfiguration;
}

const unsafeTextPattern = /[\p{Cc}\p{Cf}]/u;
const canonicalUnsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/u;
const optionalEnvironmentValueSchema = v.optional(v.unknown());

/** Valibot projection for the complete accepted web-process environment surface. */
export const webConfigurationEnvironmentSchema = v.object({
    MIRA_DASHBOARD_LOG_LEVEL: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_PROJECT_ROOT: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_PUBLIC_ORIGIN: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_RECENT_AUTH_MINUTES: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_SESSION_IDLE_MINUTES: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_TOTP_KEYRING: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_TRUSTED_PROXY_IPS: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_WEBAUTHN_ORIGINS: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_WEBAUTHN_RP_ID: optionalEnvironmentValueSchema,
    MIRA_DASHBOARD_WEBAUTHN_RP_NAME: optionalEnvironmentValueSchema,
    NODE_ENV: optionalEnvironmentValueSchema,
    OPENCLAW_GATEWAY_URL: optionalEnvironmentValueSchema,
    PORT: optionalEnvironmentValueSchema,
});

/** Registered environment names consumed by the web-process parser. */
export const webConfigurationEnvironmentNames =
    configurationEnvironmentNamesForRole("web");

type PickedEnvironment = Readonly<
    Partial<Record<ApplicationConfigurationEnvironmentName, unknown>>
>;

function configurationError(
    field: ApplicationConfigurationEnvironmentName,
    reason: ApplicationConfigurationFailureReason
): never {
    throw new ApplicationConfigurationError(field, reason);
}

function pickEnvironment(source: Readonly<Record<string, unknown>>): PickedEnvironment {
    const sourceProjection = Object.create(null) as Record<string, unknown>;
    for (const environmentName of webConfigurationEnvironmentNames) {
        let descriptor: PropertyDescriptor | undefined;
        try {
            descriptor = Object.getOwnPropertyDescriptor(source, environmentName);
        } catch {
            configurationError(environmentName, "invalid");
        }
        if (descriptor === undefined) continue;
        if (!("value" in descriptor)) {
            configurationError(environmentName, "invalid");
        }
        sourceProjection[environmentName] = descriptor.value;
    }
    const projected = v.parse(webConfigurationEnvironmentSchema, sourceProjection);
    const picked = Object.create(null) as Record<
        ApplicationConfigurationEnvironmentName,
        unknown
    >;
    for (const environmentName of webConfigurationEnvironmentNames) {
        const supplied = projected[environmentName];
        const fallback = configurationMetadata(environmentName).defaultValue;
        picked[environmentName] = supplied === undefined ? fallback : supplied;
    }
    return picked;
}

function requiredString(
    input: PickedEnvironment,
    field: ApplicationConfigurationEnvironmentName,
    maximumLength: number,
    allowEmpty = false
): string {
    const value = input[field];
    if (value === null || value === undefined || value === "") {
        if (allowEmpty && value === "") return value;
        configurationError(field, "missing");
    }
    if (
        typeof value !== "string" ||
        value.length > maximumLength ||
        value !== value.trim() ||
        unsafeTextPattern.test(value)
    ) {
        configurationError(field, "invalid");
    }
    return value;
}

function choice<T extends string>(
    input: PickedEnvironment,
    field: ApplicationConfigurationEnvironmentName,
    choices: readonly T[]
): T {
    const value = requiredString(input, field, 32);
    if (!choices.includes(value as T)) configurationError(field, "invalid");
    return value as T;
}

function canonicalInteger(
    input: PickedEnvironment,
    field: ApplicationConfigurationEnvironmentName,
    minimum: number,
    maximum: number
): number {
    const value = requiredString(input, field, 16);
    if (!canonicalUnsignedIntegerPattern.test(value)) {
        configurationError(field, "invalid");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        configurationError(field, "invalid");
    }
    return parsed;
}

function projectRoot(input: PickedEnvironment): string {
    const field = "MIRA_DASHBOARD_PROJECT_ROOT" as const;
    const value = requiredString(
        input,
        field,
        applicationConfigurationLimits.projectRootMaximumLength
    );
    if (
        !path.isAbsolute(value) ||
        value === path.parse(value).root ||
        path.resolve(value) !== value
    ) {
        configurationError(field, "invalid");
    }
    return value;
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

function trustedProxyAddresses(input: PickedEnvironment): readonly string[] {
    const field = "MIRA_DASHBOARD_TRUSTED_PROXY_IPS" as const;
    const raw = requiredString(
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

function publicOrigin(input: PickedEnvironment): string {
    const field = "MIRA_DASHBOARD_PUBLIC_ORIGIN" as const;
    const value = requiredString(
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

function gatewayUrl(input: PickedEnvironment): string {
    const field = "OPENCLAW_GATEWAY_URL" as const;
    const value = requiredString(
        input,
        field,
        applicationConfigurationLimits.gatewayUrlMaximumLength
    );
    try {
        return parseGatewayCredentialVerifierUrl(value);
    } catch {
        return configurationError(field, "invalid");
    }
}

function webAuthnOrigins(input: PickedEnvironment): readonly string[] {
    const field = "MIRA_DASHBOARD_WEBAUTHN_ORIGINS" as const;
    const raw = requiredString(
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

function webAuthnRelyingPartyName(input: PickedEnvironment): string {
    const field = "MIRA_DASHBOARD_WEBAUTHN_RP_NAME" as const;
    const value = requiredString(
        input,
        field,
        applicationConfigurationLimits.webAuthnRpNameMaximumLength
    );
    if (value.normalize("NFC") !== value) configurationError(field, "invalid");
    return value;
}

function webAuthnConfiguration(
    input: PickedEnvironment,
    origin: string
): WebAuthnRelyingPartyConfiguration {
    const rpIdField = "MIRA_DASHBOARD_WEBAUTHN_RP_ID" as const;
    const originsField = "MIRA_DASHBOARD_WEBAUTHN_ORIGINS" as const;
    const rpId = requiredString(
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

function totpKeyring(input: PickedEnvironment): Redacted.Redacted<string> {
    const field = "MIRA_DASHBOARD_TOTP_KEYRING" as const;
    const raw = requiredString(
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

function durationMs(
    input: PickedEnvironment,
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
    const input = pickEnvironment(source);
    const nodeEnvironment = choice(input, "NODE_ENV", [
        "development",
        "production",
        "test",
    ] as const);
    const origin = publicOrigin(input);
    if (nodeEnvironment === "production" && new URL(origin).protocol !== "https:") {
        configurationError("MIRA_DASHBOARD_PUBLIC_ORIGIN", "inconsistent");
    }
    const configuration = Object.freeze({
        gatewayUrl: gatewayUrl(input),
        logLevel: choice(input, "MIRA_DASHBOARD_LOG_LEVEL", [
            "debug",
            "error",
            "info",
            "warn",
        ] as const),
        nodeEnvironment,
        port: canonicalInteger(
            input,
            "PORT",
            applicationConfigurationLimits.port.minimum,
            applicationConfigurationLimits.port.maximum
        ),
        projectRoot: projectRoot(input),
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
    } satisfies WebConfiguration);
    return configuration;
}
