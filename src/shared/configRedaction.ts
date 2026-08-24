/** Stable placeholder used for secret-bearing OpenClaw configuration values. */
export const CONFIG_REDACTION_SENTINEL = "__MIRA_DASHBOARD_REDACTED__";

const sensitiveCanonicalKeys = new Set([
    "apikey",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "gatewaytoken",
    "key",
    "passphrase",
    "password",
    "passwd",
    "privatekey",
    "raw",
    "seed",
    "secret",
    "signingkey",
    "token",
    "webhookurl",
]);
const sensitiveKeySuffixes = [
    "accesskey",
    "apikey",
    "authtoken",
    "clientsecret",
    "credential",
    "encryptionkey",
    "passphrase",
    "password",
    "privatekey",
    "secret",
    "secretkey",
    "signingkey",
    "token",
] as const;

function canonicalKey(key: string): string {
    return key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
}

/**
 * Whether a configuration key conventionally carries reusable secret material.
 * @param key Candidate configuration key.
 * @returns Whether the key matches the central secret-key policy.
 */
export function isSensitiveConfigKey(key: string): boolean {
    const canonical = canonicalKey(key);
    return (
        sensitiveCanonicalKeys.has(canonical) ||
        sensitiveKeySuffixes.some((suffix) => canonical.endsWith(suffix))
    );
}

/**
 * Deeply clones JSON-like configuration while replacing secrets with one sentinel.
 * @param value JSON-like configuration value.
 * @returns Secret-safe cloned configuration.
 */
export function redactConfigSecrets(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => redactConfigSecrets(entry));
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const redacted: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        redacted[key] = isSensitiveConfigKey(key)
            ? CONFIG_REDACTION_SENTINEL
            : redactConfigSecrets(nestedValue);
    }
    return redacted;
}

/**
 * Parses and masks JSON config text; invalid JSON has no secret-safe text view.
 * @param content Raw JSON configuration text.
 * @returns Pretty-printed redacted JSON, or undefined when parsing fails.
 */
export function redactConfigJsonText(content: string): string | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content) as unknown;
    } catch {
        return undefined;
    }
    return `${JSON.stringify(redactConfigSecrets(parsed), undefined, 2)}\n`;
}
