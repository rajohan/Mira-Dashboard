/** No current or last-known-good OpenClaw session snapshot can be returned. */
export class GatewaySessionsUnavailableError extends Error {
    public constructor() {
        super("Gateway sessions are unavailable");
        this.name = "GatewaySessionsUnavailableError";
    }
}

/** The requested current OpenClaw session no longer exists. */
export class GatewaySessionNotFoundError extends Error {
    public constructor() {
        super("Gateway session was not found");
        this.name = "GatewaySessionNotFoundError";
    }
}

/** The requested current-session action raced with an upstream state change. */
export class GatewaySessionConflictError extends Error {
    public constructor() {
        super("Gateway session changed");
        this.name = "GatewaySessionConflictError";
    }
}

/** OpenClaw could not confirm the requested session control. */
export class GatewaySessionControlUnavailableError extends Error {
    public constructor() {
        super("Gateway session control is unavailable");
        this.name = "GatewaySessionControlUnavailableError";
    }
}

/** A dispatched OpenClaw control has no definitive provider acknowledgement. */
export class GatewaySessionControlUnknownOutcomeError extends Error {
    public constructor() {
        super("Gateway session control outcome is unknown");
        this.name = "GatewaySessionControlUnknownOutcomeError";
    }
}

/** Dashboard policy forbids deleting its reviewed primary OpenClaw session. */
export class GatewaySessionControlForbiddenError extends Error {
    public constructor() {
        super("Gateway session control is forbidden");
        this.name = "GatewaySessionControlForbiddenError";
    }
}
