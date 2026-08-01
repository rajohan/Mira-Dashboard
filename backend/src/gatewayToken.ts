import { getPersistedGatewayToken } from "./auth.ts";

/**
 * Resolves the Gateway token consistently for every Dashboard integration.
 * Runtime environment configuration takes precedence over the encrypted DB
 * fallback, matching the production server startup contract.
 * @returns Configured Gateway token, or undefined when none is available.
 */
export function resolveGatewayToken(
    environment: NodeJS.ProcessEnv = process.env,
    persistedToken?: () => string | undefined
): string | undefined {
    return (
        environment.OPENCLAW_GATEWAY_TOKEN?.trim() ||
        (persistedToken ?? getPersistedGatewayToken)()?.trim() ||
        undefined
    );
}
