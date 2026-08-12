import { Redacted } from "effect";

import type { ChatMessageGetOutput } from "../../contracts/chat.ts";
import { chatAttachmentLimits } from "../../contracts/chatMedia.ts";
import type { AuthenticatedPrincipal } from "../../contracts/security.ts";
import { parseAuthenticationResolution } from "../domains/security/authenticationResolution.ts";
import type { InMemoryChatAttachmentStore } from "../platform/chat/inMemoryChatAttachmentStore.ts";
import type {
    ChatMediaReference,
    InMemoryChatMediaReferences,
} from "../platform/chat/inMemoryChatMediaReferences.ts";
import type { AuthenticateCredential } from "../trpc/context.ts";
import { readAuthenticationHttpCredentials } from "./authenticationCredentials.ts";
import { isAllowedRequestSource } from "./requestSecurity.ts";

export const chatOutgoingMediaMaximumBytes = 16 * 1024 * 1024;
export const chatOutgoingTextPreviewMaximumBytes = 1024 * 1024;
export const chatOutgoingMediaTimeoutMs = 30_000;
export const chatAttachmentUploadTimeoutMs = 60_000;
export const chatMediaReferenceRefreshTimeoutMs = 15_000;
export const chatMediaReferenceRefreshCooldownMs = 30_000;

type ChatRawHttpTimerHandle = object;

export interface ChatRawHttpScheduler {
    readonly clearTimeout: (handle: ChatRawHttpTimerHandle) => void;
    readonly setTimeout: (
        callback: () => void,
        delayMs: number
    ) => ChatRawHttpTimerHandle;
}

