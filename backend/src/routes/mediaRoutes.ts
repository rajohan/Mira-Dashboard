import { handleGatewayMediaRequest } from "./media/gatewayMediaProxy.ts";
import { handleLocalMediaRequest } from "./media/localMedia.ts";

export const mediaRoutes = {
    "/api/chat/media/outgoing/*": {
        GET: handleGatewayMediaRequest,
    },
    "/api/media": {
        GET: handleLocalMediaRequest,
    },
} as const;
