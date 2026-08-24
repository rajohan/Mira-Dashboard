import { Redacted } from "effect";
import * as v from "valibot";

import {
    deliveryGitHubActorSchema,
    deliveryGitHubMiraLogin,
    deliveryGitHubReviewerLogin,
    deliveryGitHubRepositoryName,
    deliveryGitHubRepositoryOwner,
    type DeliveryGitHubActor,
} from "../../contracts/deliveryGithub.ts";
import { utf8ByteLength } from "../../shared/encoding.ts";

const apiOrigin = "https://api.github.com";
const apiVersion = "2022-11-28";
const userAgent = "mira-dashboard-delivery/1.0";
// One 20-PR GraphQL page can legitimately contain 64 KiB bodies plus up to
// 100 bounded check contexts per PR. Keep the provider boundary finite while
// leaving room for that reviewed page shape before the smaller cache projection.
const responseMaximumBytes = 8 * 1024 * 1024;
const requestMaximumBytes = 256 * 1024;
const defaultDeadlineMs = 60_000;
const defaultReadRetryDelayMs = 250;
const readAttemptMaximum = 3;
const providerActorSchema = v.object({
    id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    login: v.string(),
    type: v.string(),
});

export type DeliveryGitHubFailureReason =
    | "authentication"
    | "capability-unavailable"
    | "conflict"
    | "invalid-input"
    | "limit-exceeded"
    | "partial-success"
    | "unavailable"
    | "unknown-outcome";

export class DeliveryGitHubError extends Error {
    public readonly reason: DeliveryGitHubFailureReason;

    public constructor(reason: DeliveryGitHubFailureReason) {
        super("Delivery GitHub operation failed");
        this.name = "DeliveryGitHubError";
        this.reason = reason;
    }
}

export type DeliveryGitHubHttpOperation =
    | Readonly<{ kind: "identity" }>
    | Readonly<{
          document: string;
          kind: "graphql";
          variables: Readonly<Record<string, boolean | number | string | null>>;
      }>
    | Readonly<{ kind: "main-ref" }>
    | Readonly<{ kind: "latest-release" }>
    | Readonly<{ kind: "release-tag-commit"; tagName: string }>
    | Readonly<{ assetId: number; kind: "release-asset" }>
    | Readonly<{ branch: string; kind: "branch-ref" }>
    | Readonly<{ kind: "native-stack-find"; pullRequestNumber: number }>
    | Readonly<{ kind: "native-stack-create"; pullRequestNumbers: readonly number[] }>
    | Readonly<{
          expectedHeadSha: string;
          kind: "native-stack-merge-start";
          pullRequestNumber: number;
      }>
    | Readonly<{
          kind: "native-stack-merge-poll";
          pullRequestNumber: number;
          uuid: string;
      }>
    | Readonly<{
          expectedHeadSha: string;
          kind: "pull-request-merge";
          pullRequestNumber: number;
      }>
    | Readonly<{
          expectedHeadSha: string;
          kind: "pull-request-update-branch";
          pullRequestNumber: number;
      }>
    | Readonly<{ kind: "pull-request-close"; pullRequestNumber: number }>
    | Readonly<{
          body: string;
          kind: "pull-request-comment";
          pullRequestNumber: number;
      }>
    | Readonly<{
          expectedHeadSha: string;
          kind: "pull-request-review-approve";
          pullRequestNumber: number;
      }>;

export interface DeliveryGitHubHttpTransport {
    readonly actor: typeof deliveryGitHubMiraLogin | typeof deliveryGitHubReviewerLogin;
    readonly requestJson: (
        operation: DeliveryGitHubHttpOperation,
        signal?: AbortSignal
    ) => Promise<unknown>;
    readonly requestJsonWithStatus: (
        operation: DeliveryGitHubHttpOperation,
        signal?: AbortSignal
    ) => Promise<DeliveryGitHubHttpResponse>;
    readonly verifyIdentity: (signal?: AbortSignal) => Promise<DeliveryGitHubActor>;
}

/** Bounded provider response metadata retained only where HTTP semantics are material. */
export interface DeliveryGitHubHttpResponse {
    readonly body: unknown;
    readonly status: number;
}

