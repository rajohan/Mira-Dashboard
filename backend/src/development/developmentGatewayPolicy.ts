const RECENT_MFA_EXEMPT_GATEWAY_METHODS = new Set([
    "chat.history",
    "chat.runtimeSnapshot",
    "models.list",
    "sessions.list",
    "subscribe",
    "unsubscribe",
]);

const DEVELOPMENT_ALLOWED_GATEWAY_METHODS = new Set([
    ...RECENT_MFA_EXEMPT_GATEWAY_METHODS,
    "chat.abort",
    "chat.send",
    "config.get",
    "cron.list",
    "sessions.patch",
]);

const DEVELOPMENT_GATEWAY_PROXY_METHODS = new Set([
    "chat.abort",
    "chat.history",
    "chat.send",
    "config.get",
    "cron.list",
    "models.list",
    "sessions.list",
    "sessions.patch",
    "sessions.subscribe",
]);

const DEVELOPMENT_GATEWAY_PROXY_EVENTS = new Set([
    "agent",
    "agents",
    "agents.list",
    "chat",
    "chat.send_timing",
    "chat.side_result",
    "cron",
    "health",
    "heartbeat",
    "model.completed",
    "presence",
    "shutdown",
    "task",
    "tick",
    "update.available",
]);

/** Preserves the production Gateway methods that do not require recent MFA. */
export function isGatewayMethodRecentMfaExempt(method: string): boolean {
    return RECENT_MFA_EXEMPT_GATEWAY_METHODS.has(method);
}

/** Allows only browser Gateway calls required by production-like Dashboard dev. */
export function isDevelopmentGatewayMethodAllowed(method: string): boolean {
    return DEVELOPMENT_ALLOWED_GATEWAY_METHODS.has(method);
}

/** Adds the dev backend's read subscription to the browser-safe Gateway methods. */
export function isDevelopmentGatewayProxyMethodAllowed(method: string): boolean {
    return DEVELOPMENT_GATEWAY_PROXY_METHODS.has(method);
}

/** Limits proxy broadcasts to events required by Dashboard status and chat flows. */
export function isDevelopmentGatewayProxyEventAllowed(event: string): boolean {
    return (
        DEVELOPMENT_GATEWAY_PROXY_EVENTS.has(event) ||
        event.startsWith("session.") ||
        event.startsWith("sessions.")
    );
}
