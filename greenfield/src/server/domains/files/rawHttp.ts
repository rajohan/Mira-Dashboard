import { randomUUID } from "node:crypto";

import {
    workspaceFileLimits,
    workspaceFileRawHttpContracts,
} from "../../../contracts/files.ts";
import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { readAuthenticationHttpCredentials } from "../../rawHttp/authenticationCredentials.ts";
import { isAllowedRequestSource } from "../../rawHttp/requestSecurity.ts";
import type { AuthenticateCredential } from "../../trpc/context.ts";
import { parseAuthenticationResolution } from "../security/authenticationResolution.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import { WorkspaceFileError } from "./errors.ts";
import type {
    WorkspaceFileActor,
    WorkspaceFileContentMetadata,
    WorkspaceFilesService,
} from "./service.ts";

const contentPathPattern =
    /^\/api\/files\/content\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const uploadPathPattern =
    /^\/api\/files\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const mimeTypePattern =
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;

const uploadContract = workspaceFileRawHttpContracts.find(
    ({ method }) => method === "PUT"
);
if (uploadContract?.requestBody.kind !== "binary") {
    throw new TypeError("Workspace file upload contract is unavailable");
}
const supportedUploadMimeTypes: ReadonlySet<string> = new Set(
    uploadContract.requestBody.contentTypes
);

