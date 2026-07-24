export const AUTOMATION_SCOPES = [
    "agents:read",
    "agents:write",
    "audit:read",
    "cache:read",
    "notifications:read",
    "notifications:write",
    "reports:read",
    "reports:write",
    "tasks:read",
    "tasks:write",
] as const;

export type AutomationScope = (typeof AUTOMATION_SCOPES)[number];

export interface AutomationPrincipal {
    id: string;
    scopes: ReadonlySet<AutomationScope>;
}

export type AutomationAuthentication =
    | { kind: "absent" }
    | { kind: "invalid" }
    | { kind: "authenticated"; principal: AutomationPrincipal };

interface AutomationCredentialConfig {
    id: string;
    scopes: AutomationScope[];
    tokenHash: string;
}

const MAX_AUTOMATION_CREDENTIALS = 32;
const MAX_SCOPES_PER_CREDENTIAL = AUTOMATION_SCOPES.length;
const AUTOMATION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TOKEN_HASH_RE = /^[a-f0-9]{64}$/u;
const TOKEN_RE = /^([a-z0-9][a-z0-9._-]{0,63})\.([a-f0-9]{64})$/u;
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const KNOWN_SCOPES = new Set<string>(AUTOMATION_SCOPES);
const CREDENTIAL_KEYS = new Set(["id", "scopes", "tokenHash"]);
const UNKNOWN_CREDENTIAL_HASH = "0".repeat(64);
const credentialCache: {
    credentials: Map<string, AutomationCredentialConfig>;
    serialized: string | undefined;
} = {
    credentials: new Map(),
    serialized: undefined,
};

function isTimingSafeHashEqual(storedHash: string, candidateHash: string): boolean {
    return crypto.timingSafeEqual(
        Uint8Array.fromHex(storedHash),
        Uint8Array.fromHex(candidateHash)
    );
}

function tokenHash(token: string): string {
    return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function parseCredential(value: unknown, index: number): AutomationCredentialConfig {
    if (!isPlainRecord(value)) {
        throw new TypeError(`Automation credential ${index} must be an object`);
    }
    if (Object.keys(value).some((key) => !CREDENTIAL_KEYS.has(key))) {
        throw new TypeError(`Automation credential ${index} has unknown fields`);
    }
    const id = value.id;
    if (typeof id !== "string" || !AUTOMATION_ID_RE.test(id)) {
        throw new TypeError(`Automation credential ${index} has an invalid id`);
    }
    const hash = value.tokenHash;
    if (typeof hash !== "string" || !TOKEN_HASH_RE.test(hash)) {
        throw new TypeError(`Automation credential ${index} has an invalid tokenHash`);
    }
    const scopes = value.scopes;
    if (
        !Array.isArray(scopes) ||
        scopes.length === 0 ||
        scopes.length > MAX_SCOPES_PER_CREDENTIAL ||
        scopes.some((scope) => typeof scope !== "string" || !KNOWN_SCOPES.has(scope))
    ) {
        throw new TypeError(`Automation credential ${index} has invalid scopes`);
    }
    if (new Set(scopes).size !== scopes.length) {
        throw new TypeError(`Automation credential ${index} has duplicate scopes`);
    }
    return {
        id,
        scopes: scopes as AutomationScope[],
        tokenHash: hash,
    };
}

function parseCredentials(
    serialized = process.env.MIRA_DASHBOARD_AUTOMATION_CREDENTIALS
): Map<string, AutomationCredentialConfig> {
    const normalized = serialized?.trim();
    if (!normalized) return new Map();
    let parsed: unknown;
    try {
        parsed = JSON.parse(normalized) as unknown;
    } catch {
        throw new TypeError("MIRA_DASHBOARD_AUTOMATION_CREDENTIALS must be valid JSON");
    }
    if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        parsed.length > MAX_AUTOMATION_CREDENTIALS
    ) {
        throw new TypeError(
            `MIRA_DASHBOARD_AUTOMATION_CREDENTIALS must contain 1-${MAX_AUTOMATION_CREDENTIALS} credentials`
        );
    }

    const credentials = new Map<string, AutomationCredentialConfig>();
    const tokenHashes = new Set<string>();
    for (const [index, value] of parsed.entries()) {
        const credential = parseCredential(value, index);
        if (credentials.has(credential.id)) {
            throw new TypeError(`Duplicate automation credential id: ${credential.id}`);
        }
        if (tokenHashes.has(credential.tokenHash)) {
            throw new TypeError("Automation credentials must not share a tokenHash");
        }
        credentials.set(credential.id, credential);
        tokenHashes.add(credential.tokenHash);
    }
    return credentials;
}

