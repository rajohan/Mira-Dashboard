import { Redacted } from "effect";

import {
    compareDockerTags,
    matchesDockerTagPolicy,
    type DockerImageReference,
    type DockerTagPolicy,
} from "./tagPolicy.ts";

const registryDeadlineMs = 120_000;
// Existing LinuxServer repositories can legitimately exceed 32,000 historical
// tags. The legacy updater already bounded this at 100 full registry pages.
const registryPageMaximum = 100;
const registryPageSize = 1000;
const registryTagMaximum = registryPageMaximum * registryPageSize;
const registryResponseMaximumBytes = 2 * 1024 * 1024;
const registryAggregateMaximumBytes = 8 * 1024 * 1024;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const platformPattern = /^linux\/(?:amd64|arm64)(?:\/v8)?$/u;

export type DockerRegistryFailureReason =
    | "invalid-input"
    | "limit-exceeded"
    | "unavailable"
    | "unsupported";

export class DockerRegistryError extends Error {
    public readonly reason: DockerRegistryFailureReason;

    public constructor(reason: DockerRegistryFailureReason, cause?: unknown) {
        super(
            "Docker registry lookup failed",
            cause === undefined ? undefined : { cause }
        );
        this.name = "DockerRegistryError";
        this.reason = reason;
    }
}

export interface DockerRegistryCredentials {
    readonly password: Redacted.Redacted<string>;
    readonly username: Redacted.Redacted<string>;
}

export interface DockerRegistryLookup {
    readonly digest: string;
    readonly tag: string;
}

export type DockerRegistryFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface DockerRegistryClientOptions {
    readonly credentials?: Readonly<
        Partial<Record<DockerImageReference["registry"], DockerRegistryCredentials>>
    >;
    readonly deadlineMs?: number;
    readonly fetch?: DockerRegistryFetch;
    readonly signal?: AbortSignal;
}

interface RegistryContext {
    aggregateBytes: number;
    authorization?: string;
    readonly controller: AbortController;
    readonly fetch: DockerRegistryFetch;
    readonly image: DockerImageReference;
    readonly options: DockerRegistryClientOptions;
    readonly registryHost: string;
}

interface RegistryResponse {
    readonly body: Uint8Array;
    readonly headers: Headers;
    readonly status: number;
}

interface JsonRecord {
    readonly [key: string]: unknown;
}

function fail(reason: DockerRegistryFailureReason, cause?: unknown): never {
    throw cause instanceof DockerRegistryError
        ? cause
        : new DockerRegistryError(reason, cause);
}

function isRecord(value: unknown): value is JsonRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validCredentials(value: DockerRegistryCredentials | undefined): boolean {
    if (value === undefined) return true;
    try {
        const username = Redacted.value(value.username);
        const password = Redacted.value(value.password);
        return (
            username.length > 0 &&
            username.length <= 256 &&
            !/[\p{Cc}\p{Cf}]/u.test(username) &&
            password.length > 0 &&
            password.length <= 4096 &&
            !/[\r\n]/u.test(password)
        );
    } catch {
        return false;
    }
}

function registryHost(image: DockerImageReference): string {
    return image.registry === "docker.io" ? "registry-1.docker.io" : image.registry;
}

function basicAuthorization(credentials: DockerRegistryCredentials): string {
    return `Basic ${Buffer.from(
        `${Redacted.value(credentials.username)}:${Redacted.value(credentials.password)}`,
        "utf8"
    ).toString("base64")}`;
}

function parseBearerChallenge(value: string | null): ReadonlyMap<string, string> {
    if (value === null || !value.toLowerCase().startsWith("bearer ")) {
        return new Map();
    }
    const parameters = new Map<string, string>();
    for (const match of value
        .slice("bearer ".length)
        .matchAll(/([a-z_]+)="([^"\r\n]*)"/giu)) {
        const key = match[1];
        const parameter = match[2];
        const normalizedKey = key?.toLowerCase();
        if (
            normalizedKey === undefined ||
            parameter === undefined ||
            parameters.has(normalizedKey)
        )
            fail("unavailable");
        parameters.set(normalizedKey, parameter);
    }
    return parameters;
}

function trustedTokenRealm(
    image: DockerImageReference,
    realm: string,
    expectedScope: string
): URL {
    let url: URL;
    try {
        url = new URL(realm);
    } catch (error) {
        fail("unavailable", error);
    }
    let allowedHosts: ReadonlySet<string> = new Set(["ghcr.io"]);
    if (image.registry === "docker.io") {
        allowedHosts = new Set(["auth.docker.io"]);
    }
    if (image.registry === "lscr.io") {
        allowedHosts = new Set(["lscr.io", "ghcr.io"]);
    }
    if (
        url.protocol !== "https:" ||
        !allowedHosts.has(url.hostname) ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== ""
    ) {
        fail("unavailable");
    }
    url.searchParams.set("scope", expectedScope);
    return url;
}

