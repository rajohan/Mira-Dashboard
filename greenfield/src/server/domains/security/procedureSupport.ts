import { TRPCError } from "@trpc/server";

import type { RequestContext } from "../../trpc/context.ts";
import type { AuthenticationRequestMetadata } from "./authenticationSession.ts";

/**
 * Builds the redacted request metadata shared by authentication procedures.
 * @param context Validated request-scoped context.
 * @param signal Optional request-cancellation signal.
 * @returns Metadata safe for authentication lifecycle and audit boundaries.
 */
export function authenticationRequestMetadata(
    context: RequestContext,
    signal: AbortSignal | undefined
): AuthenticationRequestMetadata {
    return {
        clientSourceId: context.authenticationClientSourceId,
        requestId: context.requestId,
        ...(signal !== undefined && { signal }),
        ...(context.userAgent !== undefined && { userAgent: context.userAgent }),
    };
}

/**
 * Maps a durable authentication throttle to the stable tRPC response.
 * @param context Validated request-scoped context.
 * @param retryAfterSeconds Whole-second retry delay.
 * @throws {TRPCError} Stable TOO_MANY_REQUESTS error after setting Retry-After.
 */
export function throwAuthenticationRateLimit(
    context: RequestContext,
    retryAfterSeconds: number
): never {
    context.responseHeaders.set("retry-after", String(retryAfterSeconds));
    throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Authentication attempts are temporarily limited",
    });
}