export type WorkspaceFileRawWriteAuthorization = (
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

export interface WorkspaceFileRawHttpWorkLimits {
    readonly maximumConcurrentDownloads: number;
    readonly maximumConcurrentUploads: number;
    readonly maximumDownloadBytes: number;
    readonly maximumUploadBytes: number;
}

export const workspaceFileRawHttpDefaultWorkLimits = Object.freeze({
    maximumConcurrentDownloads: 4,
    maximumConcurrentUploads: 2,
    maximumDownloadBytes: 4 * workspaceFileLimits.maximumDownloadBytes,
    maximumUploadBytes: 2 * workspaceFileLimits.maximumUploadBytes,
} satisfies WorkspaceFileRawHttpWorkLimits);

export interface WorkspaceFileRawHttpHandlerOptions {
    readonly authenticateCredential: AuthenticateCredential;
    readonly authorizeWrite: WorkspaceFileRawWriteAuthorization;
    readonly browserOrigin?: string;
    readonly generateRequestId?: () => string;
    readonly service: WorkspaceFilesService;
    readonly workLimits?: WorkspaceFileRawHttpWorkLimits;
}

export type WorkspaceFileRawHttpHandler = (
    request: Request,
    requestUrl: URL
) => Promise<Response | undefined>;

interface WorkLease {
    readonly release: () => void;
}

interface WorkAdmission {
    readonly tryAcquire: (bytes: number) => WorkLease | undefined;
}

type RequestedRange =
    | { readonly end?: number; readonly kind: "from"; readonly start: number }
    | { readonly kind: "suffix"; readonly length: number };

function noStoreResponse(body: string | null, status: number): Response {
    return new Response(body, {
        headers: { "cache-control": "no-store" },
        status,
    });
}

function methodNotAllowed(allow: string): Response {
    return new Response(null, {
        headers: { allow, "cache-control": "no-store" },
        status: 405,
    });
}

function createWorkAdmission(
    maximumConcurrent: number,
    maximumBytes: number
): WorkAdmission {
    if (
        !Number.isSafeInteger(maximumConcurrent) ||
        maximumConcurrent < 1 ||
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes < 1
    ) {
        throw new TypeError("Workspace file raw HTTP work limits are invalid");
    }
    let active = 0;
    let reservedBytes = 0;
    return Object.freeze({
        tryAcquire(bytes: number): WorkLease | undefined {
            if (
                !Number.isSafeInteger(bytes) ||
                bytes < 1 ||
                bytes > maximumBytes ||
                active >= maximumConcurrent ||
                reservedBytes > maximumBytes - bytes
            ) {
                return undefined;
            }
            active += 1;
            reservedBytes += bytes;
            let released = false;
            return Object.freeze({
                release() {
                    if (released) return;
                    released = true;
                    active -= 1;
                    reservedBytes -= bytes;
                },
            });
        },
    });
}

function actor(principal: AuthenticatedPrincipal): WorkspaceFileActor {
    return Object.freeze({
        authenticatorId: principal.authenticatorId,
        id: principal.id,
    });
}

async function authenticate(
    request: Request,
    options: Pick<
        WorkspaceFileRawHttpHandlerOptions,
        "authenticateCredential" | "browserOrigin"
    >
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
    if (resolution.authentication.principal.kind !== "session") {
        return { response: noStoreResponse("Forbidden", 403) };
    }
    return { principal: resolution.authentication.principal };
}

function hasCapability(
    principal: AuthenticatedPrincipal,
    capability: "files:read" | "files:write"
): boolean {
    return principal.capabilities.includes(capability);
}

function requestedRange(value: string | null): RequestedRange | undefined {
    if (value === null) return undefined;
    const normalized = value.trim();
    const from = /^bytes=([0-9]+)-([0-9]*)$/u.exec(normalized);
    if (from !== null) {
        const start = Number(from[1]);
        const end = from[2] === "" ? undefined : Number(from[2]);
        if (
            !Number.isSafeInteger(start) ||
            (end !== undefined && (!Number.isSafeInteger(end) || end < start))
        ) {
            return undefined;
        }
        return { ...(end === undefined ? {} : { end }), kind: "from", start };
    }
    const suffix = /^bytes=-([0-9]+)$/u.exec(normalized);
    if (suffix === null) return undefined;
    const length = Number(suffix[1]);
    return Number.isSafeInteger(length) && length > 0
        ? { kind: "suffix", length }
        : undefined;
}

function resolvedRange(
    requestRange: RequestedRange | undefined,
    sizeBytes: number
): { readonly endExclusive: number; readonly start: number } | undefined {
    if (requestRange === undefined) return undefined;
    if (sizeBytes === 0) return undefined;
    if (requestRange.kind === "suffix") {
        return {
            endExclusive: sizeBytes,
            start: Math.max(0, sizeBytes - requestRange.length),
        };
    }
    if (requestRange.start >= sizeBytes) return undefined;
    return {
        endExclusive: Math.min(sizeBytes, (requestRange.end ?? sizeBytes - 1) + 1),
        start: requestRange.start,
    };
}

function rangeNotSatisfiable(sizeBytes: number): Response {
    return new Response(null, {
        headers: {
            "cache-control": "no-store",
            "content-range": `bytes */${sizeBytes}`,
        },
        status: 416,
    });
}

function encodedFileName(fileName: string): string {
    return encodeURIComponent(fileName).replaceAll(
        /[!'()*]/gu,
        (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`
    );
}

function contentHeaders(
    metadata: WorkspaceFileContentMetadata,
    bodyBytes: number,
    range: { readonly endExclusive: number; readonly start: number } | undefined
): Headers {
    const inline =
        metadata.disposition === "preview" && metadata.previewKind !== "download-only";
    const transferFileName = metadata.truncated
        ? `${metadata.fileName}.prefix`
        : metadata.fileName;
    const headers = new Headers({
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFileName(transferFileName)}`,
        "content-length": String(bodyBytes),
        "content-security-policy": "sandbox; default-src 'none'",
        "content-type": metadata.mimeType,
        etag: `"${metadata.revision}"`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
    });
    if (metadata.truncated === true && metadata.sourceSizeBytes !== undefined) {
        headers.set("x-mira-file-source-size", String(metadata.sourceSizeBytes));
        headers.set("x-mira-file-truncated", "true");
    }
    if (range !== undefined) {
        headers.set(
            "content-range",
            `bytes ${range.start}-${range.endExclusive - 1}/${metadata.sizeBytes}`
        );
    }
    return headers;
}

function normalizedMimeType(value: string | null): string | undefined {
    const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
    return normalized !== undefined && mimeTypePattern.test(normalized)
        ? normalized
        : undefined;
}

function declaredContentLength(request: Request): number | undefined {
    const value = request.headers.get("content-length")?.trim();
    if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
        return undefined;
    }
    const length = Number(value);
    return Number.isSafeInteger(length) ? length : undefined;
}

function emptyBody(): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.close();
        },
    });
}