const defaultChatRawHttpScheduler: ChatRawHttpScheduler = Object.freeze({
    clearTimeout(handle: ChatRawHttpTimerHandle) {
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    setTimeout(callback: () => void, delayMs: number) {
        return globalThis.setTimeout(callback, delayMs);
    },
});

export interface ChatRawHttpWorkLimits {
    readonly maximumConcurrentDownloads: number;
    readonly maximumConcurrentUploads: number;
    readonly maximumDownloadBytes: number;
    readonly maximumUploadBytes: number;
}

export const chatRawHttpDefaultWorkLimits = Object.freeze({
    maximumConcurrentDownloads: 4,
    maximumConcurrentUploads: 2,
    maximumDownloadBytes: 4 * chatOutgoingMediaMaximumBytes,
    maximumUploadBytes: 2 * chatAttachmentLimits.maximumFileBytes,
} satisfies ChatRawHttpWorkLimits);

const attachmentPathPattern =
    /^\/api\/chat\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const mediaPathPattern =
    /^\/api\/chat\/media\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const singleRangePattern = /^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/u;
const safeContentRangePattern = /^bytes (?:[0-9]+-[0-9]+|\*)\/(?:[0-9]+|\*)$/u;
const safeInlineMimeTypes = new Set([
    "audio/aac",
    "audio/flac",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/opus",
    "audio/wav",
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/webp",
]);
const safePreviewTextMimeTypes = new Set([
    "application/json",
    "application/ld+json",
    "text/csv",
    "text/markdown",
    "text/plain",
]);
type ChatMediaDisposition = "download" | "preview";

export interface ChatMediaAuthorizationInput {
    readonly attachmentId: string;
    readonly messageId: string;
    readonly principal: AuthenticatedPrincipal;
    readonly sessionKey: string;
}

export function chatMessageAuthorizesMediaReference(
    result: ChatMessageGetOutput,
    reference: Pick<ChatMediaAuthorizationInput, "attachmentId" | "messageId">
): boolean {
    if (
        result.status !== "available" ||
        result.message.id !== reference.messageId ||
        result.message.content.kind !== "complete"
    ) {
        return false;
    }
    const rawParts = result.message.content.parts;
    if (!Array.isArray(rawParts)) return false;
    return (rawParts as readonly unknown[]).some((candidate) => {
        if (candidate === null || typeof candidate !== "object") return false;
        const part = candidate as Readonly<Record<string, unknown>>;
        if (
            part.renderPolicy !== "bounded-text" &&
            part.renderPolicy !== "download-only" &&
            part.renderPolicy !== "inline-image"
        ) {
            return false;
        }
        const disposition =
            part.renderPolicy === "download-only" ? "download" : "preview";
        return (
            part.kind === "attachment" &&
            part.url ===
                `/api/chat/media/${reference.attachmentId}?disposition=${disposition}`
        );
    });
}

export interface OpenClawOutgoingMediaRequest {
    readonly attachmentId: string;
    readonly method: "GET" | "HEAD";
    readonly range?: string;
    readonly sessionKey: string;
    readonly signal: AbortSignal;
    readonly source: ChatMediaReference["source"];
}

export interface OpenClawOutgoingMediaFetcher {
    readonly fetch: (request: OpenClawOutgoingMediaRequest) => Promise<Response>;
}

export interface ChatMediaSourceFetcherOptions {
    readonly gatewayManaged?: OpenClawOutgoingMediaFetcher;
    readonly localHistory?: Pick<OpenClawOutgoingMediaFetcher, "fetch">;
}

/**
 * Dispatches one already-authorized opaque reference to its exact server-only source.
 * Missing source adapters are indistinguishable from absent media.
 * @returns A source-aware fetcher that preserves the existing raw media response contract.
 */
export function createChatMediaSourceFetcher(
    options: ChatMediaSourceFetcherOptions
): OpenClawOutgoingMediaFetcher {
    if (options.gatewayManaged === undefined && options.localHistory === undefined) {
        throw new TypeError("Chat media source composition is unavailable");
    }
    return Object.freeze({
        fetch(request: OpenClawOutgoingMediaRequest): Promise<Response> {
            switch (request.source.kind) {
                case "gateway-managed": {
                    return (
                        options.gatewayManaged?.fetch(request) ??
                        Promise.resolve(new Response(null, { status: 404 }))
                    );
                }
                case "openclaw-local-history": {
                    return (
                        options.localHistory?.fetch(request) ??
                        Promise.resolve(new Response(null, { status: 404 }))
                    );
                }
            }
        },
    });
}

export interface ChatRawHttpHandlerOptions {
    readonly attachmentStore: InMemoryChatAttachmentStore;
    readonly authenticateCredential: AuthenticateCredential;
    readonly authorizeMedia: (
        input: ChatMediaAuthorizationInput,
        signal?: AbortSignal
    ) => Promise<boolean> | boolean;
    readonly browserOrigin?: string;
    readonly mediaFetcher: OpenClawOutgoingMediaFetcher;
    readonly mediaReferences: InMemoryChatMediaReferences;
    readonly refreshMediaReferences?: (signal: AbortSignal) => Promise<void>;
    readonly scheduler?: ChatRawHttpScheduler;
    readonly uploadTimeoutMs?: number;
    readonly workLimits?: ChatRawHttpWorkLimits;
}

export type ChatRawHttpHandler = (
    request: Request,
    requestUrl: URL
) => Promise<Response | undefined>;

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

function hasCapability(
    principal: AuthenticatedPrincipal,
    capability: "chat:read" | "chat:write"
): boolean {
    return principal.capabilities.includes(capability);
}

interface RawHttpWorkLease {
    readonly release: () => void;
}

interface RawHttpWorkAdmission {
    readonly tryAcquire: (bytes: number) => RawHttpWorkLease | undefined;
}

function createRawHttpWorkAdmission(
    maximumConcurrent: number,
    maximumBytes: number
): RawHttpWorkAdmission {
    if (
        !Number.isSafeInteger(maximumConcurrent) ||
        maximumConcurrent < 1 ||
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes < 1
    ) {
        throw new TypeError("Chat raw HTTP work limits are invalid");
    }
    let active = 0;
    let reservedBytes = 0;
    return Object.freeze({
        tryAcquire(bytes: number): RawHttpWorkLease | undefined {
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
                release(): void {
                    if (released) return;
                    released = true;
                    active -= 1;
                    reservedBytes -= bytes;
                },
            });
        },
    });
}

