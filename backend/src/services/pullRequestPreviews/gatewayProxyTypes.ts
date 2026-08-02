import type { Server, ServerWebSocket } from "bun";

import type {
    OpenClawGatewayClientInstance,
    OpenClawGatewayClientOptions,
} from "../../lib/openclawGatewayClient/client.ts";

export interface PreviewGatewaySocketData {
    authenticated: boolean;
    authenticationTimer?: NodeJS.Timeout;
    challengeNonce: string;
    pendingRequests: number;
}

export interface PreviewGatewayRequest {
    id: string;
    method: string;
    parameters: Record<string, unknown>;
}

export interface PullRequestPreviewGatewayProxyOptions {
    clientToken: string;
    deviceIdentityFile: string;
    port: number;
    serverFactory?: (
        options: Bun.Serve.Options<PreviewGatewaySocketData>
    ) => Server<PreviewGatewaySocketData>;
    upstreamClientFactory?: (
        options: OpenClawGatewayClientOptions
    ) => OpenClawGatewayClientInstance;
    upstreamToken: string;
    upstreamUrl: string;
}

export interface PullRequestPreviewGatewayProxy {
    isUpstreamConnected: () => boolean;
    port: number;
    stop: () => Promise<void>;
}

export type PreviewGatewaySocket = ServerWebSocket<PreviewGatewaySocketData>;
