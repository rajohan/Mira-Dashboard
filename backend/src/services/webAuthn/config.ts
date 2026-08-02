const RP_ID_PATTERN =
    /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/u;

export interface WebAuthnConfig {
    expectedOrigins: string[];
    rpId: string;
    rpName: string;
}

function isIpv4Hostname(hostname: string): boolean {
    const octets = hostname.split(".");
    return (
        octets.length === 4 &&
        octets.every((octet) => /^\d{1,3}$/u.test(octet)) &&
        octets.every((octet) => Number(octet) <= 255)
    );
}

function normalizeRpId(value: string | undefined): string {
    const rpId = value?.trim().toLowerCase();
    if (!rpId || rpId.length > 253 || !RP_ID_PATTERN.test(rpId) || isIpv4Hostname(rpId)) {
        throw new TypeError(
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID must be a stable DNS hostname"
        );
    }
    return rpId;
}

function normalizeOrigins(value: string | undefined, rpId: string): string[] {
    const configured = value
        ?.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
    if (!configured?.length) {
        throw new TypeError(
            "MIRA_DASHBOARD_WEBAUTHN_ORIGINS must contain at least one explicit origin"
        );
    }
    const normalized = new Set<string>();
    for (const configuredOrigin of configured) {
        let parsed: URL;
        try {
            parsed = new URL(configuredOrigin);
        } catch {
            throw new TypeError(`Invalid WebAuthn origin: ${configuredOrigin}`);
        }
        const isLocalDevelopment =
            parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost");
        const hasValidProtocol =
            parsed.protocol === "https:" ||
            (isLocalDevelopment && parsed.protocol === "http:");
        if (
            !hasValidProtocol ||
            parsed.username ||
            parsed.password ||
            (parsed.pathname !== "/" && parsed.pathname !== "") ||
            parsed.search ||
            parsed.hash
        ) {
            throw new TypeError(
                `WebAuthn origin must be an HTTPS origin without a path: ${configuredOrigin}`
            );
        }
        const hostname = parsed.hostname.toLowerCase();
        if (hostname !== rpId && !hostname.endsWith(`.${rpId}`)) {
            throw new TypeError(
                `WebAuthn origin ${parsed.origin} is outside RP ID ${rpId}`
            );
        }
        normalized.add(parsed.origin);
    }
    return [...normalized];
}

/**
 * Resolves the explicit, origin-bound WebAuthn relying-party configuration.
 * @returns Resolved the explicit, origin-bound WebAuthn relying-party configuration.
 */
export function webAuthnConfig(
    environment: Record<string, string | undefined> = process.env
): WebAuthnConfig {
    const rpId = normalizeRpId(environment.MIRA_DASHBOARD_WEBAUTHN_RP_ID);
    return {
        expectedOrigins: normalizeOrigins(
            environment.MIRA_DASHBOARD_WEBAUTHN_ORIGINS,
            rpId
        ),
        rpId,
        rpName: "Mira Dashboard",
    };
}
