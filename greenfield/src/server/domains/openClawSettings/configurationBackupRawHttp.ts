import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { readAuthenticationHttpCredentials } from "../../rawHttp/authenticationCredentials.ts";
import { isAllowedRequestSource } from "../../rawHttp/requestSecurity.ts";
import type { AuthenticateCredential } from "../../trpc/context.ts";
import { parseAuthenticationResolution } from "../security/authenticationResolution.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import {
    OpenClawConfigurationBackupError,
    type OpenClawConfigurationBackupActor,
    type OpenClawConfigurationBackupMetadata,
    type OpenClawConfigurationBackupTicketStore,
} from "./configurationBackup.ts";

const backupPathPattern =
    /^\/api\/openclaw-settings\/configuration-backups\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

export type OpenClawConfigurationBackupRawAuthorization = (
    identity: AuthenticatedBrowserIdentity
) =>
    | Promise<
          | "authorized"
          | "mfa-enrollment-required"
          | "session-changed"
          | "step-up-required"
      >
    | "authorized"
    | "mfa-enrollment-required"
    | "session-changed"
    | "step-up-required";

export interface OpenClawConfigurationBackupRawHttpHandlerOptions {
    readonly authenticateCredential: AuthenticateCredential;
    readonly authorizeAccess: OpenClawConfigurationBackupRawAuthorization;
    readonly browserOrigin?: string;
    readonly tickets: OpenClawConfigurationBackupTicketStore;
}

export type OpenClawConfigurationBackupRawHttpHandler = (
    request: Request,
    requestUrl: URL
) => Promise<Response | undefined>;

function noStoreResponse(body: string | null, status: number): Response {
    return new Response(body, {
        headers: { "cache-control": "no-store" },
        status,
    });
}

function actor(principal: AuthenticatedPrincipal): OpenClawConfigurationBackupActor {
    return Object.freeze({
        authenticatorId: principal.authenticatorId,
        id: principal.id,
    });
}

function contentHeaders(metadata: OpenClawConfigurationBackupMetadata): Headers {
    return new Headers({
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${metadata.fileName}"`,
        "content-length": String(metadata.sizeBytes),
        "content-security-policy": "sandbox; default-src 'none'",
        "content-type": metadata.mimeType,
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
    });
}

function errorResponse(error: unknown): Response {
    if (!(error instanceof OpenClawConfigurationBackupError)) {
        return noStoreResponse("Internal server error", 500);
    }
    switch (error.reason) {
        case "capacity": {
            return noStoreResponse(
                "OpenClaw configuration export capacity exceeded",
                429
            );
        }
        case "expired": {
            return noStoreResponse("OpenClaw configuration export ticket expired", 410);
        }
        case "not-found": {
            return noStoreResponse("Not found", 404);
        }
        case "invalid-source":
        case "unavailable": {
            return noStoreResponse("OpenClaw configuration export unavailable", 503);
        }
    }
}

async function authenticate(
    request: Request,
    options: OpenClawConfigurationBackupRawHttpHandlerOptions
): Promise<
    | { readonly principal: AuthenticatedPrincipal & { readonly kind: "session" } }
    | { readonly response: Response }
> {
    if (!isAllowedRequestSource(request, options.browserOrigin)) {
        return { response: noStoreResponse("Forbidden", 403) };
    }
    const credentials = readAuthenticationHttpCredentials(request);
    if (credentials.isAmbiguous) {
        return {
            response: noStoreResponse("Ambiguous authentication credentials", 400),
        };
    }
    const resolution = parseAuthenticationResolution(
        await options.authenticateCredential(credentials.authentication)
    );
    if (resolution.authentication.kind !== "authenticated") {
        return { response: noStoreResponse("Unauthorized", 401) };
    }
    const principal = resolution.authentication.principal;
    if (principal.kind !== "session") {
        return { response: noStoreResponse("Forbidden", 403) };
    }
    return { principal };
}

/**
 * Creates the same-origin, session-only, recent-MFA one-shot export handler.
 * @returns The exact-path raw HTTP handler.
 */
export function createOpenClawConfigurationBackupRawHttpHandler(
    options: OpenClawConfigurationBackupRawHttpHandlerOptions
): OpenClawConfigurationBackupRawHttpHandler {
    return async (request, requestUrl) => {
        const match = backupPathPattern.exec(requestUrl.pathname);
        if (match === null) {
            return requestUrl.pathname.startsWith(
                "/api/openclaw-settings/configuration-backups/"
            )
                ? noStoreResponse("Not found", 404)
                : undefined;
        }
        if (requestUrl.search !== "") return noStoreResponse("Not found", 404);
        if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response(null, {
                headers: { allow: "GET, HEAD", "cache-control": "no-store" },
                status: 405,
            });
        }

        let authentication: Awaited<ReturnType<typeof authenticate>>;
        try {
            authentication = await authenticate(request, options);
        } catch {
            return noStoreResponse("OpenClaw configuration export unavailable", 503);
        }
        if ("response" in authentication) return authentication.response;
        const principal = authentication.principal;
        if (!principal.capabilities.includes("openclaw-settings:write")) {
            return noStoreResponse("Forbidden", 403);
        }
        let authorization: Awaited<
            ReturnType<OpenClawConfigurationBackupRawAuthorization>
        >;
        try {
            authorization = await options.authorizeAccess({
                sessionId: principal.authenticatorId,
                userId: principal.id,
            });
        } catch {
            return noStoreResponse("OpenClaw configuration export unavailable", 503);
        }
        if (authorization !== "authorized") {
            return noStoreResponse(
                authorization === "session-changed" ? "Unauthorized" : "Forbidden",
                authorization === "session-changed" ? 401 : 403
            );
        }
        if (request.signal.aborted) {
            return noStoreResponse("OpenClaw configuration export unavailable", 503);
        }

        try {
            const backupActor = actor(principal);
            if (request.method === "HEAD") {
                const metadata = options.tickets.inspect(backupActor, match[1]!);
                return new Response(null, {
                    headers: contentHeaders(metadata),
                    status: 200,
                });
            }
            const content = options.tickets.consume(backupActor, match[1]!);
            return new Response(content.bytes, {
                headers: contentHeaders(content),
                status: 200,
            });
        } catch (error) {
            return errorResponse(error);
        }
    };
}
