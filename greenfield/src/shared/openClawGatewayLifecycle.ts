/** Worker-only authority for the one fixed OpenClaw Gateway lifecycle operation. */
export interface OpenClawGatewayLifecycleExecutionPort {
    readonly restart: (signal?: AbortSignal) => Promise<void>;
}
