import { TRPCError } from "@trpc/server";

import {
    getGatewayConnectionInputSchema,
    getGatewayConnectionResultSchema,
} from "../../../contracts/gatewayConnection.ts";
import type { RequestContext } from "../../trpc/context.ts";
import { sessionCapabilityProcedure } from "../../trpc/trpc.ts";
import { GatewayConnectionUnavailableError } from "./errors.ts";
import type { GatewayConnectionService } from "./service.ts";

function gatewayConnectionService(context: RequestContext): GatewayConnectionService {
    return context.gatewayConnectionService;
}

function throwGatewayConnectionFailure(error: unknown): never {
    if (error instanceof GatewayConnectionUnavailableError) {
        throw new TRPCError({
            cause: error,
            code: "SERVICE_UNAVAILABLE",
            message: "Gateway connection state is temporarily unavailable",
        });
    }
    throw error;
}

const readProcedure = sessionCapabilityProcedure("gateway-sessions:read");

/** Session-only sanitized native Gateway connection query. */
export const gatewayConnectionRoutes = {
    get: readProcedure
        .input(getGatewayConnectionInputSchema)
        .output(getGatewayConnectionResultSchema)
        .query(({ ctx }) => {
            try {
                return gatewayConnectionService(ctx).get();
            } catch (error) {
                return throwGatewayConnectionFailure(error);
            }
        }),
};
