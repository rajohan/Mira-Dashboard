import { describe, expect, jest, test } from "bun:test";

import { Redacted } from "effect";

import { chatAttachmentLimits } from "../../contracts/chatMedia.ts";
import type { AuthenticatedPrincipal } from "../../contracts/security.ts";
import { createInMemoryChatAttachmentStore } from "../platform/chat/inMemoryChatAttachmentStore.ts";
import { createInMemoryChatMediaReferences } from "../platform/chat/inMemoryChatMediaReferences.ts";
import { dashboardSessionCookieName } from "./authenticationCredentials.ts";
import {
    chatMessageAuthorizesMediaReference,
    chatMediaReferenceRefreshCooldownMs,
    chatMediaReferenceRefreshTimeoutMs,
    chatOutgoingMediaMaximumBytes,
    chatOutgoingTextPreviewMaximumBytes,
    createChatMediaSourceFetcher,
    createChatRawHttpHandler,
    createOpenClawOutgoingMediaFetcher,
    type ChatRawHttpHandler,
    type ChatRawHttpScheduler,
    type ChatRawHttpWorkLimits,
    type OpenClawOutgoingMediaRequest,
} from "./chatMedia.ts";

const origin = "https://dashboard.example.test";
const sessionToken = `${"0".repeat(32)}.${"1".repeat(64)}`;
const ownerId = "019fe633-9133-7ba0-8b80-809dd80dfb40";
const otherOwnerId = "019fe633-9133-7ba0-8b80-809dd80dfb41";
const ticketId = "00000000-0000-4000-8000-000000000001";
const attachmentId = "00000000-0000-4000-8000-000000000002";
const crossSessionAttachmentId = "00000000-0000-4000-8000-000000000003";
const unknownMessageAttachmentId = "00000000-0000-4000-8000-000000000004";
const mismatchedAttachmentId = "00000000-0000-4000-8000-000000000005";
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const singleChatMediaWorkLimits: ChatRawHttpWorkLimits = {
    maximumConcurrentDownloads: 1,
    maximumConcurrentUploads: 1,
    maximumDownloadBytes: chatOutgoingMediaMaximumBytes,
    maximumUploadBytes: chatAttachmentLimits.maximumFileBytes,
};

class ManualChatRawHttpScheduler implements ChatRawHttpScheduler {
    readonly #entries = new Map<
        object,
        { readonly callback: () => void; readonly dueAtMs: number }
    >();
    #nowMs = 0;

    get pendingCount(): number {
        return this.#entries.size;
    }