export type DeliveryGitHubFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface DeliveryGitHubHttpTransportOptions {
    readonly deadlineMs?: number;
    readonly expectedLogin:
        | typeof deliveryGitHubMiraLogin
        | typeof deliveryGitHubReviewerLogin;
    readonly fetch?: DeliveryGitHubFetch;
    readonly readRetryDelayMs?: number;
    readonly token: Redacted.Redacted<string>;
}

interface PreparedRequest {
    readonly accept?: "application/octet-stream";
    readonly body?: string;
    readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    readonly mutation: boolean;
    readonly url: string;
}

function fail(reason: DeliveryGitHubFailureReason): never {
    throw new DeliveryGitHubError(reason);
}

function validPositiveInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function encodePathSegment(value: string): string {
    if (
        value.length === 0 ||
        value.length > 256 ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    ) {
        fail("invalid-input");
    }
    return encodeURIComponent(value);
}

function repositoryPath(path: string): string {
    return `/repos/${deliveryGitHubRepositoryOwner}/${deliveryGitHubRepositoryName}${path}`;
}

function jsonBody(value: unknown): string {
    let encoded: string;
    try {
        encoded = JSON.stringify(value);
    } catch {
        fail("invalid-input");
    }
    if (utf8ByteLength(encoded) > requestMaximumBytes) {
        fail("limit-exceeded");
    }
    return encoded;
}

function prepareRequest(operation: DeliveryGitHubHttpOperation): PreparedRequest {
    let method: PreparedRequest["method"] = "GET";
    let path = "/user";
    let body: string | undefined;
    let mutation = false;
    switch (operation.kind) {
        case "identity": {
            break;
        }
        case "graphql": {
            if (
                operation.document.length === 0 ||
                operation.document.length > 64 * 1024
            ) {
                fail("invalid-input");
            }
            method = "POST";
            path = "/graphql";
            body = jsonBody({
                query: operation.document,
                variables: operation.variables,
            });
            break;
        }
        case "main-ref": {
            path = repositoryPath("/git/ref/heads/main");
            break;
        }
        case "latest-release": {
            path = repositoryPath("/releases/latest");
            break;
        }
        case "release-tag-commit": {
            path = repositoryPath(`/commits/${encodePathSegment(operation.tagName)}`);
            break;
        }
        case "release-asset": {
            if (!validPositiveInteger(operation.assetId)) fail("invalid-input");
            path = repositoryPath(`/releases/assets/${operation.assetId}`);
            return Object.freeze({
                accept: "application/octet-stream",
                method,
                mutation,
                url: `${apiOrigin}${path}`,
            });
        }
        case "branch-ref": {
            path = repositoryPath(
                `/git/ref/heads/${encodePathSegment(operation.branch)}`
            );
            break;
        }
        case "native-stack-find": {
            if (!validPositiveInteger(operation.pullRequestNumber)) fail("invalid-input");
            path = `${repositoryPath("/stacks")}?pull_request=${operation.pullRequestNumber}&per_page=2`;
            break;
        }
        case "native-stack-create": {
            if (
                operation.pullRequestNumbers.length < 2 ||
                operation.pullRequestNumbers.length > 100 ||
                operation.pullRequestNumbers.some(
                    (number) => !validPositiveInteger(number)
                ) ||
                new Set(operation.pullRequestNumbers).size !==
                    operation.pullRequestNumbers.length
            ) {
                fail("invalid-input");
            }
            method = "POST";
            path = repositoryPath("/stacks");
            body = jsonBody({ pull_requests: operation.pullRequestNumbers });
            mutation = true;
            break;
        }
        case "native-stack-merge-start": {
            if (!validPositiveInteger(operation.pullRequestNumber)) fail("invalid-input");
            method = "PUT";
            path = repositoryPath(`/pulls/${operation.pullRequestNumber}/merge-async`);
            body = jsonBody({
                merge_action: "default",
                merge_method: "squash",
                sha: operation.expectedHeadSha,
            });
            mutation = true;
            break;
        }
        case "native-stack-merge-poll": {
            if (!validPositiveInteger(operation.pullRequestNumber)) fail("invalid-input");
            path = repositoryPath(
                `/pulls/${operation.pullRequestNumber}/merge-async/${encodePathSegment(operation.uuid)}`
            );
            break;
        }
        case "pull-request-merge": {
            if (!validPositiveInteger(operation.pullRequestNumber)) fail("invalid-input");
            method = "PUT";
            path = repositoryPath(`/pulls/${operation.pullRequestNumber}/merge`);
            body = jsonBody({ merge_method: "squash", sha: operation.expectedHeadSha });
            mutation = true;
            break;
        }
        case "pull-request-update-branch": {
            if (!validPositiveInteger(operation.pullRequestNumber)) fail("invalid-input");
            method = "PUT";
            path = repositoryPath(`/pulls/${operation.pullRequestNumber}/update-branch`);
            body = jsonBody({ expected_head_sha: operation.expectedHeadSha });
            mutation = true;
            break;
        }
        case "pull-request-close": {
            if (!validPositiveInteger(operation.pullRequestNumber)) fail("invalid-input");
            method = "PATCH";
            path = repositoryPath(`/pulls/${operation.pullRequestNumber}`);
            body = jsonBody({ state: "closed" });
            mutation = true;
            break;
        }
        case "pull-request-comment": {
            if (
                !validPositiveInteger(operation.pullRequestNumber) ||
                operation.body.length === 0 ||
                operation.body.length > 4096
            ) {
                fail("invalid-input");
            }
            method = "POST";
            path = repositoryPath(`/issues/${operation.pullRequestNumber}/comments`);
            body = jsonBody({ body: operation.body });
            mutation = true;
            break;
        }
        case "pull-request-review-approve": {
            if (!validPositiveInteger(operation.pullRequestNumber)) fail("invalid-input");
            method = "POST";
            path = repositoryPath(`/pulls/${operation.pullRequestNumber}/reviews`);
            body = jsonBody({
                commit_id: operation.expectedHeadSha,
                event: "APPROVE",
            });
            mutation = true;
            break;
        }
    }
    return Object.freeze({
        ...(body === undefined ? {} : { body }),
        method,
        mutation,
        url: `${apiOrigin}${path}`,
    });
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
    if (response.body === null) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = next.value as Uint8Array;
            length += chunk.byteLength;
            if (length > responseMaximumBytes) {
                await reader.cancel().catch(() => {});
                fail("limit-exceeded");
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

function parseJson(body: Uint8Array): unknown {
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
        fail("unavailable");
    }
}

function statusFailure(operation: DeliveryGitHubHttpOperation, status: number): never {
    if (status === 401 || status === 403) fail("authentication");
    if (
        status === 404 &&
        (operation.kind === "native-stack-find" ||
            operation.kind === "native-stack-create" ||
            operation.kind.startsWith("native-stack-merge"))
    ) {
        fail("capability-unavailable");
    }
    if (status === 404 || status === 409 || status === 422) fail("conflict");
    if (status === 413) fail("limit-exceeded");
    fail("unavailable");
}

function retryableReadStatus(status: number): boolean {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

async function retryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) fail("unavailable");
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timeout);
            reject(new DeliveryGitHubError("unavailable"));
        };
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}

