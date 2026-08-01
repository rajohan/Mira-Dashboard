const RECENT_MFA_EXEMPT_GATEWAY_METHODS = new Set([
    "chat.history",
    "chat.message.get",
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
    "chat.message.get",
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

/**
 * Preserves the production Gateway methods that do not require recent MFA.
 * @param method Method value.
 * @returns Whether the Gateway method is exempt from recent-MFA verification.
 */
export function isGatewayMethodRecentMfaExempt(method: string): boolean {
    return RECENT_MFA_EXEMPT_GATEWAY_METHODS.has(method);
}

/**
 * Allows only browser Gateway calls required by production-like Dashboard dev.
 * @param method Method value.
 * @returns Whether the Gateway method is allowed in development.
 */
export function isDevelopmentGatewayMethodAllowed(method: string): boolean {
    return DEVELOPMENT_ALLOWED_GATEWAY_METHODS.has(method);
}

/**
 * Adds the dev backend's read subscription to the browser-safe Gateway methods.
 * @param method Method value.
 * @returns Whether the Gateway proxy method is allowed in development.
 */
export function isDevelopmentGatewayProxyMethodAllowed(method: string): boolean {
    return DEVELOPMENT_GATEWAY_PROXY_METHODS.has(method);
}

/**
 * Limits proxy broadcasts to events required by Dashboard status and chat flows.
 * @param event Event to handle.
 * @returns Whether the Gateway proxy event is allowed in development.
 */
export function isDevelopmentGatewayProxyEventAllowed(event: string): boolean {
    return (
        DEVELOPMENT_GATEWAY_PROXY_EVENTS.has(event) ||
        event.startsWith("session.") ||
        event.startsWith("sessions.")
    );
}
