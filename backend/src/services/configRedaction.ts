export const CONFIG_REDACTION_SENTINEL = "__MIRA_DASHBOARD_REDACTED__";

const SENSITIVE_CANONICAL_KEYS = new Set([
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
const SENSITIVE_KEY_SUFFIXES = [
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

/** Returns whether a config key conventionally carries reusable secret material. */
export function isSensitiveConfigKey(key: string): boolean {
    const canonical = canonicalKey(key);
    return (
        SENSITIVE_CANONICAL_KEYS.has(canonical) ||
        SENSITIVE_KEY_SUFFIXES.some(
            (suffix) => canonical.length > suffix.length && canonical.endsWith(suffix)
        )
    );
}

/** Deeply clones JSON-like config while replacing secret values with one sentinel. */
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

/** Detects an attempted write-back of a masked placeholder. */
export function hasConfigRedactionSentinel(value: unknown): boolean {
    if (value === CONFIG_REDACTION_SENTINEL) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.some((entry) => hasConfigRedactionSentinel(entry));
    }
    if (!value || typeof value !== "object") {
        return false;
    }
    return Object.values(value as Record<string, unknown>).some((entry) =>
        hasConfigRedactionSentinel(entry)
    );
}

/**
 * Replaces masked placeholders in a submitted partial config with the
 * corresponding server-side values. Missing originals remain sentinels and
 * are rejected by the caller.
 */
export function restoreConfigRedactionSentinels(
    submitted: unknown,
    current: unknown
): unknown {
    if (submitted === CONFIG_REDACTION_SENTINEL) {
        return current === undefined ? CONFIG_REDACTION_SENTINEL : current;
    }
    if (Array.isArray(submitted)) {
        const currentEntries = Array.isArray(current) ? current : [];
        return submitted.map((entry, index) =>
            restoreConfigRedactionSentinels(entry, currentEntries[index])
        );
    }
    if (!submitted || typeof submitted !== "object") {
        return submitted;
    }
    const currentRecord =
        current && typeof current === "object" && !Array.isArray(current)
            ? (current as Record<string, unknown>)
            : {};
    return Object.fromEntries(
        Object.entries(submitted as Record<string, unknown>).map(([key, value]) => [
            key,
            restoreConfigRedactionSentinels(value, currentRecord[key]),
        ])
    );
}

/** Parses and masks JSON config text; invalid JSON is never returned as a secret-safe view. */
export function redactConfigJsonText(content: string): string | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content) as unknown;
    } catch {
        return undefined;
    }
    return `${JSON.stringify(redactConfigSecrets(parsed), undefined, 2)}\n`;
}
