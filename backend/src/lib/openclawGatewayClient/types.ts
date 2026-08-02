/** Defines device identity. */
export type DeviceIdentity = {
    deviceId: string;
    publicKeyPem: string;
    privateKeyPem: string;
};

/** Defines gateway hello success payload. */
export type GatewayHelloOk = {
    type?: string;
    protocol?: number;
    policy?: {
        tickIntervalMs?: number;
    };
};

/** Defines gateway event. */
export type GatewayEvent = {
    type?: string;
    event?: string;
    payload?: unknown;
    seq?: number;
    stateVersion?: number;
};

/** Defines open claw gateway client options. */
export type OpenClawGatewayClientOptions = {
    url?: string;
    token?: string;
    role?: string;
    scopes?: string[];
    caps?: string[];
    clientName?: string;
    clientDisplayName?: string;
    clientVersion?: string;
    mode?: string;
    platform?: string;
    deviceFamily?: string;
    deviceIdentity?: DeviceIdentity;
    requestTimeoutMs?: number;
    onHelloOk?: (payload: GatewayHelloOk) => void;
    onEvent?: (event: GatewayEvent) => void;
    onConnectError?: (error: Error) => void;
    onClose?: (code: number, reason: string) => void;
};

/** Configures one Gateway request without changing the connection defaults. */
export type OpenClawGatewayRequestOptions = {
    timeoutMs?: number;
};

/** Defines open claw gateway client instance. */
export type OpenClawGatewayClientInstance = {
    pendingRequestCount?: () => number;
    start: () => void;
    stop: () => void;
    request: (
        method: string,
        parameters?: unknown,
        options?: OpenClawGatewayRequestOptions
    ) => Promise<unknown>;
};