async function cancelBody(request: Request, reason: string): Promise<void> {
    await request.body?.cancel(reason).catch(() => {});
}

function errorResponse(error: unknown, transfer: "content" | "upload"): Response {
    if (!(error instanceof WorkspaceFileError)) {
        return noStoreResponse("Internal server error", 500);
    }
    switch (error.reason) {
        case "access-denied": {
            return noStoreResponse("Forbidden", 403);
        }
        case "capacity": {
            return noStoreResponse("Workspace file capacity exceeded", 429);
        }
        case "conflict": {
            return noStoreResponse("Workspace file state changed", 409);
        }
        case "expired": {
            return noStoreResponse("Workspace file ticket expired", 410);
        }
        case "not-found": {
            return noStoreResponse("Not found", 404);
        }
        case "too-large": {
            return noStoreResponse(
                "Workspace file transfer is too large",
                transfer === "upload" ? 413 : 400
            );
        }
        case "directory-too-large":
        case "invalid-input":
        case "not-file": {
            return noStoreResponse("Invalid workspace file request", 400);
        }
        case "unavailable": {
            return noStoreResponse("Workspace files unavailable", 503);
        }
    }
}

async function contentResponse(
    request: Request,
    ticketId: string,
    fileActor: WorkspaceFileActor,
    service: WorkspaceFilesService,
    admission: WorkAdmission
): Promise<Response> {
    try {
        const metadata = await service.inspectContent(
            fileActor,
            ticketId,
            request.signal
        );
        const rangeHeader = request.headers.get("range");
        const parsedRange = requestedRange(rangeHeader);
        if (rangeHeader !== null && parsedRange === undefined) {
            return rangeNotSatisfiable(metadata.sizeBytes);
        }
        const range = resolvedRange(parsedRange, metadata.sizeBytes);
        if (parsedRange !== undefined && range === undefined) {
            return rangeNotSatisfiable(metadata.sizeBytes);
        }
        const bodyBytes =
            range === undefined ? metadata.sizeBytes : range.endExclusive - range.start;
        if (request.method === "HEAD") {
            return new Response(null, {
                headers: contentHeaders(metadata, bodyBytes, range),
                status: range === undefined ? 200 : 206,
            });
        }
        const lease = admission.tryAcquire(Math.max(1, bodyBytes));
        if (lease === undefined) {
            return noStoreResponse("Workspace file capacity exceeded", 429);
        }
        try {
            const result = await service.readContent(
                fileActor,
                ticketId,
                range,
                request.signal
            );
            if (result.bytes.byteLength !== bodyBytes) {
                return noStoreResponse("Workspace file state changed", 409);
            }
            return new Response(result.bytes, {
                headers: contentHeaders(result, bodyBytes, range),
                status: range === undefined ? 200 : 206,
            });
        } finally {
            lease.release();
        }
    } catch (error) {
        return errorResponse(error, "content");
    }
}

/**
 * Builds the same-origin, session-only raw content and upload ticket handler.
 * @param options Authenticator, recent-MFA policy, lifecycle service, and work budgets.
 * @returns Raw HTTP handler that claims only exact workspace-file transfer paths.
 */