async function authenticate(
    request: Request,
    options: Pick<ChatRawHttpHandlerOptions, "authenticateCredential" | "browserOrigin">
): Promise<
    { readonly principal: AuthenticatedPrincipal } | { readonly response: Response }
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
    return { principal: resolution.authentication.principal };
}

function declaredContentLength(request: Request): number | undefined {
    const raw = request.headers.get("content-length")?.trim();
    if (raw === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) return undefined;
    const length = Number(raw);
    return Number.isSafeInteger(length) ? length : undefined;
}

class ChatAttachmentUploadAbortedError extends Error {
    constructor() {
        super("Chat attachment upload was aborted");
        this.name = "ChatAttachmentUploadAbortedError";
    }
}

async function readExactBody(
    request: Request,
    declaredBytes: number,
    signal: AbortSignal
): Promise<Uint8Array | undefined> {
    if (request.body === null) return declaredBytes === 0 ? new Uint8Array() : undefined;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let pendingRead: ReturnType<typeof reader.read> | undefined;
    const aborted = Promise.withResolvers<never>();
    const abortRead = () => {
        aborted.reject(new ChatAttachmentUploadAbortedError());
        void reader.cancel("Chat attachment upload was aborted").catch(() => {});
    };
    signal.addEventListener("abort", abortRead, { once: true });
    if (signal.aborted) abortRead();
    try {
        while (true) {
            pendingRead = reader.read();
            const result = await Promise.race([pendingRead, aborted.promise]);
            pendingRead = undefined;
            if (signal.aborted) throw new ChatAttachmentUploadAbortedError();
            if (result.done) break;
            const chunk = result.value as Uint8Array;
            bytes += chunk.byteLength;
            if (bytes > declaredBytes || bytes > chatAttachmentLimits.maximumFileBytes) {
                await reader
                    .cancel("Chat attachment body exceeded its declaration")
                    .catch(() => {});
                return undefined;
            }
            chunks.push(chunk);
        }
    } finally {
        signal.removeEventListener("abort", abortRead);
        if (pendingRead === undefined) {
            reader.releaseLock();
        } else {
            void pendingRead
                .catch(() => {})
                .finally(() => {
                    try {
                        reader.releaseLock();
                    } catch {
                        // The cancelled request stream owns any remaining cleanup.
                    }
                });
        }
    }
    if (bytes !== declaredBytes) return undefined;
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

function normalizedResponseMimeType(value: string | null): string {
    const normalized = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(
        normalized
    )
        ? normalized
        : "application/octet-stream";
}

async function boundedUpstreamBody(
    response: Response,
    maximumBytes: number
): Promise<Uint8Array | undefined> {
    if (response.body === null) return new Uint8Array();
    const declared = response.headers.get("content-length")?.trim();
    if (
        declared !== undefined &&
        /^\d+$/u.test(declared) &&
        Number(declared) > maximumBytes
    ) {
        await response.body
            .cancel("Outgoing chat media exceeded its budget")
            .catch(() => {});
        return undefined;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            const chunk = result.value as Uint8Array;
            bytes += chunk.byteLength;
            if (bytes > maximumBytes) {
                await reader
                    .cancel("Outgoing chat media exceeded its budget")
                    .catch(() => {});
                return undefined;
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    if (declared !== undefined && /^\d+$/u.test(declared) && bytes !== Number(declared)) {
        return undefined;
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

function responseBodyMaximumBytes(
    mimeType: string,
    disposition: ChatMediaDisposition
): number {
    return disposition === "preview" && safePreviewTextMimeTypes.has(mimeType)
        ? chatOutgoingTextPreviewMaximumBytes
        : chatOutgoingMediaMaximumBytes;
}

type RequestedByteRange =
    | Readonly<{ end?: number; kind: "from"; start: number }>
    | Readonly<{ kind: "suffix"; length: number }>;

function requestedByteRange(value: string | undefined): RequestedByteRange | undefined {
    if (value === undefined) return undefined;
    const from = /^bytes=([0-9]+)-([0-9]*)$/u.exec(value);
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
    const suffix = /^bytes=-([0-9]+)$/u.exec(value);
    if (suffix === null) return undefined;
    const length = Number(suffix[1]);
    return Number.isSafeInteger(length) && length > 0
        ? { kind: "suffix", length }
        : undefined;
}

function validPartialContentRange(
    value: string | null,
    requestRange: RequestedByteRange | undefined,
    segmentBytes: number | undefined,
    maximumTotalBytes: number
): boolean {
    if (value === null || value.length > 128 || requestRange === undefined) {
        return false;
    }
    const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/u.exec(value);
    if (match === null) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        !Number.isSafeInteger(total) ||
        total < 1 ||
        total > maximumTotalBytes ||
        end < start ||
        end >= total ||
        (segmentBytes !== undefined && end - start + 1 !== segmentBytes)
    ) {
        return false;
    }
    return requestRange.kind === "from"
        ? start === requestRange.start &&
              (requestRange.end === undefined || end <= requestRange.end)
        : end === total - 1 &&
              start === Math.max(0, total - requestRange.length) &&
              end - start + 1 <= requestRange.length;
}

function mediaResponseHeaders(
    upstream: Response,
    reference: ChatMediaReference,
    disposition: ChatMediaDisposition,
    bodyBytes?: number
): Headers {
    const mimeType = normalizedResponseMimeType(upstream.headers.get("content-type"));
    const inline =
        disposition === "preview" &&
        (safeInlineMimeTypes.has(mimeType) || safePreviewTextMimeTypes.has(mimeType));
    const headers = new Headers({
        "cache-control": "private, no-store",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="attachment-${reference.attachmentId}"`,
        "content-security-policy": "sandbox; default-src 'none'",
        "content-type": mimeType,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
    });
    if (bodyBytes !== undefined) headers.set("content-length", String(bodyBytes));
    if (upstream.headers.get("accept-ranges")?.toLowerCase() === "bytes") {
        headers.set("accept-ranges", "bytes");
    }
    const contentRange = upstream.headers.get("content-range");
    if (
        contentRange !== null &&
        contentRange.length <= 128 &&
        safeContentRangePattern.test(contentRange)
    ) {
        headers.set("content-range", contentRange);
    }
    return headers;
}

async function proxyMedia(
    request: Request,
    reference: ChatMediaReference,
    disposition: ChatMediaDisposition,
    options: ChatRawHttpHandlerOptions,
    downloadLease: RawHttpWorkLease
): Promise<Response> {
    try {
        const range = request.headers.get("range")?.trim();
        if (range !== undefined && !singleRangePattern.test(range)) {
            return new Response(null, {
                headers: {
                    "cache-control": "no-store",
                    "content-range": "bytes */*",
                },
                status: 416,
            });
        }
        const parsedRequestRange = requestedByteRange(range);
        if (range !== undefined && parsedRequestRange === undefined) {
            return new Response(null, {
                headers: {
                    "cache-control": "no-store",
                    "content-range": "bytes */*",
                },
                status: 416,
            });
        }
        let upstream: Response;
        try {
            upstream = await options.mediaFetcher.fetch({
                attachmentId: reference.attachmentId,
                method: request.method as "GET" | "HEAD",
                ...(range === undefined ? {} : { range }),
                sessionKey: reference.sessionKey,
                signal: request.signal,
                source: reference.source,
            });
        } catch {
            return noStoreResponse("Bad Gateway", 502);
        }
        if (upstream.status === 404) {
            await upstream.body
                ?.cancel("Discarded outgoing chat media response")
                .catch(() => {});
            return noStoreResponse("Not found", 404);
        }
        if (![200, 206, 416].includes(upstream.status)) {
            await upstream.body
                ?.cancel("Rejected outgoing chat media response")
                .catch(() => {});
            return noStoreResponse("Bad Gateway", 502);
        }
        if (upstream.status === 416) {
            await upstream.body
                ?.cancel("Discarded outgoing chat media response")
                .catch(() => {});
            return new Response(null, {
                headers: mediaResponseHeaders(upstream, reference, disposition),
                status: 416,
            });
        }
        const mimeType = normalizedResponseMimeType(upstream.headers.get("content-type"));
        if (
            disposition === "preview" &&
            !safeInlineMimeTypes.has(mimeType) &&
            !safePreviewTextMimeTypes.has(mimeType)
        ) {
            await upstream.body
                ?.cancel("Outgoing chat media is not preview-safe")
                .catch(() => {});
            return noStoreResponse("Unsupported Media Type", 415);
        }
        const maximumBytes = responseBodyMaximumBytes(mimeType, disposition);
        if (request.method === "HEAD") {
            await upstream.body
                ?.cancel("Discarded outgoing chat media HEAD body")
                .catch(() => {});
            const declared = upstream.headers.get("content-length")?.trim();
            const declaredBytes =
                declared !== undefined && /^\d+$/u.test(declared)
                    ? Number(declared)
                    : undefined;
            if (declaredBytes !== undefined && declaredBytes > maximumBytes) {
                return noStoreResponse("Bad Gateway", 502);
            }
            if (
                upstream.status === 206 &&
                (declaredBytes === undefined ||
                    !validPartialContentRange(
                        upstream.headers.get("content-range"),
                        parsedRequestRange,
                        declaredBytes,
                        maximumBytes
                    ))
            ) {
                return noStoreResponse("Bad Gateway", 502);
            }
            return new Response(null, {
                headers: mediaResponseHeaders(
                    upstream,
                    reference,
                    disposition,
                    declaredBytes
                ),
                status: upstream.status,
            });
        }
        if (
            upstream.status === 206 &&
            !validPartialContentRange(
                upstream.headers.get("content-range"),
                parsedRequestRange,
                undefined,
                maximumBytes
            )
        ) {
            await upstream.body
                ?.cancel("Rejected oversized outgoing chat media range")
                .catch(() => {});
            return noStoreResponse("Bad Gateway", 502);
        }
        const body = await boundedUpstreamBody(upstream, maximumBytes);
        if (body === undefined) return noStoreResponse("Bad Gateway", 502);
        if (
            upstream.status === 206 &&
            !validPartialContentRange(
                upstream.headers.get("content-range"),
                parsedRequestRange,
                body.byteLength,
                maximumBytes
            )
        ) {
            return noStoreResponse("Bad Gateway", 502);
        }
        return new Response(body, {
            headers: mediaResponseHeaders(
                upstream,
                reference,
                disposition,
                body.byteLength
            ),
            status: upstream.status,
        });
    } finally {
        downloadLease.release();
    }
}

/**
 * Builds the strict same-origin raw upload and opaque outgoing-media proxy router.
 * @param options Authentication, storage, association, and upstream fetch ports.
 * @returns Raw HTTP handler for chat attachment and media paths.
 */
export function createChatRawHttpHandler(
    options: ChatRawHttpHandlerOptions
): ChatRawHttpHandler {
    const workLimits = options.workLimits ?? chatRawHttpDefaultWorkLimits;
    const scheduler = options.scheduler ?? defaultChatRawHttpScheduler;
    const uploadTimeoutMs = options.uploadTimeoutMs ?? chatAttachmentUploadTimeoutMs;
    if (
        !Number.isSafeInteger(uploadTimeoutMs) ||
        uploadTimeoutMs < 1 ||
        uploadTimeoutMs > chatAttachmentUploadTimeoutMs
    ) {
        throw new TypeError("Chat attachment upload timeout is invalid");
    }
    const uploadAdmission = createRawHttpWorkAdmission(
        workLimits.maximumConcurrentUploads,
        workLimits.maximumUploadBytes
    );
    const downloadAdmission = createRawHttpWorkAdmission(
        workLimits.maximumConcurrentDownloads,
        workLimits.maximumDownloadBytes
    );
    let mediaReferenceRefresh:
        | Readonly<{
              wait: Promise<void>;
              work: Promise<void>;
          }>
        | undefined;
    let mediaReferenceRefreshNotBeforeMs = 0;
    const refreshMediaReferences = async (): Promise<void> => {
        if (options.refreshMediaReferences === undefined) return;
        const activeRefresh = mediaReferenceRefresh;
        if (activeRefresh !== undefined) {
            await activeRefresh.wait;
            return;
        }
        const startedAtMs = Date.now();
        if (startedAtMs < mediaReferenceRefreshNotBeforeMs) return;
        mediaReferenceRefreshNotBeforeMs =
            startedAtMs + chatMediaReferenceRefreshCooldownMs;
        const deadlineController = new AbortController();
        let rejectDeadline!: (reason: unknown) => void;
        const deadline = new Promise<never>((_resolve, reject) => {
            rejectDeadline = reject;
        });
        const deadlineHandle = scheduler.setTimeout(() => {
            deadlineController.abort();
            rejectDeadline(new DOMException("The operation timed out", "TimeoutError"));
        }, chatMediaReferenceRefreshTimeoutMs);
        const work = Promise.resolve().then(() =>
            options.refreshMediaReferences!(deadlineController.signal)
        );
        const wait = Promise.race([work, deadline]);
        const refresh = Object.freeze({ wait, work });
        mediaReferenceRefresh = refresh;
        void work
            .finally(() => {
                scheduler.clearTimeout(deadlineHandle);
                if (mediaReferenceRefresh?.work === work)
                    mediaReferenceRefresh = undefined;
            })
            .catch(() => {});
        await wait;
    };
    return async (request, requestUrl) => {
        const attachment = attachmentPathPattern.exec(requestUrl.pathname);
        const media = mediaPathPattern.exec(requestUrl.pathname);
        if (attachment === null && media === null) {
            return requestUrl.pathname.startsWith("/api/chat/")
                ? noStoreResponse("Not found", 404)
                : undefined;
        }
        if (attachment !== null && request.method !== "PUT") {
            return methodNotAllowed("PUT");
        }
        if (media !== null && request.method !== "GET" && request.method !== "HEAD") {
            return methodNotAllowed("GET, HEAD");
        }
        if (attachment !== null && requestUrl.search !== "") {
            return noStoreResponse("Not found", 404);
        }
        const disposition = requestUrl.searchParams.get("disposition");
        if (
            media !== null &&
            (requestUrl.searchParams.size !== 1 ||
                (disposition !== "download" && disposition !== "preview"))
        ) {
            return noStoreResponse("Not found", 404);
        }
        const authentication = await authenticate(request, options);
        if ("response" in authentication) return authentication.response;

        if (attachment !== null) {
            if (!hasCapability(authentication.principal, "chat:write")) {
                return noStoreResponse("Forbidden", 403);
            }
            const length = declaredContentLength(request);
            const contentType = request.headers.get("content-type");
            if (
                length === undefined ||
                length < 1 ||
                length > chatAttachmentLimits.maximumFileBytes ||
                contentType === null
            ) {
                await request.body
                    ?.cancel("Invalid chat attachment declaration")
                    .catch(() => {});
                return noStoreResponse("Invalid attachment", 400);
            }
            const uploadLease = uploadAdmission.tryAcquire(length);
            if (uploadLease === undefined) {
                await request.body
                    ?.cancel("Chat attachment upload capacity exceeded")
                    .catch(() => {});
                return noStoreResponse("Upload capacity exceeded", 429);
            }
            const deadlineController = new AbortController();
            const uploadSignal = AbortSignal.any([
                request.signal,
                deadlineController.signal,
            ]);
            const deadlineHandle = scheduler.setTimeout(
                () => deadlineController.abort(),
                uploadTimeoutMs
            );
            try {
                let bytes: Uint8Array | undefined;
                try {
                    bytes = await readExactBody(request, length, uploadSignal);
                } catch (error) {
                    if (
                        error instanceof ChatAttachmentUploadAbortedError &&
                        deadlineController.signal.aborted &&
                        !request.signal.aborted
                    ) {
                        return noStoreResponse("Upload timed out", 408);
                    }
                    throw error;
                }
                if (bytes === undefined) {
                    return noStoreResponse("Invalid attachment", 400);
                }
                try {
                    await options.attachmentStore.upload({
                        actorId: authentication.principal.id,
                        attachmentId: attachment[2]!,
                        bytes,
                        contentType,
                        ticketId: attachment[1]!,
                    });
                } catch {
                    return noStoreResponse("Attachment unavailable", 404);
                }
                return noStoreResponse(null, 204);
            } finally {
                scheduler.clearTimeout(deadlineHandle);
                uploadLease.release();
            }
        }

        if (!hasCapability(authentication.principal, "chat:read")) {
            return noStoreResponse("Forbidden", 403);
        }
        const downloadLease = downloadAdmission.tryAcquire(
            request.method === "GET" ? chatOutgoingMediaMaximumBytes : 1
        );
        if (downloadLease === undefined) {
            return noStoreResponse("Media capacity exceeded", 429);
        }
        let proxyOwnsDownloadLease = false;
        try {
            let reference = options.mediaReferences.resolve(media![1]!);
            if (reference === undefined) {
                try {
                    await refreshMediaReferences();
                } catch {
                    // A refresh failure is intentionally indistinguishable from absence.
                }
                reference = options.mediaReferences.resolve(media![1]!);
            }
            if (reference === undefined) return noStoreResponse("Not found", 404);
            let authorized: boolean;
            try {
                authorized = await options.authorizeMedia(
                    {
                        attachmentId: reference.attachmentId,
                        messageId: reference.messageId,
                        principal: authentication.principal,
                        sessionKey: reference.sessionKey,
                    },
                    request.signal
                );
            } catch {
                authorized = false;
            }
            if (!authorized) return noStoreResponse("Not found", 404);
            proxyOwnsDownloadLease = true;
            return proxyMedia(
                request,
                reference,
                disposition as ChatMediaDisposition,
                options,
                downloadLease
            );
        } finally {
            if (!proxyOwnsDownloadLease) downloadLease.release();
        }
    };
}

export interface OpenClawOutgoingMediaFetcherOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly gatewayUrl: string;
    readonly timeoutMs?: number;
    readonly token: Redacted.Redacted<string>;
}

/**
 * Creates the server-only bearer fetcher; redirects are never followed.
 * @param options Gateway URL, redacted token, timeout, and optional fetch port.
 * @returns Opaque outgoing-media fetcher.
 */
export function createOpenClawOutgoingMediaFetcher(
    options: OpenClawOutgoingMediaFetcherOptions
): OpenClawOutgoingMediaFetcher {
    const base = new URL(options.gatewayUrl);
    if (base.username !== "" || base.password !== "") {
        throw new TypeError("OpenClaw media Gateway URL is invalid");
    }
    if (base.protocol === "ws:") base.protocol = "http:";
    else if (base.protocol === "wss:") base.protocol = "https:";
    else if (base.protocol !== "http:" && base.protocol !== "https:") {
        throw new TypeError("OpenClaw media Gateway URL is invalid");
    }
    base.pathname = "/";
    base.search = "";
    base.hash = "";
    const token = Redacted.value(options.token);
    if (token.length === 0 || Buffer.byteLength(token, "utf8") > 16 * 1024) {
        throw new TypeError("OpenClaw media Gateway credential is invalid");
    }
    const timeoutMs = options.timeoutMs ?? chatOutgoingMediaTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw new TypeError("OpenClaw media timeout is invalid");
    }
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    return Object.freeze({
        async fetch(request: OpenClawOutgoingMediaRequest): Promise<Response> {
            if (request.source.kind !== "gateway-managed") {
                return new Response(null, { status: 404 });
            }
            const url = new URL(
                `/api/chat/media/outgoing/${encodeURIComponent(
                    request.sessionKey
                )}/${request.source.upstreamAttachmentId}/full`,
                base
            );
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            const signal = AbortSignal.any([request.signal, timeoutSignal]);
            return fetchImplementation(url, {
                headers: {
                    authorization: `Bearer ${token}`,
                    ...(request.range === undefined ? {} : { range: request.range }),
                },
                method: request.method,
                redirect: "manual",
                signal,
            });
        },
    });
}
