import { unknownArray } from "../../lib/values.ts";
import { imageRegistry, servicePlatform } from "./imageReference.ts";
import { asRecord } from "./support.ts";
import { compareTags, isTagMatch, shouldNeedFullTagScan } from "./tagPolicy.ts";
import type {
    JsonRecord,
    ManagedServiceRow,
    RegistryCredentials,
    RegistryFetchOptions,
} from "./types.ts";

const SUPPORTED_REGISTRIES = new Set(["docker.io", "ghcr.io", "lscr.io"]);
const REGISTRY_TAG_PAGE_SIZE = 1000;
const MAX_REGISTRY_TAG_PAGES = 100;
const drainedRegistryResponses = new WeakSet<Response>();

function normalizeDockerHubRepo(repo: string): string {
    if (repo.includes("/")) {
        return repo;
    }
    return `library/${repo}`;
}

function trimEnvironment(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

function registryCredentials(registry: string): RegistryCredentials | undefined {
    if (["docker.io", "registry.docker.io", "registry-1.docker.io"].includes(registry)) {
        const username = trimEnvironment("DOCKER_LOGIN");
        const password = trimEnvironment("DOCKER_TOKEN");
        return username && password ? { username, password } : undefined;
    }
    if (registry === "ghcr.io" || registry === "lscr.io") {
        const username = trimEnvironment("MIRA_GITHUB_USERNAME");
        const password = trimEnvironment("MIRA_GITHUB_TOKEN");
        return username && password ? { username, password } : undefined;
    }
    return undefined;
}

function registryHostFromUrl(url: string): string {
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname;
    } catch {
        return imageRegistry(url);
    }
}

function isTrustedTokenRealm(registry: string, tokenUrl: URL): boolean {
    const hostname = tokenUrl.hostname.toLowerCase();
    if (["docker.io", "registry.docker.io", "registry-1.docker.io"].includes(registry)) {
        return ["auth.docker.io", "registry.docker.io", "registry-1.docker.io"].includes(
            hostname
        );
    }
    if (registry === "lscr.io") {
        return hostname === "lscr.io" || hostname === "ghcr.io";
    }
    return hostname === registry;
}