    advance(milliseconds: number): void {
        this.#nowMs += milliseconds;
        const due = [...this.#entries.entries()]
            .filter(([, entry]) => entry.dueAtMs <= this.#nowMs)
            .toSorted((left, right) => left[1].dueAtMs - right[1].dueAtMs);
        for (const [handle, entry] of due) {
            this.#entries.delete(handle);
            entry.callback();
        }
    }

    clearTimeout = (handle: object): void => {
        this.#entries.delete(handle);
    };

    setTimeout = (callback: () => void, delayMs: number): object => {
        const handle = Object.freeze({});
        this.#entries.set(handle, { callback, dueAtMs: this.#nowMs + delayMs });
        return handle;
    };
}

function principal(
    id = ownerId,
    capabilities: AuthenticatedPrincipal["capabilities"] = ["chat:read", "chat:write"]
): AuthenticatedPrincipal {
    return {
        authorizationVersion: 1,
        authenticatorId: "0".repeat(32),
        capabilities,
        id,
        kind: "session",
    } as unknown as AuthenticatedPrincipal;
}

function authenticatedRequest(
    path: string,
    init: RequestInit = {},
    requestOrigin = origin
): Request {
    const headers = new Headers(init.headers);
    headers.set("cookie", `${dashboardSessionCookieName}=${sessionToken}`);
    headers.set("origin", requestOrigin);
    headers.set("sec-fetch-site", "same-origin");
    return new Request(`${origin}${path}`, { ...init, headers });
}

function authentication(principalValue: AuthenticatedPrincipal) {
    return () => ({
        authentication: { kind: "authenticated" as const, principal: principalValue },
        lease: {
            expiresAtMs: 4_000_000_000_000_000,
            revalidate: () => Promise.resolve(),
        },
    });
}

async function handlerStatus(
    handler: ChatRawHttpHandler,
    request: Request
): Promise<number | undefined> {
    const response = await handler(request, new URL(request.url));
    return response?.status;
}

function requestInputUrl(input: string | URL | Request): string {
    if (typeof input === "string") return input;
    return input instanceof URL ? input.href : input.url;
}

describe("chat raw HTTP media boundary", () => {
    test("accepts one exact same-origin authenticated raw upload and rejects declaration/source defects", async () => {
        const ids = [ticketId, attachmentId];
        const store = createInMemoryChatAttachmentStore({
            createId: () => ids.shift()!,
            nowMs: () => 1000,
        });
        const prepared = await store.prepare(
            {
                files: [
                    {
                        fileName: "diagram.png",
                        mimeType: "image/png",
                        sizeBytes: png.length,
                    },
                ],
                idempotencyKey: "A".repeat(32),
                sessionKey: "agent:main:main",
            },
            ownerId
        );
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => false,
            browserOrigin: origin,
            mediaFetcher: { fetch: () => Promise.reject(new Error("unused")) },
            mediaReferences: references,
        });
        const uploadPath = prepared.uploads[0]!.uploadUrl;
        const upload = authenticatedRequest(uploadPath, {
            body: png,
            headers: {
                "content-length": String(png.length),
                "content-type": "image/png",
            },
            method: "PUT",
        });
        expect(await handlerStatus(handler, upload)).toBe(204);

        const exactRetry = authenticatedRequest(uploadPath, {
            body: png,
            headers: {
                "content-length": String(png.length),
                "content-type": "image/png",
            },
            method: "PUT",
        });
        expect(await handlerStatus(handler, exactRetry)).toBe(204);
        const wrongLength = authenticatedRequest(uploadPath, {
            body: png,
            headers: {
                "content-length": String(png.length + 1),
                "content-type": "image/png",
            },
            method: "PUT",
        });
        expect(await handlerStatus(handler, wrongLength)).toBe(400);
        const crossOrigin = authenticatedRequest(
            uploadPath,
            {
                body: png,
                headers: {
                    "content-length": String(png.length),
                    "content-type": "image/png",
                },
                method: "PUT",
            },
            "https://attacker.example.test"
        );
        expect(await handlerStatus(handler, crossOrigin)).toBe(403);
        store.dispose();
        references.dispose();
    });

    test("admits bounded parallel uploads and releases capacity after completion and abort", async () => {
        const ids = [ticketId, attachmentId];
        const store = createInMemoryChatAttachmentStore({
            createId: () => ids.shift()!,
            nowMs: () => 1000,
        });
        const prepared = await store.prepare(
            {
                files: [
                    {
                        fileName: "diagram.png",
                        mimeType: "image/png",
                        sizeBytes: png.length,
                    },
                ],
                idempotencyKey: "B".repeat(32),
                sessionKey: "agent:main:main",
            },
            ownerId
        );
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => false,
            browserOrigin: origin,
            mediaFetcher: { fetch: () => Promise.reject(new Error("unused")) },
            mediaReferences: references,
            workLimits: singleChatMediaWorkLimits,
        });
        const firstRead = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        let firstEmitted = false;
        const firstBody = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (firstEmitted) return;
                firstEmitted = true;
                firstRead.resolve();
                await releaseFirst.promise;
                controller.enqueue(png);
                controller.close();
            },
        });
        const uploadPath = prepared.uploads[0]!.uploadUrl;
        const firstRequest = authenticatedRequest(uploadPath, {
            body: firstBody,
            headers: {
                "content-length": String(png.length),
                "content-type": "image/png",
            },
            method: "PUT",
        });
        const firstResponse = handler(firstRequest, new URL(firstRequest.url));
        await firstRead.promise;

        let deniedBodyCancellations = 0;
        const deniedBody = new ReadableStream<Uint8Array>({
            cancel() {
                deniedBodyCancellations += 1;
            },
        });
        const deniedRequest = authenticatedRequest(uploadPath, {
            body: deniedBody,
            headers: {
                "content-length": String(png.length),
                "content-type": "image/png",
            },
            method: "PUT",
        });
        expect(await handlerStatus(handler, deniedRequest)).toBe(429);
        expect(deniedBodyCancellations).toBe(1);

        releaseFirst.resolve();
        const completedFirstResponse = await firstResponse;
        expect(completedFirstResponse?.status).toBe(204);
        const afterRelease = authenticatedRequest(uploadPath, {
            body: png,
            headers: {
                "content-length": String(png.length),
                "content-type": "image/png",
            },
            method: "PUT",
        });
        expect(await handlerStatus(handler, afterRelease)).toBe(204);

        const abortRead = Promise.withResolvers<void>();
        const releaseAbort = Promise.withResolvers<void>();
        let abortEmitted = false;
        const abortBody = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (abortEmitted) return;
                abortEmitted = true;
                abortRead.resolve();
                await releaseAbort.promise;
                controller.enqueue(png);
                controller.close();
            },
        });
        const abortController = new AbortController();
        const abortedRequest = authenticatedRequest(uploadPath, {
            body: abortBody,
            headers: {
                "content-length": String(png.length),
                "content-type": "image/png",
            },
            method: "PUT",
            signal: abortController.signal,
        });
        const abortedResponse = handler(abortedRequest, new URL(abortedRequest.url));
        await abortRead.promise;
        abortController.abort();
        releaseAbort.resolve();
        const abortedStatus = await abortedResponse.then(
            (response) => response?.status,
            () => null
        );
        expect(abortedStatus).not.toBe(204);

        const afterAbort = authenticatedRequest(uploadPath, {
            body: png,
            headers: {
                "content-length": String(png.length),
                "content-type": "image/png",
            },
            method: "PUT",
        });
        expect(await handlerStatus(handler, afterAbort)).toBe(204);
        store.dispose();
        references.dispose();
    });

    test("enforces an absolute upload deadline and releases the admission slot", async () => {
        const ids = [ticketId, attachmentId];
        const store = createInMemoryChatAttachmentStore({
            createId: () => ids.shift()!,
            nowMs: () => 1000,
        });
        const prepared = await store.prepare(
            {
                files: [
                    {
                        fileName: "diagram.png",
                        mimeType: "image/png",
                        sizeBytes: png.length,
                    },
                ],
                idempotencyKey: "C".repeat(32),
                sessionKey: "agent:main:main",
            },
            ownerId
        );
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        const scheduler = new ManualChatRawHttpScheduler();
        let stalledController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let bodyCancellations = 0;
        const stalledBody = new ReadableStream<Uint8Array>({
            cancel() {
                bodyCancellations += 1;
            },
            start(controller) {
                stalledController = controller;
            },
        });
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => false,
            browserOrigin: origin,
            mediaFetcher: { fetch: () => Promise.reject(new Error("unused")) },
            mediaReferences: references,
            scheduler,
            uploadTimeoutMs: 100,
            workLimits: singleChatMediaWorkLimits,
        });
        const uploadPath = prepared.uploads[0]!.uploadUrl;
        const stalledRequest = authenticatedRequest(uploadPath, {
            body: stalledBody,
            headers: {
                "content-length": String(png.length),
                "content-type": "image/png",
            },
            method: "PUT",
        });
        const stalledResponse = handler(stalledRequest, new URL(stalledRequest.url));
        for (
            let attempt = 0;
            attempt < 20 && scheduler.pendingCount === 0;
            attempt += 1
        ) {
            await Promise.resolve();
        }
        expect(scheduler.pendingCount).toBe(1);

        scheduler.advance(30);
        stalledController?.enqueue(Uint8Array.of(1));
        await Promise.resolve();
        scheduler.advance(30);
        stalledController?.enqueue(Uint8Array.of(2));
        await Promise.resolve();
        scheduler.advance(40);

        const completedStalledResponse = await stalledResponse;
        expect(completedStalledResponse?.status).toBe(408);
        expect(bodyCancellations).toBe(1);
        expect(scheduler.pendingCount).toBe(0);

        const replacement = authenticatedRequest(uploadPath, {
            body: png,
            headers: {
                "content-length": String(png.length),
                "content-type": "image/png",
            },
            method: "PUT",
        });
        expect(await handlerStatus(handler, replacement)).toBe(204);
        expect(scheduler.pendingCount).toBe(0);
        store.dispose();
        references.dispose();
    });

    test("proxies only an authorized transcript-associated reference with exact Range security", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        references.register({
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        });
        references.register({
            attachmentId: crossSessionAttachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:other",
        });
        references.register({
            attachmentId: unknownMessageAttachmentId,
            messageId: "message-unknown",
            sessionKey: "agent:main:main",
        });
        references.register({
            attachmentId: mismatchedAttachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        });
        const fetches: OpenClawOutgoingMediaRequest[] = [];
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: ({ principal: actor, sessionKey, ...reference }) =>
                actor.id === ownerId &&
                sessionKey === "agent:main:main" &&
                chatMessageAuthorizesMediaReference(
                    {
                        message: {
                            content: {
                                kind: "complete",
                                parts: [
                                    {
                                        fileName: "diagram.png",
                                        id: "attachment-part-1",
                                        kind: "attachment",
                                        mediaType: "image/png",
                                        renderPolicy: "inline-image",
                                        url: `/api/chat/media/${attachmentId}?disposition=preview`,
                                    },
                                ],
                            },
                            id: "message-1",
                            role: "assistant",
                            source: "gateway-history",
                        },
                        status: "available",
                    },
                    reference
                ),
            browserOrigin: origin,
            mediaFetcher: {
                fetch: (request) => {
                    fetches.push(request);
                    return Promise.resolve(
                        new Response(png.slice(0, 4), {
                            headers: {
                                "accept-ranges": "bytes",
                                "content-range": `bytes 0-3/${png.length}`,
                                "content-type": "image/png",
                            },
                            status: 206,
                        })
                    );
                },
            },
            mediaReferences: references,
        });
        const request = authenticatedRequest(
            `/api/chat/media/${attachmentId}?disposition=preview`,
            { headers: { range: "bytes=0-3" } }
        );
        const response = await handler(request, new URL(request.url));
        expect(response?.status).toBe(206);
        expect(response?.headers.get("content-range")).toBe(`bytes 0-3/${png.length}`);
        expect(response?.headers.get("content-disposition")).toBe(
            `inline; filename="attachment-${attachmentId}"`
        );
        expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
        expect(fetches).toHaveLength(1);
        expect(fetches[0]).toMatchObject({
            attachmentId,
            method: "GET",
            range: "bytes=0-3",
            sessionKey: "agent:main:main",
        });

        for (const deniedId of [
            crossSessionAttachmentId,
            unknownMessageAttachmentId,
            mismatchedAttachmentId,
            "00000000-0000-4000-8000-000000000006",
        ]) {
            const denied = authenticatedRequest(
                `/api/chat/media/${deniedId}?disposition=preview`
            );
            expect(await handlerStatus(handler, denied)).toBe(404);
        }
        expect(fetches).toHaveLength(1);

        const invalidRange = authenticatedRequest(
            `/api/chat/media/${attachmentId}?disposition=preview`,
            { headers: { range: "bytes=0-1,4-5" } }
        );
        expect(await handlerStatus(handler, invalidRange)).toBe(416);
        expect(fetches).toHaveLength(1);
        store.dispose();
        references.dispose();
    });

    test("reauthorizes an expired media association before rejecting it", async () => {
        const now = { value: 1000 };
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences({
            nowMs: () => now.value,
            ttlMs: 1000,
        });
        const reference = {
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        };
        references.register(reference);
        now.value = 2000;
        let authorizationCount = 0;
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: (input) => {
                authorizationCount += 1;
                expect(input).toMatchObject(reference);
                references.register(reference);
                return true;
            },
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () =>
                    Promise.resolve(
                        new Response(png, { headers: { "content-type": "image/png" } })
                    ),
            },
            mediaReferences: references,
        });

        for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
            const request = authenticatedRequest(
                `/api/chat/media/${attachmentId}?disposition=preview`
            );
            expect(await handlerStatus(handler, request)).toBe(200);
        }
        expect(authorizationCount).toBe(2);
        store.dispose();
        references.dispose();
    });

    test("reauthorizes a local-history reference before dispatching any file read", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences();
        references.register({
            attachmentId,
            messageId: "message-local",
            sessionKey: "agent:main:main",
            source: {
                kind: "openclaw-local-history",
                segments: ["history", "private.png"],
            },
        });
        let fetchCount = 0;
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => false,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () => {
                    fetchCount += 1;
                    return Promise.resolve(
                        new Response(png, { headers: { "content-type": "image/png" } })
                    );
                },
            },
            mediaReferences: references,
        });
        const request = authenticatedRequest(
            `/api/chat/media/${attachmentId}?disposition=preview`
        );

        expect(await handlerStatus(handler, request)).toBe(404);
        expect(fetchCount).toBe(0);
        store.dispose();
        references.dispose();
    });

    test("refreshes an empty post-restart reference cache before returning 404", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences();
        let refreshCount = 0;
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: ({ attachmentId: candidate }) => candidate === attachmentId,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () =>
                    Promise.resolve(
                        new Response(png, { headers: { "content-type": "image/png" } })
                    ),
            },
            mediaReferences: references,
            refreshMediaReferences: () => {
                refreshCount += 1;
                references.register({
                    attachmentId,
                    messageId: "message-after-restart",
                    sessionKey: "agent:main:main",
                });
                return Promise.resolve();
            },
        });

        const request = authenticatedRequest(
            `/api/chat/media/${attachmentId}?disposition=download`
        );
        expect(await handlerStatus(handler, request)).toBe(200);
        expect(refreshCount).toBe(1);
        store.dispose();
        references.dispose();
    });

    test("shares one complete restart refresh across concurrent media ids", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences();
        let refreshCount = 0;
        let releaseRefresh!: () => void;
        let markRefreshStarted!: () => void;
        const refreshStarted = new Promise<void>((resolve) => {
            markRefreshStarted = resolve;
        });
        const refreshReleased = new Promise<void>((resolve) => {
            releaseRefresh = resolve;
        });
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () =>
                    Promise.resolve(
                        new Response(png, { headers: { "content-type": "image/png" } })
                    ),
            },
            mediaReferences: references,
            workLimits: {
                ...singleChatMediaWorkLimits,
                maximumConcurrentDownloads: 2,
                maximumDownloadBytes: 2 * chatOutgoingMediaMaximumBytes,
            },
            refreshMediaReferences: async () => {
                refreshCount += 1;
                markRefreshStarted();
                await refreshReleased;
                for (const candidate of [attachmentId, crossSessionAttachmentId]) {
                    references.register({
                        attachmentId: candidate,
                        messageId: `message-${candidate}`,
                        sessionKey: "agent:main:main",
                    });
                }
            },
        });

        const first = handlerStatus(
            handler,
            authenticatedRequest(`/api/chat/media/${attachmentId}?disposition=download`)
        );
        await refreshStarted;
        const second = handlerStatus(
            handler,
            authenticatedRequest(
                `/api/chat/media/${crossSessionAttachmentId}?disposition=download`
            )
        );
        await Promise.resolve();
        expect(refreshCount).toBe(1);

        releaseRefresh();
        expect(await Promise.all([first, second])).toEqual([200, 200]);
        store.dispose();
        references.dispose();
    });

    test("does not reserve media capacity for cache-miss refreshes and cools repeated misses", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences();
        references.register({
            attachmentId: unknownMessageAttachmentId,
            messageId: "message-local",
            sessionKey: "agent:main:main",
            source: {
                kind: "openclaw-local-history",
                segments: ["history", "private.png"],
            },
        });
        let refreshCount = 0;
        let localFetchCount = 0;
        let releaseRefresh!: () => void;
        const refreshReleased = new Promise<void>((resolve) => {
            releaseRefresh = resolve;
        });
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: (request) => {
                    expect(request.source.kind).toBe("openclaw-local-history");
                    localFetchCount += 1;
                    return Promise.resolve(new Response(png));
                },
            },
            mediaReferences: references,
            refreshMediaReferences: async () => {
                refreshCount += 1;
                await refreshReleased;
            },
            workLimits: singleChatMediaWorkLimits,
        });

        const first = handlerStatus(
            handler,
            authenticatedRequest(`/api/chat/media/${attachmentId}?disposition=download`)
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(
            await handlerStatus(
                handler,
                authenticatedRequest(
                    `/api/chat/media/${unknownMessageAttachmentId}?disposition=download`
                )
            )
        ).toBe(200);
        expect(localFetchCount).toBe(1);
        const sharedMiss = handlerStatus(
            handler,
            authenticatedRequest(
                `/api/chat/media/${crossSessionAttachmentId}?disposition=download`
            )
        );
        await Promise.resolve();
        expect(refreshCount).toBe(1);
        releaseRefresh();
        expect(await Promise.all([first, sharedMiss])).toEqual([404, 404]);
        expect(
            await handlerStatus(
                handler,
                authenticatedRequest(
                    `/api/chat/media/${mismatchedAttachmentId}?disposition=download`
                )
            )
        ).toBe(404);
        expect(refreshCount).toBe(1);
        store.dispose();
        references.dispose();
    });

    test("aborts a cache-miss refresh at its absolute deadline", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences();
        const scheduler = new ManualChatRawHttpScheduler();
        let refreshSignal: AbortSignal | undefined;
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () => Promise.resolve(new Response(png)),
            },
            mediaReferences: references,
            refreshMediaReferences: (signal) => {
                refreshSignal = signal;
                return new Promise<void>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(new DOMException("Aborted", "AbortError")),
                        { once: true }
                    );
                });
            },
            scheduler,
            workLimits: singleChatMediaWorkLimits,
        });

        const request = handlerStatus(
            handler,
            authenticatedRequest(`/api/chat/media/${attachmentId}?disposition=download`)
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(scheduler.pendingCount).toBe(1);
        scheduler.advance(chatMediaReferenceRefreshTimeoutMs);
        expect(await request).toBe(404);
        expect(refreshSignal?.aborted).toBeTrue();
        expect(scheduler.pendingCount).toBe(0);
        store.dispose();
        references.dispose();
    });

    test("releases only the timed-out shared refresh slot when work ignores abort", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences();
        const scheduler = new ManualChatRawHttpScheduler();
        const firstWork = Promise.withResolvers<void>();
        const secondWork = Promise.withResolvers<void>();
        const refreshSignals: AbortSignal[] = [];
        let nowMs = 1000;
        const dateNow = jest.spyOn(Date, "now").mockImplementation(() => nowMs);
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: { fetch: () => Promise.resolve(new Response(png)) },
            mediaReferences: references,
            refreshMediaReferences: (signal) => {
                refreshSignals.push(signal);
                return refreshSignals.length === 1
                    ? firstWork.promise
                    : secondWork.promise;
            },
            scheduler,
            workLimits: {
                ...singleChatMediaWorkLimits,
                maximumConcurrentDownloads: 2,
                maximumDownloadBytes: 2 * chatOutgoingMediaMaximumBytes,
            },
        });
        try {
            const firstRequest = handlerStatus(
                handler,
                authenticatedRequest(
                    `/api/chat/media/${attachmentId}?disposition=download`
                )
            );
            await Promise.resolve();
            await Promise.resolve();
            scheduler.advance(chatMediaReferenceRefreshTimeoutMs);
            expect(await firstRequest).toBe(404);
            expect(refreshSignals).toHaveLength(1);
            expect(refreshSignals[0]?.aborted).toBeTrue();

            expect(
                await handlerStatus(
                    handler,
                    authenticatedRequest(
                        `/api/chat/media/${crossSessionAttachmentId}?disposition=download`
                    )
                )
            ).toBe(404);
            expect(refreshSignals).toHaveLength(1);

            nowMs += chatMediaReferenceRefreshCooldownMs;
            const secondRequest = handlerStatus(
                handler,
                authenticatedRequest(
                    `/api/chat/media/${attachmentId}?disposition=download`
                )
            );
            for (let index = 0; index < 5; index += 1) await Promise.resolve();
            expect(refreshSignals).toHaveLength(2);

            firstWork.resolve();
            await Promise.resolve();
            const sharedSecondRequest = handlerStatus(
                handler,
                authenticatedRequest(
                    `/api/chat/media/${crossSessionAttachmentId}?disposition=download`
                )
            );
            await Promise.resolve();
            expect(refreshSignals).toHaveLength(2);

            secondWork.resolve();
            expect(await Promise.all([secondRequest, sharedSecondRequest])).toEqual([
                404, 404,
            ]);
            expect(scheduler.pendingCount).toBe(0);
        } finally {
            dateNow.mockRestore();
            firstWork.resolve();
            secondWork.resolve();
            store.dispose();
            references.dispose();
        }
    });

    test("denies cross-owner media and forces active SVG content to download", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        references.register({
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        });
        let owner = principal(otherOwnerId);
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: () => authentication(owner)(),
            authorizeMedia: ({ principal: actor }) => actor.id === ownerId,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () =>
                    Promise.resolve(
                        new Response("<svg></svg>", {
                            headers: { "content-type": "image/svg+xml" },
                        })
                    ),
            },
            mediaReferences: references,
        });
        const denied = authenticatedRequest(
            `/api/chat/media/${attachmentId}?disposition=download`
        );
        expect(await handlerStatus(handler, denied)).toBe(404);

        owner = principal(ownerId);
        const allowed = authenticatedRequest(
            `/api/chat/media/${attachmentId}?disposition=download`
        );
        const response = await handler(allowed, new URL(allowed.url));
        expect(response?.status).toBe(200);
        expect(response?.headers.get("content-disposition")).toBe(
            `attachment; filename="attachment-${attachmentId}"`
        );
        expect(response?.headers.get("content-security-policy")).toBe(
            "sandbox; default-src 'none'"
        );
        store.dispose();
        references.dispose();
    });

    test("rejects text overflow, declared-length mismatch, and malformed partial ranges", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        references.register({
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        });
        const largeChunk = new Uint8Array(600 * 1024).fill(0x61);
        const responses: Response[] = [
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(largeChunk);
                        controller.enqueue(largeChunk);
                        controller.close();
                    },
                }),
                { headers: { "content-type": "text/plain" } }
            ),
            new Response(png, {
                headers: {
                    "content-length": String(png.length + 1),
                    "content-type": "image/png",
                },
            }),
            new Response(png.slice(0, 4), {
                headers: {
                    "content-range": "provider-private invalid range",
                    "content-type": "image/png",
                },
                status: 206,
            }),
        ];
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () => Promise.resolve(responses.shift()!),
            },
            mediaReferences: references,
        });

        for (let index = 0; index < 3; index += 1) {
            const request = authenticatedRequest(
                `/api/chat/media/${attachmentId}?disposition=preview`
            );
            const response = await handler(request, new URL(request.url));
            expect(response?.status).toBe(502);
            expect(response?.headers.get("cache-control")).toBe("no-store");
            expect(await response?.text()).not.toContain("provider-private");
        }
        store.dispose();
        references.dispose();
    });

    test("separates the 1 MiB text preview cap from bounded authorized downloads", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        references.register({
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        });
        const textDownload = new Uint8Array(2 * 1024 * 1024).fill(0x61);
        const responses = [
            new Response(textDownload, {
                headers: { "content-type": "text/plain" },
            }),
            new Response(textDownload, {
                headers: { "content-type": "text/plain" },
            }),
        ];
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () => Promise.resolve(responses.shift()!),
            },
            mediaReferences: references,
        });

        const preview = authenticatedRequest(
            `/api/chat/media/${attachmentId}?disposition=preview`
        );
        expect(await handlerStatus(handler, preview)).toBe(502);
        const download = authenticatedRequest(
            `/api/chat/media/${attachmentId}?disposition=download`
        );
        const response = await handler(download, new URL(download.url));
        expect(response?.status).toBe(200);
        expect(response?.headers.get("content-length")).toBe(
            String(textDownload.byteLength)
        );
        expect(response?.headers.get("content-disposition")).toBe(
            `attachment; filename="attachment-${attachmentId}"`
        );

        const missingIntent = authenticatedRequest(`/api/chat/media/${attachmentId}`);
        expect(await handlerStatus(handler, missingIntent)).toBe(404);
        store.dispose();
        references.dispose();
    });

    test("binds every 206 range to the exact request and a valid numeric total", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        references.register({
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        });
        let cancelledHeadBodies = 0;
        const headBody = () =>
            new ReadableStream<Uint8Array>({
                cancel() {
                    cancelledHeadBodies += 1;
                },
            });
        const partial = (contentRange: string, head = false) =>
            new Response(head ? headBody() : png.slice(0, 4), {
                headers: {
                    "content-length": "4",
                    "content-range": contentRange,
                    "content-type": "image/png",
                },
                status: 206,
            });
        const responses = [
            partial("bytes 0-3/3"),
            partial("bytes 4-7/8"),
            partial("bytes 0-3/8"),
            partial("bytes 0-3/8"),
            partial("bytes 0-3/8", true),
            partial("bytes 4-7/8", true),
            new Response(headBody(), { status: 404 }),
        ];
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () => Promise.resolve(responses.shift()!),
            },
            mediaReferences: references,
        });
        const request = (range: string | undefined, method: "GET" | "HEAD" = "GET") =>
            authenticatedRequest(`/api/chat/media/${attachmentId}?disposition=preview`, {
                headers: range === undefined ? {} : { range },
                method,
            });

        for (const range of ["bytes=0-3", "bytes=0-3", undefined, "bytes=-4"]) {
            const candidate = request(range);
            expect(await handlerStatus(handler, candidate)).toBe(502);
        }
        const validHead = request("bytes=0-3", "HEAD");
        expect(await handlerStatus(handler, validHead)).toBe(206);
        const wrongHead = request("bytes=0-3", "HEAD");
        expect(await handlerStatus(handler, wrongHead)).toBe(502);
        const missingHead = request(undefined, "HEAD");
        expect(await handlerStatus(handler, missingHead)).toBe(404);
        expect(cancelledHeadBodies).toBe(3);
        store.dispose();
        references.dispose();
    });

    test("rejects every partial response whose authoritative total exceeds its media budget", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        references.register({
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        });
        const cases = [
            {
                disposition: "download",
                maximumBytes: chatOutgoingMediaMaximumBytes,
                method: "GET",
                mimeType: "image/png",
            },
            {
                disposition: "download",
                maximumBytes: chatOutgoingMediaMaximumBytes,
                method: "HEAD",
                mimeType: "image/png",
            },
            {
                disposition: "preview",
                maximumBytes: chatOutgoingTextPreviewMaximumBytes,
                method: "GET",
                mimeType: "text/plain",
            },
            {
                disposition: "preview",
                maximumBytes: chatOutgoingTextPreviewMaximumBytes,
                method: "HEAD",
                mimeType: "text/plain",
            },
        ] as const;
        let cancelledBodies = 0;
        const responses = cases.map(
            ({ maximumBytes, mimeType }) =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        cancel() {
                            cancelledBodies += 1;
                        },
                    }),
                    {
                        headers: {
                            "content-length": "1",
                            "content-range": `bytes 0-0/${maximumBytes + 1}`,
                            "content-type": mimeType,
                        },
                        status: 206,
                    }
                )
        );
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () => Promise.resolve(responses.shift()!),
            },
            mediaReferences: references,
        });

        for (const { disposition, method } of cases) {
            const request = authenticatedRequest(
                `/api/chat/media/${attachmentId}?disposition=${disposition}`,
                { headers: { range: "bytes=0-0" }, method }
            );
            expect(await handlerStatus(handler, request)).toBe(502);
        }
        expect(cancelledBodies).toBe(cases.length);
        store.dispose();
        references.dispose();
    });

    test("bounds concurrent buffered media GETs and releases the slot after completion", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        references.register({
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        });
        const firstRead = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        let firstEmitted = false;
        const firstBody = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (firstEmitted) return;
                firstEmitted = true;
                firstRead.resolve();
                await releaseFirst.promise;
                controller.enqueue(png);
                controller.close();
            },
        });
        let fetchCount = 0;
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () => {
                    fetchCount += 1;
                    return Promise.resolve(
                        fetchCount === 1
                            ? new Response(firstBody, {
                                  headers: { "content-type": "image/png" },
                              })
                            : new Response(png, {
                                  headers: { "content-type": "image/png" },
                              })
                    );
                },
            },
            mediaReferences: references,
            workLimits: singleChatMediaWorkLimits,
        });
        const request = () =>
            authenticatedRequest(`/api/chat/media/${attachmentId}?disposition=download`);
        const firstRequest = request();
        const firstResponse = handler(firstRequest, new URL(firstRequest.url));
        await firstRead.promise;
        expect(await handlerStatus(handler, request())).toBe(429);
        expect(fetchCount).toBe(1);

        releaseFirst.resolve();
        const completedFirstResponse = await firstResponse;
        expect(completedFirstResponse?.status).toBe(200);
        expect(await handlerStatus(handler, request())).toBe(200);
        expect(fetchCount).toBe(2);
        store.dispose();
        references.dispose();
    });

    test("bounds concurrent media HEAD requests and releases the slot after completion", async () => {
        const store = createInMemoryChatAttachmentStore();
        const references = createInMemoryChatMediaReferences({ nowMs: () => 1000 });
        references.register({
            attachmentId,
            messageId: "message-1",
            sessionKey: "agent:main:main",
        });
        const firstFetch = Promise.withResolvers<Response>();
        const firstFetchStarted = Promise.withResolvers<void>();
        let fetchCount = 0;
        const handler = createChatRawHttpHandler({
            attachmentStore: store,
            authenticateCredential: authentication(principal()),
            authorizeMedia: () => true,
            browserOrigin: origin,
            mediaFetcher: {
                fetch: () => {
                    fetchCount += 1;
                    if (fetchCount === 1) {
                        firstFetchStarted.resolve();
                        return firstFetch.promise;
                    }
                    return Promise.resolve(
                        new Response(null, {
                            headers: {
                                "content-length": String(png.length),
                                "content-type": "image/png",
                            },
                        })
                    );
                },
            },
            mediaReferences: references,
            workLimits: singleChatMediaWorkLimits,
        });
        const request = () =>
            authenticatedRequest(`/api/chat/media/${attachmentId}?disposition=download`, {
                method: "HEAD",
            });
        const firstRequest = request();
        const firstResponse = handler(firstRequest, new URL(firstRequest.url));
        await firstFetchStarted.promise;

        expect(await handlerStatus(handler, request())).toBe(429);
        expect(fetchCount).toBe(1);

        firstFetch.resolve(
            new Response(null, {
                headers: {
                    "content-length": String(png.length),
                    "content-type": "image/png",
                },
            })
        );
        const completedFirstResponse = await firstResponse;
        expect(completedFirstResponse?.status).toBe(200);
        expect(await handlerStatus(handler, request())).toBe(200);
        expect(fetchCount).toBe(2);
        store.dispose();
        references.dispose();
    });

    test("builds an exact server-bearer outgoing URL without following redirects", async () => {
        const observed: Array<{ input: string; init?: RequestInit }> = [];
        const fetcher = createOpenClawOutgoingMediaFetcher({
            fetch: ((input, init) => {
                observed.push({ input: requestInputUrl(input), init });
                return Promise.resolve(new Response(null, { status: 302 }));
            }) as typeof globalThis.fetch,
            gatewayUrl: "ws://127.0.0.1:18789/private?ignored=true",
            token: Redacted.make("gateway-secret", { label: "test" }),
        });
        const response = await fetcher.fetch({
            attachmentId,
            method: "GET",
            range: "bytes=0-3",
            sessionKey: "agent:main:main",
            signal: new AbortController().signal,
            source: {
                kind: "gateway-managed",
                upstreamAttachmentId: attachmentId,
            },
        });

        expect(response.status).toBe(302);
        expect(observed[0]?.input).toBe(
            `http://127.0.0.1:18789/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`
        );
        expect(observed[0]?.init).toMatchObject({
            headers: {
                authorization: "Bearer gateway-secret",
                range: "bytes=0-3",
            },
            method: "GET",
            redirect: "manual",
        });
        expect(JSON.stringify(observed[0]?.input)).not.toContain("gateway-secret");
    });

    test("dispatches only the exact authorized media source without path projection", async () => {
        const managedRequests: OpenClawOutgoingMediaRequest[] = [];
        const localRequests: OpenClawOutgoingMediaRequest[] = [];
        const fetcher = createChatMediaSourceFetcher({
            gatewayManaged: {
                fetch: (request) => {
                    managedRequests.push(request);
                    return Promise.resolve(new Response("managed"));
                },
            },
            localHistory: {
                fetch: (request) => {
                    localRequests.push(request);
                    return Promise.resolve(new Response("local"));
                },
            },
        });
        const sharedRequest = {
            attachmentId,
            method: "GET" as const,
            sessionKey: "agent:main:main",
            signal: new AbortController().signal,
        };

        const managedResponse = await fetcher.fetch({
            ...sharedRequest,
            source: {
                kind: "gateway-managed",
                upstreamAttachmentId: attachmentId,
            },
        });
        expect(await managedResponse.text()).toBe("managed");
        const localResponse = await fetcher.fetch({
            ...sharedRequest,
            source: {
                kind: "openclaw-local-history",
                segments: ["history", "diagram.png"],
            },
        });
        expect(await localResponse.text()).toBe("local");
        expect(managedRequests).toHaveLength(1);
        expect(localRequests).toEqual([
            {
                ...sharedRequest,
                source: {
                    kind: "openclaw-local-history",
                    segments: ["history", "diagram.png"],
                },
            },
        ]);

        const managedOnly = createChatMediaSourceFetcher({
            gatewayManaged: { fetch: () => Promise.resolve(new Response("managed")) },
        });
        const unavailableResponse = await managedOnly.fetch({
            ...sharedRequest,
            source: {
                kind: "openclaw-local-history",
                segments: ["missing.png"],
            },
        });
        expect(unavailableResponse.status).toBe(404);
    });
});
