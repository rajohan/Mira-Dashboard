import { openClawConfigurationUpstreamMaximumBytes } from "../../../contracts/openClawSettings.ts";
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { readAuthenticationHttpCredentials } from "../../rawHttp/authenticationCredentials.ts";
import { isAllowedRequestSource } from "../../rawHttp/requestSecurity.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { AuthenticateCredential } from "../../trpc/context.ts";
import { parseAuthenticationResolution } from "../security/authenticationResolution.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import {
    OpenClawConfigurationBackupError,
    type OpenClawConfigurationBackupActor,
    type OpenClawConfigurationBackupContent,
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
    readonly workLimits?: OpenClawConfigurationBackupRawHttpWorkLimits;
}

export interface OpenClawConfigurationBackupRawHttpWorkLimits {
    readonly maximumConcurrentDownloads: number;
    readonly maximumInFlightBytes: number;
}

export const openClawConfigurationBackupRawHttpDefaultWorkLimits = Object.freeze({
    maximumConcurrentDownloads: 2,
    maximumInFlightBytes: 2 * openClawConfigurationUpstreamMaximumBytes,
} satisfies OpenClawConfigurationBackupRawHttpWorkLimits);

export type OpenClawConfigurationBackupRawHttpHandler = (
    request: Request,
    requestUrl: URL
) => Promise<Response | undefined>;

function noStoreResponse(
    body: string | null,
    status: number,
    headers?: Headers
): Response {
    const responseHeaders = new Headers(headers);
    responseHeaders.set("cache-control", "no-store");
    return new Response(body, {
        headers: responseHeaders,
        status,
    });
}

interface DownloadLease {
    readonly release: () => void;
}

function createDownloadAdmission(
    limits: OpenClawConfigurationBackupRawHttpWorkLimits
): (bytes: number) => DownloadLease | undefined {
    if (
        !Number.isSafeInteger(limits.maximumConcurrentDownloads) ||
        limits.maximumConcurrentDownloads < 1 ||
        !Number.isSafeInteger(limits.maximumInFlightBytes) ||
        limits.maximumInFlightBytes < 1
    ) {
        throw new TypeError("OpenClaw configuration export work limits are invalid");
    }
    let activeDownloads = 0;
    let inFlightBytes = 0;
    return (bytes) => {
        if (
            !Number.isSafeInteger(bytes) ||
            bytes < 1 ||
            bytes > limits.maximumInFlightBytes ||
            activeDownloads >= limits.maximumConcurrentDownloads ||
            inFlightBytes > limits.maximumInFlightBytes - bytes
        ) {
            return;
        }
        activeDownloads += 1;
        inFlightBytes += bytes;
        let released = false;
        return Object.freeze({
            release() {
                if (released) return;
                released = true;
                activeDownloads -= 1;
                inFlightBytes -= bytes;
            },
        });
    };
}

function secretDownloadBody(
    consumedBytes: Uint8Array,
    lease: DownloadLease,
    signal: AbortSignal
): ReadableStream<Uint8Array> {
    const bytes = Uint8Array.from(consumedBytes);
    consumedBytes.fill(0);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let emitted = false;
    let releaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let settled = false;
    const release = () => {
        if (settled) return;
        settled = true;
        if (releaseTimer !== undefined) {
            globalThis.clearTimeout(releaseTimer);
            releaseTimer = undefined;
        }
        signal.removeEventListener("abort", abort);
        try {
            bytes.fill(0);
        } finally {
            lease.release();
        }
    };
    const releaseAfterClose = () => {
        if (settled || releaseTimer !== undefined) return;
        releaseTimer = globalThis.setTimeout(release, 0);
    };
    const abort = () => {
        if (settled) return;
        controller?.error(
            signal.reason ??
                new DOMException(
                    "OpenClaw configuration export was aborted",
                    "AbortError"
                )
        );
        release();
    };
    try {
        return new ReadableStream<Uint8Array>(
            {
                cancel() {
                    release();
                },
                pull(activeController) {
                    if (settled) return;
                    if (!emitted) {
                        try {
                            activeController.enqueue(bytes);
                            emitted = true;
                        } catch (error) {
                            release();
                            throw error;
                        }
                        return;
                    }
                    activeController.close();
                    releaseAfterClose();
                },
                start(activeController) {
                    controller = activeController;
                    signal.addEventListener("abort", abort, { once: true });
                    if (signal.aborted) abort();
                },
            },
            { highWaterMark: 0 }
        );
    } catch (error) {
        release();
        throw error;
    }
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
    const admitDownload = createDownloadAdmission(
        options.workLimits ?? openClawConfigurationBackupRawHttpDefaultWorkLimits
    );
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
            const headers = new Headers();
            if (authorization === "session-changed") {
                appendClearedDashboardSessionCookie(headers);
            }
            return noStoreResponse(
                authorization === "session-changed" ? "Unauthorized" : "Forbidden",
                authorization === "session-changed" ? 401 : 403,
                headers
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
            const metadata = options.tickets.inspect(backupActor, match[1]!);
            const lease = admitDownload(metadata.sizeBytes);
            if (lease === undefined) {
                return noStoreResponse(
                    "OpenClaw configuration export capacity exceeded",
                    429
                );
            }
            let content: OpenClawConfigurationBackupContent | undefined;
            let body: ReadableStream<Uint8Array> | undefined;
            try {
                content = options.tickets.consume(backupActor, match[1]!);
                if (
                    content.sizeBytes !== metadata.sizeBytes ||
                    content.bytes.byteLength !== metadata.sizeBytes
                ) {
                    throw new OpenClawConfigurationBackupError("unavailable");
                }
                body = secretDownloadBody(content.bytes, lease, request.signal);
                return new Response(body, {
                    headers: contentHeaders(content),
                    status: 200,
                });
            } catch (error) {
                if (body === undefined) {
                    try {
                        content?.bytes.fill(0);
                    } finally {
                        lease.release();
                    }
                } else {
                    await body
                        .cancel("OpenClaw configuration export response failed")
                        .catch(() => {});
                }
                throw error;
            }
        } catch (error) {
            return errorResponse(error);
        }
    };
}