function basicAuthorization(credentials: RegistryCredentials): string {
    return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toBase64()}`;
}

function parseBearerChallenge(
    header: string | undefined
): Record<string, string> | undefined {
    if (!header?.toLowerCase().startsWith("bearer ")) return undefined;
    const parameters = new Map<string, string>();
    for (const match of header
        .slice("bearer ".length)
        .matchAll(/([a-z_]+)="([^"]*)"/giu)) {
        const [, key, value] = match;
        if (key !== undefined && value !== undefined) {
            parameters.set(key.toLowerCase(), value);
        }
    }
    const realm = parameters.get("realm");
    if (!realm) return undefined;
    return Object.fromEntries(parameters);
}

async function drainResponseBody(response: Response): Promise<void> {
    if (drainedRegistryResponses.has(response)) return;
    drainedRegistryResponses.add(response);
    if (typeof response.arrayBuffer !== "function") return;
    try {
        await response.arrayBuffer();
    } catch {
        // Draining is best-effort before retrying authenticated registry requests.
    }
}

async function fetchRegistryResponse(
    url: string,
    options: RegistryFetchOptions = {}
): Promise<{ authorization?: string; response: Response; clearTimer: () => void }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const abortFromSignal = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromSignal, { once: true });
    if (options.signal?.aborted) abortFromSignal();
    const clearTimer = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromSignal);
    };
    const headers = {
        Accept: options.accept || "application/json",
        ...(options.authorization && { Authorization: options.authorization }),
        "User-Agent": "mira-dashboard-docker-updater/1.0",
    };
    try {
        const response = await fetch(url, { headers, signal: controller.signal });
        if (response.status !== 401) {
            return { authorization: options.authorization, response, clearTimer };
        }
        const challenge = parseBearerChallenge(
            response.headers.get("www-authenticate") ?? undefined
        );
        if (!challenge?.realm) {
            return { authorization: options.authorization, response, clearTimer };
        }
        await drainResponseBody(response);
        const tokenUrl = new URL(challenge.realm);
        if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
        if (challenge.scope) tokenUrl.searchParams.set("scope", challenge.scope);
        const registry = registryHostFromUrl(url);
        const credentials = isTrustedTokenRealm(registry, tokenUrl)
            ? registryCredentials(registry)
            : undefined;
        const tokenResponse = await fetch(tokenUrl, {
            headers: {
                Accept: "application/json",
                ...(credentials && { Authorization: basicAuthorization(credentials) }),
                "User-Agent": "mira-dashboard-docker-updater/1.0",
            },
            signal: controller.signal,
        });
        if (!tokenResponse.ok) {
            await drainResponseBody(tokenResponse);
            return { authorization: options.authorization, response, clearTimer };
        }
        const tokenBody = asRecord(await tokenResponse.json());
        let token: string | undefined;
        if (typeof tokenBody.access_token === "string") {
            token = tokenBody.access_token;
        }
        if (typeof tokenBody.token === "string") {
            token = tokenBody.token;
        }
        if (!token) {
            return { response, clearTimer };
        }
        const authenticated = await fetch(url, {
            headers: {
                ...headers,
                Authorization: `Bearer ${token}`,
            },
            signal: controller.signal,
        });
        return {
            authorization: `Bearer ${token}`,
            response: authenticated,
            clearTimer,
        };
    } catch (error) {
        clearTimer();
        throw error;
    }
}

function parseNextLink(header: string | undefined, baseUrl?: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(",")) {
        const [rawUrl, ...parameters] = part.trim().split(";");
        if (
            parameters.some((parameter) => parameter.trim() === 'rel="next"') &&
            rawUrl?.startsWith("<") &&
            rawUrl.endsWith(">")
        ) {
            const link = rawUrl.slice(1, -1);
            if (!baseUrl) {
                return link;
            }
            const nextUrl = new URL(link, baseUrl);
            return nextUrl.href;
        }
    }
    return undefined;
}

function isTrustedRegistryPaginationUrl(
    url: string,
    registryHost: string,
    repo: string
): boolean {
    const parsed = new URL(url);
    const expected = new URL(`https://${registryHost}/v2/${repo}/tags/list`);
    return (
        parsed.protocol === "https:" &&
        parsed.origin === expected.origin &&
        parsed.pathname === expected.pathname
    );
}

