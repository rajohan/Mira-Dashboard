import { Redacted } from "effect";

import { applicationConfigurationLimits } from "../../../shared/configuration/applicationConfigurationRegistry.ts";
import { parseGatewayCredentialVerifierUrl } from "../gateway/gatewayCredentialVerifier.ts";
import {
    configurationError,
    type PickedApplicationEnvironment,
    requiredConfigurationString,
} from "./processConfiguration.ts";

/**
 * Parses the canonical direct-loopback endpoint shared by Gateway-owning processes.
 * @param input Registry-projected process environment.
 * @returns Canonical direct-loopback WebSocket URL.
 */
export function configurationGatewayUrl(input: PickedApplicationEnvironment): string {
    const field = "OPENCLAW_GATEWAY_URL" as const;
    const value = requiredConfigurationString(
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

/**
 * Parses a server-only Gateway token without exposing its value to inspection or JSON.
 * @param input Registry-projected process environment.
 * @returns Frozen redacted Gateway credential.
 */
export function configurationGatewayToken(
    input: PickedApplicationEnvironment
): Redacted.Redacted<string> {
    const field = "OPENCLAW_GATEWAY_TOKEN" as const;
    const raw = requiredConfigurationString(
        input,
        field,
        applicationConfigurationLimits.gatewayTokenMaximumLength
    );
    return Object.freeze(Redacted.make(raw, { label: "gateway-token" }));
}