export function createWorkspaceFileRawHttpHandler(
    options: WorkspaceFileRawHttpHandlerOptions
): WorkspaceFileRawHttpHandler {
    const workLimits = options.workLimits ?? workspaceFileRawHttpDefaultWorkLimits;
    const downloadAdmission = createWorkAdmission(
        workLimits.maximumConcurrentDownloads,
        workLimits.maximumDownloadBytes
    );
    const uploadAdmission = createWorkAdmission(
        workLimits.maximumConcurrentUploads,
        workLimits.maximumUploadBytes
    );
    const generateRequestId = options.generateRequestId ?? randomUUID;

    return async (request, requestUrl) => {
        const content = contentPathPattern.exec(requestUrl.pathname);
        const upload = uploadPathPattern.exec(requestUrl.pathname);
        if (content === null && upload === null) {
            return requestUrl.pathname.startsWith("/api/files/")
                ? noStoreResponse("Not found", 404)
                : undefined;
        }
        if (requestUrl.search !== "") return noStoreResponse("Not found", 404);
        if (content !== null && request.method !== "GET" && request.method !== "HEAD") {
            return methodNotAllowed("GET, HEAD");
        }
        if (upload !== null && request.method !== "PUT") {
            return methodNotAllowed("PUT");
        }

        let authentication: Awaited<ReturnType<typeof authenticate>>;
        try {
            authentication = await authenticate(request, options);
        } catch {
            return noStoreResponse("Workspace files unavailable", 503);
        }
        if ("response" in authentication) return authentication.response;
        const principal = authentication.principal;
        const fileActor = actor(principal);

        if (content !== null) {
            if (!hasCapability(principal, "files:read")) {
                return noStoreResponse("Forbidden", 403);
            }
            return contentResponse(
                request,
                content[1]!,
                fileActor,
                options.service,
                downloadAdmission
            );
        }

        if (!hasCapability(principal, "files:write")) {
            await cancelBody(request, "Workspace file write is not permitted");
            return noStoreResponse("Forbidden", 403);
        }
        let authorization: Awaited<ReturnType<WorkspaceFileRawWriteAuthorization>>;
        try {
            authorization = await options.authorizeWrite({
                sessionId: principal.authenticatorId,
                userId: principal.id,
            });
        } catch {
            await cancelBody(request, "Workspace file authorization failed");
            return noStoreResponse("Workspace files unavailable", 503);
        }
        if (authorization !== "authorized") {
            await cancelBody(request, "Workspace file recent authentication is required");
            return noStoreResponse(
                authorization === "session-changed" ? "Unauthorized" : "Forbidden",
                authorization === "session-changed" ? 401 : 403
            );
        }

        const length = declaredContentLength(request);
        if (length === undefined) {
            await cancelBody(request, "Workspace file content length is required");
            return noStoreResponse("Content-Length is required", 411);
        }
        if (length > workspaceFileLimits.maximumUploadBytes) {
            await cancelBody(request, "Workspace file upload is too large");
            return noStoreResponse("Workspace file upload is too large", 413);
        }
        const mimeType = normalizedMimeType(request.headers.get("content-type"));
        if (mimeType === undefined || !supportedUploadMimeTypes.has(mimeType)) {
            await cancelBody(request, "Workspace file MIME type is unsupported");
            return noStoreResponse("Unsupported Media Type", 415);
        }

        let metadata: ReturnType<WorkspaceFilesService["inspectUpload"]>;
        try {
            metadata = options.service.inspectUpload(fileActor, upload![1]!);
        } catch (error) {
            await cancelBody(request, "Workspace file upload ticket is unavailable");
            return errorResponse(error, "upload");
        }
        if (metadata.sizeBytes !== length || metadata.mimeType !== mimeType) {
            await cancelBody(request, "Workspace file upload declaration changed");
            return noStoreResponse("Workspace file upload declaration changed", 409);
        }
        if (length > 0 && request.body === null) {
            return noStoreResponse("Workspace file upload body is missing", 400);
        }
        const lease = uploadAdmission.tryAcquire(Math.max(1, length));
        if (lease === undefined) {
            await cancelBody(request, "Workspace file upload capacity exceeded");
            return noStoreResponse("Workspace file upload capacity exceeded", 429);
        }
        try {
            const accepted = await options.service.acceptUpload(
                fileActor,
                upload![1]!,
                request.body ?? emptyBody(),
                generateRequestId(),
                request.signal
            );
            return Response.json(accepted, {
                headers: { "cache-control": "no-store" },
                status: 202,
            });
        } catch (error) {
            await cancelBody(request, "Workspace file upload did not complete");
            return errorResponse(error, "upload");
        } finally {
            lease.release();
        }
    };
}