function configuredCredentials(
    serialized = process.env.MIRA_DASHBOARD_AUTOMATION_CREDENTIALS
): Map<string, AutomationCredentialConfig> {
    if (credentialCache.serialized !== serialized) {
        credentialCache.credentials = parseCredentials(serialized);
        credentialCache.serialized = serialized;
    }
    return credentialCache.credentials;
}

/** Fails startup on malformed or overbroad automation credential configuration. */
export function validateAutomationCredentials(
    serialized = process.env.MIRA_DASHBOARD_AUTOMATION_CREDENTIALS
): number {
    return configuredCredentials(serialized).size;
}

/** Authenticates a strict id/validator bearer token without storing the validator. */
export function authenticateAutomationRequest(
    request: Request,
    serialized = process.env.MIRA_DASHBOARD_AUTOMATION_CREDENTIALS
): AutomationAuthentication {
    const authorization = request.headers.get("authorization");
    if (!authorization) return { kind: "absent" };

    if (!/^bearer(?:\s|$)/iu.test(authorization)) {
        return { kind: "absent" };
    }
    const separator = authorization.indexOf(" ");
    if (
        separator <= 0 ||
        authorization.slice(0, separator).toLowerCase() !== "bearer" ||
        authorization.includes(" ", separator + 1)
    ) {
        return { kind: "invalid" };
    }
    const match = authorization.slice(separator + 1).match(TOKEN_RE);
    const id = match?.[1];
    const validator = match?.[2];
    if (!id || !validator) return { kind: "invalid" };

    const credential = configuredCredentials(serialized).get(id);
    const isValidHash = isTimingSafeHashEqual(
        credential?.tokenHash ?? UNKNOWN_CREDENTIAL_HASH,
        tokenHash(validator)
    );
    if (!credential || !isValidHash) {
        return { kind: "invalid" };
    }
    return {
        kind: "authenticated",
        principal: {
            id: credential.id,
            scopes: new Set(credential.scopes),
        },
    };
}

function isPathAtOrBelow(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function readOrWriteScope(
    request: Request,
    readScope: AutomationScope,
    writeScope: AutomationScope
): AutomationScope {
    return SAFE_METHODS.has(request.method.toUpperCase()) ? readScope : writeScope;
}

/** Returns the one capability required by a deliberately automation-safe route. */
export function requiredAutomationScope(request: Request): AutomationScope | undefined {
    const pathname = new URL(request.url).pathname;
    if (pathname.includes("%")) {
        return undefined;
    }
    const method = request.method.toUpperCase();
    if (isPathAtOrBelow(pathname, "/api/tasks")) {
        return readOrWriteScope(request, "tasks:read", "tasks:write");
    }
    if (isPathAtOrBelow(pathname, "/api/reports")) {
        return readOrWriteScope(request, "reports:read", "reports:write");
    }
    if (isPathAtOrBelow(pathname, "/api/notifications")) {
        return readOrWriteScope(request, "notifications:read", "notifications:write");
    }
    if (method === "PUT" && /^\/api\/agents\/[^/]+\/metadata$/u.test(pathname)) {
        return "agents:write";
    }
    if (isPathAtOrBelow(pathname, "/api/agents") && SAFE_METHODS.has(method)) {
        return "agents:read";
    }
    if (pathname === "/api/audit-events" && SAFE_METHODS.has(method)) {
        return "audit:read";
    }
    if (isPathAtOrBelow(pathname, "/api/cache") && SAFE_METHODS.has(method)) {
        return "cache:read";
    }
    return undefined;
}