/**
 * Creates the credential-isolated GitHub HTTPS boundary used by Delivery.
 * URLs, repository identity, API headers and mutation shapes are code-owned.
 * @returns Bounded identity-gated GitHub transport.
 */
export function createDeliveryGitHubHttpTransport(
    options: DeliveryGitHubHttpTransportOptions
): DeliveryGitHubHttpTransport {
    const fetchGitHub = options.fetch ?? globalThis.fetch;
    const deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
    const readRetryDelayMs = options.readRetryDelayMs ?? defaultReadRetryDelayMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 180_000) {
        fail("invalid-input");
    }
    if (
        !Number.isSafeInteger(readRetryDelayMs) ||
        readRetryDelayMs < 0 ||
        readRetryDelayMs > 5000
    ) {
        fail("invalid-input");
    }

    let authorization: string;
    try {
        const token = Redacted.value(options.token);
        if (
            token.length < 20 ||
            token.length > 4096 ||
            /[\r\n\p{Cc}\p{Cf}]/u.test(token)
        ) {
            fail("authentication");
        }
        authorization = `Bearer ${token}`;
    } catch (error) {
        if (error instanceof DeliveryGitHubError) throw error;
        fail("authentication");
    }

    let identityPromise: Promise<DeliveryGitHubActor> | undefined;
    let identityRequestGeneration = 0;

    async function rawRequest(
        operation: DeliveryGitHubHttpOperation,
        signal: AbortSignal
    ): Promise<DeliveryGitHubHttpResponse> {
        const prepared = prepareRequest(operation);
        if (signal.aborted) fail("unavailable");
        const maximum = prepared.mutation ? 1 : readAttemptMaximum;
        for (let attempt = 1; attempt <= maximum; attempt += 1) {
            let response: Response;
            try {
                response = await fetchGitHub(prepared.url, {
                    ...(prepared.body === undefined ? {} : { body: prepared.body }),
                    headers: {
                        Accept: prepared.accept ?? "application/vnd.github+json",
                        Authorization: authorization,
                        "Content-Type": "application/json",
                        "User-Agent": userAgent,
                        "X-GitHub-Api-Version": apiVersion,
                    },
                    method: prepared.method,
                    redirect: "error",
                    signal,
                });
            } catch {
                if (prepared.mutation) fail("unknown-outcome");
                if (attempt === maximum) fail("unavailable");
                await retryDelay(readRetryDelayMs * attempt, signal);
                continue;
            }
            if (response.status < 200 || response.status >= 300) {
                await response.body?.cancel().catch(() => {});
                if (response.status === 404 && operation.kind === "branch-ref") {
                    return Object.freeze({ body: null, status: response.status });
                }
                if (
                    !prepared.mutation &&
                    attempt < maximum &&
                    retryableReadStatus(response.status)
                ) {
                    await retryDelay(readRetryDelayMs * attempt, signal);
                    continue;
                }
                statusFailure(operation, response.status);
            }
            let body: Uint8Array;
            try {
                body = await readBoundedBody(response);
                return Object.freeze({
                    body: body.byteLength === 0 ? null : parseJson(body),
                    status: response.status,
                });
            } catch (error) {
                if (prepared.mutation) fail("unknown-outcome");
                if (attempt === maximum) throw error;
                await retryDelay(readRetryDelayMs * attempt, signal);
            }
        }
        fail("unavailable");
    }

    async function verifyIdentity(signal?: AbortSignal): Promise<DeliveryGitHubActor> {
        if (identityPromise !== undefined) return identityPromise;
        const combinedSignal = AbortSignal.any([
            signal ?? new AbortController().signal,
            AbortSignal.timeout(deadlineMs),
        ]);
        const generation = identityRequestGeneration + 1;
        identityRequestGeneration = generation;
        const pending = (async () => {
            let providerActor: v.InferOutput<typeof providerActorSchema>;
            try {
                const response = await rawRequest({ kind: "identity" }, combinedSignal);
                providerActor = v.parse(providerActorSchema, response.body);
            } catch (error) {
                if (error instanceof DeliveryGitHubError) throw error;
                fail("authentication");
            }
            if (
                providerActor.login !== options.expectedLogin ||
                providerActor.type !== "User"
            ) {
                fail("authentication");
            }
            return Object.freeze(
                v.parse(deliveryGitHubActorSchema, {
                    id: providerActor.id,
                    login: providerActor.login,
                    type: providerActor.type,
                })
            );
        })();
        identityPromise = pending;
        try {
            return await pending;
        } catch (error) {
            if (identityRequestGeneration === generation) identityPromise = undefined;
            throw error instanceof DeliveryGitHubError
                ? error
                : new DeliveryGitHubError("unavailable");
        }
    }

    async function requestJson(
        operation: DeliveryGitHubHttpOperation,
        signal?: AbortSignal
    ): Promise<unknown> {
        const response = await requestJsonWithStatus(operation, signal);
        return response.body;
    }

    async function requestJsonWithStatus(
        operation: DeliveryGitHubHttpOperation,
        signal?: AbortSignal
    ): Promise<DeliveryGitHubHttpResponse> {
        const combinedSignal = AbortSignal.any([
            signal ?? new AbortController().signal,
            AbortSignal.timeout(deadlineMs),
        ]);
        if (operation.kind !== "identity") {
            await verifyIdentity(combinedSignal);
        }
        return rawRequest(operation, combinedSignal);
    }

    return Object.freeze({
        actor: options.expectedLogin,
        requestJson,
        requestJsonWithStatus,
        verifyIdentity,
    });
}