async function readBoundedBody(
    response: Response,
    context: RegistryContext
): Promise<Uint8Array> {
    if (response.body === null) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let responseBytes = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = next.value as Uint8Array;
            responseBytes += chunk.byteLength;
            context.aggregateBytes += chunk.byteLength;
            if (
                responseBytes > registryResponseMaximumBytes ||
                context.aggregateBytes > registryAggregateMaximumBytes
            ) {
                fail("limit-exceeded");
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(responseBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

async function rawRequest(
    context: RegistryContext,
    url: string,
    headers: Readonly<Record<string, string>>
): Promise<RegistryResponse> {
    let response: Response;
    try {
        response = await context.fetch(url, {
            headers,
            redirect: "error",
            signal: context.controller.signal,
        });
    } catch (error) {
        fail(context.controller.signal.aborted ? "unavailable" : "unavailable", error);
    }
    return Object.freeze({
        body: await readBoundedBody(response, context),
        headers: response.headers,
        status: response.status,
    });
}

function responseJson(response: RegistryResponse): JsonRecord {
    let parsed: unknown;
    try {
        parsed = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(response.body)
        );
    } catch (error) {
        fail("unavailable", error);
    }
    if (!isRecord(parsed)) fail("unavailable");
    return parsed;
}

async function registryRequest(
    context: RegistryContext,
    url: string,
    accept: string
): Promise<RegistryResponse> {
    const headers = Object.freeze({
        Accept: accept,
        ...(context.authorization === undefined
            ? {}
            : { Authorization: context.authorization }),
        "User-Agent": "mira-dashboard-docker-updater/1.0",
    });
    const initial = await rawRequest(context, url, headers);
    if (initial.status !== 401) {
        if (initial.status < 200 || initial.status >= 300) fail("unavailable");
        return initial;
    }

    const challenge = parseBearerChallenge(initial.headers.get("www-authenticate"));
    const realm = challenge.get("realm");
    const scope = challenge.get("scope");
    const expectedScope = `repository:${context.image.repository}:pull`;
    if (realm === undefined || (scope !== undefined && scope !== expectedScope)) {
        fail("unavailable");
    }
    const tokenUrl = trustedTokenRealm(context.image, realm, expectedScope);
    const service = challenge.get("service");
    if (service !== undefined) {
        if (
            service.length === 0 ||
            service.length > 256 ||
            /[\p{Cc}\p{Cf}]/u.test(service)
        ) {
            fail("unavailable");
        }
        tokenUrl.searchParams.set("service", service);
    }
    const credentials = context.options.credentials?.[context.image.registry];
    if (!validCredentials(credentials)) fail("invalid-input");
    const tokenResponse = await rawRequest(context, tokenUrl.href, {
        Accept: "application/json",
        ...(credentials === undefined
            ? {}
            : { Authorization: basicAuthorization(credentials) }),
        "User-Agent": "mira-dashboard-docker-updater/1.0",
    });
    if (tokenResponse.status < 200 || tokenResponse.status >= 300) fail("unavailable");
    const tokenBody = responseJson(tokenResponse);
    let token: string | undefined;
    if (typeof tokenBody.token === "string") token = tokenBody.token;
    if (token === undefined && typeof tokenBody.access_token === "string") {
        token = tokenBody.access_token;
    }
    if (
        token === undefined ||
        token.length === 0 ||
        token.length > 16 * 1024 ||
        /[\r\n]/u.test(token)
    ) {
        fail("unavailable");
    }
    context.authorization = `Bearer ${token}`;
    const authenticated = await rawRequest(context, url, {
        Accept: accept,
        Authorization: context.authorization,
        "User-Agent": "mira-dashboard-docker-updater/1.0",
    });
    if (authenticated.status < 200 || authenticated.status >= 300) fail("unavailable");
    return authenticated;
}

function parseNextLink(
    value: string | null,
    currentUrl: string,
    context: RegistryContext
): string | undefined {
    if (value === null) return undefined;
    const nextLinks: string[] = [];
    for (const part of value.split(",")) {
        const match = part.trim().match(/^<([^>]+)>\s*;\s*rel="next"$/u);
        if (match?.[1] !== undefined) nextLinks.push(match[1]);
    }
    if (nextLinks.length !== 1) fail("unavailable");
    let next: URL;
    try {
        next = new URL(nextLinks[0]!, currentUrl);
    } catch (error) {
        fail("unavailable", error);
    }
    const expectedPath = `/v2/${context.image.repository}/tags/list`;
    if (
        next.protocol !== "https:" ||
        next.hostname !== context.registryHost ||
        next.port !== "" ||
        next.pathname !== expectedPath ||
        next.username !== "" ||
        next.password !== "" ||
        next.hash !== "" ||
        [...next.searchParams.keys()].some((key) => key !== "n" && key !== "last") ||
        next.searchParams.get("n") !== String(registryPageSize)
    ) {
        fail("unavailable");
    }
    return next.href;
}

async function selectTag(
    context: RegistryContext,
    policy: DockerTagPolicy
): Promise<string> {
    if (policy.matchType === "exact") {
        if (!matchesDockerTagPolicy(policy, policy.pattern)) fail("invalid-input");
        return policy.pattern;
    }

    let url: string | undefined =
        `https://${context.registryHost}/v2/${context.image.repository}/tags/list?n=${registryPageSize}`;
    const candidates: string[] = [];
    const seenPages = new Set<string>();
    for (let page = 0; url !== undefined; page += 1) {
        if (page >= registryPageMaximum || seenPages.has(url)) fail("limit-exceeded");
        seenPages.add(url);
        const response = await registryRequest(context, url, "application/json");
        const body = responseJson(response);
        if (!Array.isArray(body.tags) || body.tags.length > registryPageSize) {
            fail("unavailable");
        }
        for (const tag of body.tags) {
            if (typeof tag !== "string") fail("unavailable");
            if (matchesDockerTagPolicy(policy, tag)) candidates.push(tag);
            if (candidates.length > registryTagMaximum) fail("limit-exceeded");
        }
        url = parseNextLink(response.headers.get("link"), url, context);
    }
    const latest = candidates.toSorted(compareDockerTags).at(-1);
    if (latest === undefined) fail("unavailable");
    return latest;
}

function platformDigest(body: JsonRecord, platform: string): string | undefined {
    if (!Array.isArray(body.manifests)) return undefined;
    const [expectedOs, expectedArchitecture, expectedVariant] = platform.split("/");
    const manifests: readonly unknown[] = body.manifests;
    const matches = manifests.filter((candidate): candidate is JsonRecord => {
        if (!isRecord(candidate) || !isRecord(candidate.platform)) return false;
        const actual = candidate.platform;
        if (actual.os !== expectedOs || actual.architecture !== expectedArchitecture) {
            return false;
        }
        if (expectedArchitecture === "arm64" && expectedVariant === "v8") {
            return (
                actual.variant === undefined ||
                actual.variant === null ||
                actual.variant === "v8"
            );
        }
        if (expectedVariant !== undefined) return actual.variant === expectedVariant;
        return (
            actual.variant === undefined ||
            actual.variant === null ||
            (expectedArchitecture === "arm64" && actual.variant === "v8")
        );
    });
    if (matches.length !== 1) return undefined;
    const digest = matches[0]!.digest;
    return typeof digest === "string" && digestPattern.test(digest) ? digest : undefined;
}

async function lookup(
    image: DockerImageReference,
    policy: DockerTagPolicy,
    platform: string,
    options: DockerRegistryClientOptions
): Promise<DockerRegistryLookup> {
    if (
        !platformPattern.test(platform) ||
        !validCredentials(options.credentials?.[image.registry])
    ) {
        fail("invalid-input");
    }
    const fetchImplementation = options.fetch ?? fetch;
    const controller = new AbortController();
    const deadline = options.deadlineMs ?? registryDeadlineMs;
    if (
        !Number.isSafeInteger(deadline) ||
        deadline < 1 ||
        deadline > registryDeadlineMs
    ) {
        fail("invalid-input");
    }
    const timer = setTimeout(() => controller.abort(), deadline);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) abort();
    const context: RegistryContext = {
        aggregateBytes: 0,
        controller,
        fetch: fetchImplementation,
        image,
        options,
        registryHost: registryHost(image),
    };
    try {
        const tag = await selectTag(context, policy);
        const response = await registryRequest(
            context,
            `https://${context.registryHost}/v2/${image.repository}/manifests/${encodeURIComponent(tag)}`,
            [
                "application/vnd.oci.image.index.v1+json",
                "application/vnd.docker.distribution.manifest.list.v2+json",
                "application/vnd.oci.image.manifest.v1+json",
                "application/vnd.docker.distribution.manifest.v2+json",
            ].join(", ")
        );
        const body = responseJson(response);
        const selectedPlatformDigest = platformDigest(body, platform);
        if (Array.isArray(body.manifests) && selectedPlatformDigest === undefined) {
            fail("unavailable");
        }
        const digest =
            selectedPlatformDigest ??
            response.headers.get("docker-content-digest") ??
            (typeof body.digest === "string" ? body.digest : undefined);
        if (digest === undefined || !digestPattern.test(digest)) fail("unavailable");
        return Object.freeze({ digest, tag });
    } catch (error) {
        throw error instanceof DockerRegistryError
            ? error
            : new DockerRegistryError("unavailable", error);
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
    }
}

/**
 * @param image Supported registry and repository identity.
 * @param policy Exact or bounded-regex tag selection policy.
 * @param platform Target OCI platform.
 * @param options Credentials, deadline, cancellation and injected fetch boundary.
 * @returns The selected tag and platform-specific digest.
 */
export async function lookupDockerRegistryImage(
    image: DockerImageReference,
    policy: DockerTagPolicy,
    platform: string,
    options: DockerRegistryClientOptions = {}
): Promise<DockerRegistryLookup> {
    if (
        image.registry !== "docker.io" &&
        image.registry !== "ghcr.io" &&
        image.registry !== "lscr.io"
    ) {
        fail("unsupported");
    }
    return lookup(image, policy, platform, options);
}
