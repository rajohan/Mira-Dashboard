import * as v from "valibot";

import {
    requestAuthenticationSchema,
    type RequestAuthentication,
} from "../../contracts/security.ts";
import type {
    ApplicationRuntime,
    ApplicationRuntimeServices,
} from "../platform/runtime/applicationRuntime.ts";

/** Authenticator supplied by the security composition root. */
export type AuthenticateRequest = (request: Request) => unknown;

/** Dependencies supplied while constructing one application request context. */
export interface RequestContextOptions {
    readonly applicationRuntime: ApplicationRuntime;
    readonly authenticateRequest: AuthenticateRequest;
    readonly request: Request;
}

/** Dependencies supplied to every application tRPC procedure. */
export interface RequestContext {
    readonly authentication: RequestAuthentication;
    readonly requestId: string;
    readonly services: ApplicationRuntimeServices;
}

/**
 * Builds request-scoped tRPC context from explicitly injected runtime and auth services.
 * @param options Request and process-owned dependencies.
 * @returns Validated immutable request context.
 */
export async function createRequestContext(
    options: RequestContextOptions
): Promise<RequestContext> {
    const authentication = v.parse(
        requestAuthenticationSchema,
        await options.authenticateRequest(options.request)
    );
    return Object.freeze({
        authentication,
        requestId: crypto.randomUUID(),
        services: options.applicationRuntime.services,
    });
}
