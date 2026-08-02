import {
    isDevelopmentGatewayMethodAllowed,
    isGatewayMethodRecentMfaExempt,
} from "../development/developmentGatewayPolicy.ts";
import { isProductionDeploymentCutoverActive } from "../services/deploymentCutoverState.ts";

export const SAFE_REQUEST_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PUBLIC_API_METHODS = new Map<string, ReadonlySet<string>>([
    ["/api/health/live", new Set(["GET", "HEAD"])],
    ["/api/health/ready", new Set(["GET", "HEAD"])],
    ["/api/auth/bootstrap", new Set(["GET", "HEAD"])],
    ["/api/auth/login", new Set(["POST"])],
    ["/api/auth/login/recovery", new Set(["POST"])],
    ["/api/auth/login/totp", new Set(["POST"])],
    ["/api/auth/login/webauthn/options", new Set(["POST"])],
    ["/api/auth/login/webauthn/verify", new Set(["POST"])],
    ["/api/auth/logout", new Set(["POST"])],
    ["/api/auth/register-first-user", new Set(["POST"])],
    ["/api/auth/session", new Set(["GET", "HEAD"])],
]);
const DEVELOPMENT_BLOCKED_HOST_MUTATION_PATHS = [
    "/api/backup",
    "/api/backups",
    "/api/config",
    "/api/cron",
    "/api/docker",
    "/api/exec",
    "/api/ops",
    "/api/pull-requests",
    "/api/restart",
    "/api/sessions",
    "/api/skills",
    "/api/terminal",
] as const;
export function isApiRoute(pathname: string): boolean {
    return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Blocks user-visible writes until a guarded deployment reaches a terminal state.
 * @returns Whether the mutation is blocked during deployment cutover.
 */
export function isDeploymentCutoverMutationBlocked(
    request: Request,
    options: {
        environment?: Record<string, string | undefined>;
        isCutoverActive?: () => boolean;
    } = {}
): boolean {
    const environment = options.environment ?? process.env;
    if (environment.NODE_ENV !== "production") {
        return false;
    }
    const isCutoverActive =
        options.isCutoverActive ?? (() => isProductionDeploymentCutoverActive());
    if (!isCutoverActive()) {
        return false;
    }
    return (
        // Safe methods still write session activity when this touch header is set.
        !SAFE_REQUEST_METHODS.has(request.method.toUpperCase()) ||
        request.headers.get("x-mira-user-activity")?.trim() === "1"
    );
}

export function isAuthRoute(pathname: string): boolean {
    return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

export function isPublicApiRoute(request: Request): boolean {
    const pathname = new URL(request.url).pathname;
    return PUBLIC_API_METHODS.get(pathname)?.has(request.method.toUpperCase()) === true;
}

function isPathAtOrBelow(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Returns whether the backend is running with isolated development safeguards.
 * @param environment Environment value.
 * @returns Whether isolated development safeguards are active.
 */
export function isDevelopmentSafeMode(
    environment: Record<string, string | undefined> = process.env
): boolean {
    return (
        environment.NODE_ENV !== "production" &&
        environment.MIRA_DASHBOARD_DEV_SAFE_MODE === "1"
    );
}

/**
 * Blocks host and external-service mutations while preserving isolated dev data.
 * @returns Whether development host policy blocks the mutation.
 */
export function isDevelopmentHostMutationBlocked(
    request: Request,
    environment: Record<string, string | undefined> = process.env
): boolean {
    if (
        !isDevelopmentSafeMode(environment) ||
        SAFE_REQUEST_METHODS.has(request.method.toUpperCase())
    ) {
        return false;
    }
    const pathname = new URL(request.url).pathname;
    return DEVELOPMENT_BLOCKED_HOST_MUTATION_PATHS.some((prefix) =>
        isPathAtOrBelow(pathname, prefix)
    );
}

/**
 * Prevents isolated data mutations from notifying production integrations.
 * @returns Whether development policy suppresses the external notification.
 */
export function isDevelopmentExternalNotificationSuppressed(
    environment: Record<string, string | undefined> = process.env
): boolean {
    return isDevelopmentSafeMode(environment);
}

export {
    isDevelopmentGatewayMethodAllowed,
    isDevelopmentGatewayProxyEventAllowed,
    isDevelopmentGatewayProxyMethodAllowed,
} from "../development/developmentGatewayPolicy.ts";

/**
 * Blocks Gateway calls outside the production-like Dashboard dev allowlist.
 * @param method Method value.
 * @param environment Environment value.
 * @returns Whether development policy blocks the Gateway method.
 */
export function isDevelopmentGatewayMethodBlocked(
    method: string,
    environment: Record<string, string | undefined> = process.env
): boolean {
    return (
        isDevelopmentSafeMode(environment) && !isDevelopmentGatewayMethodAllowed(method)
    );
}
/**
 * Identifies host-control actions that require a freshly verified second factor.
 * @returns Requires recent mfa result.
 */
export function requiresRecentMfa(request: Request): boolean {
    const url = new URL(request.url);
    let pathname: string;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        // An authenticated request with an ambiguous path must not bypass the
        // privileged-route classifier.
        return true;
    }
    const method = request.method.toUpperCase();
    const isMutation = !SAFE_REQUEST_METHODS.has(method);

    if (
        method === "GET" &&
        pathname === "/api/config-files/openclaw.json" &&
        url.searchParams.get("reveal") === "1"
    ) {
        return true;
    }
    if (
        (pathname === "/api/backup" && method === "POST") ||
        (pathname === "/api/restart" && method === "POST")
    ) {
        return true;
    }
    if (!isMutation) return false;
    if (
        pathname === "/api/config" ||
        pathname === "/api/settings" ||
        pathname.startsWith("/api/cache/") ||
        pathname.startsWith("/api/config-files/") ||
        pathname.startsWith("/api/files/") ||
        pathname.startsWith("/api/skills/")
    ) {
        return true;
    }
    return [
        "/api/backups/",
        "/api/cron/",
        "/api/docker/",
        "/api/exec",
        "/api/job-executions/",
        "/api/jobs",
        "/api/ops/",
        "/api/pull-requests/",
        "/api/sessions/",
        "/api/terminal/",
    ].some(
        (prefix) => pathname === prefix.replace(/\/$/u, "") || pathname.startsWith(prefix)
    );
}

/**
 * Requires fresh MFA for every Gateway RPC except the explicit read-only set.
 * @param method Method value.
 * @returns Requires recent mfa for gateway method result.
 */
export function requiresRecentMfaForGatewayMethod(method: string): boolean {
    return !isGatewayMethodRecentMfaExempt(method);
}