async function fetchRegistryJsonWithHeaders(
    url: string,
    options: RegistryFetchOptions = {}
): Promise<{ authorization?: string; body: JsonRecord; headers: Headers }> {
    try {
        const { authorization, response, clearTimer } = await fetchRegistryResponse(
            url,
            options
        );
        if (!response.ok) {
            try {
                await drainResponseBody(response);
            } finally {
                clearTimer();
            }
            throw new Error(`HTTP ${response.status} for ${url}`);
        }
        try {
            const body = asRecord(await response.json());
            return { authorization, body, headers: response.headers };
        } finally {
            clearTimer();
        }
    } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timeout for ${url}`, { cause: error });
        }
        throw error;
    }
}

function isGhcrRepo(repo: string): boolean {
    return repo.startsWith("ghcr.io/");
}

function stripRegistry(repo: string) {
    if (isGhcrRepo(repo)) {
        return repo.replace(/^ghcr\.io\//u, "");
    }
    if (repo.startsWith("lscr.io/")) {
        return repo.replace(/^lscr\.io\//u, "");
    }
    if (repo.startsWith("docker.io/") || repo.startsWith("index.docker.io/")) {
        return repo.replace(/^(?:index\.)?docker\.io\//u, "");
    }
    return repo;
}

function isImageMatchPlatform(image: JsonRecord, platform: string): boolean {
    const [os = "linux", architecture = "", variant] = platform.split("/", 3);
    const imageOs = typeof image.os === "string" ? image.os : "linux";
    if (imageOs !== os || image.architecture !== architecture) return false;
    if (!variant) {
        return (
            image.variant === undefined ||
            image.variant === null ||
            (architecture === "arm64" && image.variant === "v8")
        );
    }
    return image.variant === variant;
}

function manifestDigestForPlatform(
    body: JsonRecord,
    platform: string
): string | undefined {
    const manifest = unknownArray(body.manifests).find((candidate) =>
        isImageMatchPlatform(asRecord(asRecord(candidate).platform), platform)
    );
    const digest = asRecord(manifest).digest;
    return typeof digest === "string" ? digest : undefined;
}

async function lookupRegistryV2(service: ManagedServiceRow, signal?: AbortSignal) {
    const registry = imageRegistry(service.image_repo);
    const registryHost = registry === "docker.io" ? "registry-1.docker.io" : registry;
    const repo =
        registry === "docker.io"
            ? normalizeDockerHubRepo(stripRegistry(service.image_repo))
            : stripRegistry(service.image_repo);
    let tag =
        service.tag_match_type === "exact"
            ? (service.tag_match_pattern ?? service.current_tag)
            : service.current_tag;
    if (shouldNeedFullTagScan(service)) {
        const tags: string[] = [];
        let tagsUrl: string | undefined =
            `https://${registryHost}/v2/${repo}/tags/list?n=${REGISTRY_TAG_PAGE_SIZE}`;
        let tagListAuthorization: string | undefined;
        let tagPageCount = 0;
        while (tagsUrl) {
            tagPageCount += 1;
            if (tagPageCount > MAX_REGISTRY_TAG_PAGES) {
                throw new Error(
                    `${registry} tag pagination exceeded ${MAX_REGISTRY_TAG_PAGES} pages for ${repo}`
                );
            }
            const { authorization, body, headers } = await fetchRegistryJsonWithHeaders(
                tagsUrl,
                { authorization: tagListAuthorization, signal }
            );
            tagListAuthorization = authorization;
            tags.push(
                ...(Array.isArray(body.tags)
                    ? body.tags.filter((item): item is string => typeof item === "string")
                    : [])
            );
            const nextTagsUrl = parseNextLink(headers.get("link") ?? undefined, tagsUrl);
            if (
                nextTagsUrl &&
                !isTrustedRegistryPaginationUrl(nextTagsUrl, registryHost, repo)
            ) {
                throw new Error(
                    `${registry} tag pagination redirected to untrusted registry URL for ${repo}`
                );
            }
            tagsUrl = nextTagsUrl;
        }
        const candidates = tags
            .filter((candidate) => candidate && isTagMatch(service, candidate))
            .toSorted(compareTags);
        tag = candidates.at(-1) ?? tag;
    }
    if (!tag) {
        return { latestTag: undefined, latestDigest: undefined };
    }
    const { body, headers } = await fetchRegistryJsonWithHeaders(
        `https://${registryHost}/v2/${repo}/manifests/${tag}`,
        {
            accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
            signal,
        }
    );
    const manifestDigest = manifestDigestForPlatform(body, servicePlatform(service));
    return {
        latestTag: tag,
        latestDigest:
            manifestDigest ||
            headers.get("docker-content-digest") ||
            (typeof body.digest === "string" ? body.digest : undefined),
    };
}

export async function lookupLatest(service: ManagedServiceRow, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (
        process.env.NODE_ENV !== "production" &&
        process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY === "1"
    ) {
        return {
            latestTag: service.current_tag,
            latestDigest: service.current_digest,
        };
    }
    const registry = imageRegistry(service.image_repo);
    if (!SUPPORTED_REGISTRIES.has(registry)) {
        return {
            latestTag: undefined,
            latestDigest: undefined,
            unsupported: true,
        };
    }
    return lookupRegistryV2(service, signal);
}
