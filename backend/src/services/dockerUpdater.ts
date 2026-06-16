import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import safeRegex from "safe-regex2";
import YAML from "yaml";

import { db } from "../db.js";
import { nonEmptyEnvFallback } from "../lib/values.js";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "./scheduledJobs.js";

const COMPOSE_FILENAME = "compose.yaml";
const execFileAsync = promisify(execFile);
const SUPPORTED_REGISTRIES = new Set(["docker.io", "ghcr.io", "lscr.io"]);
const MAX_REGISTRY_TAG_PAGES = 50;
const composeUpdateLocks = new Map<string, { promise: Promise<void> }>();
const drainedRegistryResponses = new WeakSet<Response>();

function getDockerBin(): string {
    return nonEmptyEnvFallback("MIRA_DOCKER_BIN", "docker");
}

function failedDiscoveryAppSlugs(register: DockerUpdaterStepResult): Set<string> {
    if (!register.stderr) {
        return new Set();
    }
    try {
        const parsed = JSON.parse(register.stderr) as {
            failed?: Array<{ appSlug?: unknown; blocking?: unknown }>;
        };
        return new Set(
            (parsed.failed ?? []).flatMap((failure) =>
                typeof failure.appSlug === "string" && failure.blocking !== false
                    ? [failure.appSlug]
                    : []
            )
        );
    } catch {
        return new Set(["*"]);
    }
}

function shouldBlockManualUpdateForDiscoveryFailure(
    register: DockerUpdaterStepResult,
    appSlug: string
): boolean {
    if (register.ok) {
        return false;
    }
    const failedAppSlugs = failedDiscoveryAppSlugs(register);
    return failedAppSlugs.has("*") || failedAppSlugs.has(appSlug);
}

function shouldBlockGlobalUpdateForDiscoveryFailure(
    register: DockerUpdaterStepResult
): boolean {
    return !register.ok && failedDiscoveryAppSlugs(register).has("*");
}

function isNonblockingRegistrationFailure(step: DockerUpdaterStepResult): boolean {
    return (
        step.step === "register-services" &&
        !step.ok &&
        failedDiscoveryAppSlugs(step).size === 0
    );
}

function getDockerComposeWrapper(): string {
    const dockerRoot = nonEmptyEnvFallback("MIRA_DOCKER_ROOT", "/opt/docker");
    return nonEmptyEnvFallback(
        "MIRA_DOCKER_COMPOSE_WRAPPER",
        `${dockerRoot}/bin/docker-compose-doppler`
    );
}

function getDockerAppsRoot(): string {
    return nonEmptyEnvFallback("MIRA_DOCKER_APPS_ROOT", "/opt/docker/apps");
}

function getComposeCommand(composePath: string, serviceName: string) {
    const dockerRoot = nonEmptyEnvFallback("MIRA_DOCKER_ROOT", "/opt/docker");
    const wrapper = getDockerComposeWrapper();
    const isManagedDockerPath = path
        .resolve(composePath)
        .startsWith(`${path.resolve(dockerRoot)}${path.sep}`);
    if (
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER ||
        (isManagedDockerPath && fs.existsSync(wrapper))
    ) {
        return {
            file: wrapper,
            args: ["-f", composePath, "up", "-d", "--pull", "always", serviceName],
        };
    }
    return {
        file: getDockerBin(),
        args: ["compose", "-f", composePath, "up", "-d", "--pull", "always", serviceName],
    };
}

export interface DockerUpdaterStepResult {
    step: string;
    ok: boolean;
    stdout: string;
    stderr: string;
    code?: "NOT_FOUND" | "DISABLED" | "CONFLICT" | "UNSUPPORTED_REGISTRY";
}

interface ManagedServiceRow {
    id: number;
    app_slug: string;
    service_name: string;
    compose_path: string;
    image_repo: string;
    compose_image_ref: string | null;
    compose_image_field: string | null;
    current_tag: string | null;
    current_digest: string | null;
    latest_tag: string | null;
    latest_digest: string | null;
    policy: string;
    pin_mode: string;
    tag_match_type: string;
    tag_match_pattern: string | null;
    enabled: number;
    metadata_json?: string;
    last_status: string | null;
}

type JsonRecord = Record<string, unknown>;

interface DiscoveredComposeService {
    appSlug: string;
    serviceName: string;
    composePath: string;
    imageRepo: string;
    composeImageRef: string;
    composeImageField: string;
    currentTag: string | null;
    currentDigest: string | null;
    policy: "auto" | "notify";
    pinMode: "tag" | "digest";
    tagMatchType: "exact" | "regex";
    tagMatchPattern: string | null;
    enabled: boolean;
    metadata: Record<string, unknown>;
}

interface RegistryFetchOptions {
    accept?: string;
}

function nowIso(): string {
    const now = new Date();
    return now.toISOString();
}

function normalizeLabels(rawLabels: unknown): Map<string, string> {
    if (Array.isArray(rawLabels)) {
        return new Map(
            rawLabels.map((label) => {
                const text = String(label);
                const index = text.indexOf("=");
                return index === -1
                    ? [text, ""]
                    : [text.slice(0, index), text.slice(index + 1)];
            })
        );
    }
    if (rawLabels && typeof rawLabels === "object") {
        return new Map(
            Object.entries(rawLabels).map(([key, value]) => [
                String(key),
                String(value ?? ""),
            ])
        );
    }
    return new Map();
}

function parseImageRef(imageRef: string) {
    const digestIndex = imageRef.indexOf("@");
    const beforeDigest = digestIndex === -1 ? imageRef : imageRef.slice(0, digestIndex);
    const digest = digestIndex === -1 ? null : imageRef.slice(digestIndex + 1);
    const slashIndex = beforeDigest.lastIndexOf("/");
    const colonIndex = beforeDigest.lastIndexOf(":");
    const hasTag = colonIndex > slashIndex;
    return {
        repo: hasTag ? beforeDigest.slice(0, colonIndex) : beforeDigest,
        tag: hasTag ? beforeDigest.slice(colonIndex + 1) : null,
        digest,
        pinMode: digest ? "digest" : "tag",
    };
}

function serviceLabel(service: Pick<ManagedServiceRow, "app_slug" | "service_name">) {
    return `${service.app_slug}/${service.service_name}`;
}

function normalizeDockerHubRepo(repo: string): string {
    if (repo.includes("/")) {
        return repo;
    }
    return `library/${repo}`;
}

function caughtMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonRecord)
        : {};
}

async function fetchJson(url: string, headers: Record<string, string> = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                "User-Agent": "mira-dashboard-docker-updater/1.0",
                ...headers,
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url}`);
        }
        return (await response.json()) as JsonRecord;
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timeout for ${url}`, { cause: error });
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function parseBearerChallenge(header: string | null): Record<string, string> | null {
    if (!header?.toLowerCase().startsWith("bearer ")) return null;
    const params = new Map<string, string>();
    for (const match of header
        .slice("bearer ".length)
        .matchAll(/([a-z_]+)="([^"]*)"/giu)) {
        params.set(match[1].toLowerCase(), match[2]);
    }
    const realm = params.get("realm");
    if (!realm) return null;
    return Object.fromEntries(params);
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
): Promise<{ response: Response; clearTimer: () => void }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const clearTimer = () => clearTimeout(timeout);
    const headers = {
        Accept: options.accept || "application/json",
        "User-Agent": "mira-dashboard-docker-updater/1.0",
    };
    try {
        const response = await fetch(url, { headers, signal: controller.signal });
        if (response.status !== 401) {
            return { response, clearTimer };
        }
        const challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
        if (!challenge?.realm) {
            return { response, clearTimer };
        }
        await drainResponseBody(response);
        const tokenUrl = new URL(challenge.realm);
        if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
        if (challenge.scope) tokenUrl.searchParams.set("scope", challenge.scope);
        const tokenResponse = await fetch(tokenUrl, {
            headers: {
                Accept: "application/json",
                "User-Agent": "mira-dashboard-docker-updater/1.0",
            },
            signal: controller.signal,
        });
        if (!tokenResponse.ok) {
            await drainResponseBody(tokenResponse);
            return { response, clearTimer };
        }
        const tokenBody = asRecord(await tokenResponse.json());
        const token =
            typeof tokenBody.token === "string"
                ? tokenBody.token
                : typeof tokenBody.access_token === "string"
                  ? tokenBody.access_token
                  : null;
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
        return { response: authenticated, clearTimer };
    } catch (error) {
        clearTimer();
        throw error;
    }
}

async function fetchRegistryJson(url: string): Promise<JsonRecord> {
    const { body } = await fetchRegistryJsonWithHeaders(url);
    return body;
}

function parseNextLink(header: string | null, baseUrl?: string): string | null {
    if (!header) return null;
    for (const part of header.split(",")) {
        const [rawUrl, ...params] = part.trim().split(";");
        if (
            params.some((param) => param.trim() === 'rel="next"') &&
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
    return null;
}

async function fetchRegistryJsonWithHeaders(
    url: string,
    options: RegistryFetchOptions = {}
): Promise<{ body: JsonRecord; headers: Headers }> {
    try {
        const { response, clearTimer } = await fetchRegistryResponse(url, options);
        if (!response.ok) {
            await drainResponseBody(response);
            clearTimer();
            throw new Error(`HTTP ${response.status} for ${url}`);
        }
        try {
            const body = asRecord(await response.json());
            return { body, headers: response.headers };
        } finally {
            clearTimer();
        }
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timeout for ${url}`, { cause: error });
        }
        throw error;
    }
}

function isGhcrRepo(repo: string): boolean {
    return repo.startsWith("ghcr.io/");
}

function imageRegistry(repo: string): string {
    const first = repo.split("/", 1)[0] || "";
    const registry =
        first.includes(".") || first.includes(":") || first === "localhost"
            ? first
            : "docker.io";
    return registry === "index.docker.io" ? "docker.io" : registry;
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

function tagMatches(service: ManagedServiceRow, tag: string): boolean {
    if (!service.tag_match_pattern) {
        return tag === service.current_tag;
    }
    if (service.tag_match_type === "regex") {
        if (!isSafeTagRegexPattern(service.tag_match_pattern)) {
            return tag === service.current_tag;
        }
        try {
            const matcher = new RegExp(service.tag_match_pattern);
            return matcher.test(tag);
        } catch {
            return tag === service.current_tag;
        }
    }
    return tag === service.tag_match_pattern;
}

function isSafeTagRegexPattern(pattern: string): boolean {
    if (pattern.length > 128) {
        return false;
    }
    return safeRegex(pattern);
}

function needsFullTagScan(service: ManagedServiceRow): boolean {
    if (service.tag_match_type !== "regex" || !service.tag_match_pattern) {
        return false;
    }
    return isSafeTagRegexPattern(service.tag_match_pattern);
}

function compareTags(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function hostDockerPlatform(): string {
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    return `linux/${arch}`;
}

function servicePlatform(service: ManagedServiceRow): string {
    let metadata: JsonRecord;
    try {
        metadata = asRecord(
            service.metadata_json ? JSON.parse(service.metadata_json) : {}
        );
    } catch {
        metadata = {};
    }
    return typeof metadata.platform === "string" && metadata.platform
        ? metadata.platform
        : process.env.MIRA_DOCKER_UPDATER_PLATFORM || hostDockerPlatform();
}

function imageMatchesPlatform(image: JsonRecord, platform: string): boolean {
    const [os = "linux", architecture = "", variant] = platform.split("/");
    const imageOs = typeof image.os === "string" ? image.os : "linux";
    if (imageOs !== os || image.architecture !== architecture) return false;
    if (!variant) {
        return (
            image.variant === null ||
            image.variant === undefined ||
            (architecture === "arm64" && image.variant === "v8")
        );
    }
    return image.variant === variant;
}

function manifestDigestForPlatform(body: JsonRecord, platform: string): string | null {
    const manifest = (Array.isArray(body.manifests) ? body.manifests : []).find(
        (candidate) =>
            imageMatchesPlatform(asRecord(asRecord(candidate).platform), platform)
    );
    const digest = asRecord(manifest).digest;
    return typeof digest === "string" ? digest : null;
}

async function lookupDockerHub(service: ManagedServiceRow) {
    const repo = normalizeDockerHubRepo(stripRegistry(service.image_repo));
    let latestTag = service.current_tag;
    if (service.tag_match_type === "regex") {
        if (needsFullTagScan(service)) {
            const tags: unknown[] = [];
            let tagsUrl: string | null =
                `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`;
            let tagPageCount = 0;
            while (tagsUrl) {
                tagPageCount += 1;
                if (tagPageCount > MAX_REGISTRY_TAG_PAGES) {
                    throw new Error(
                        `Docker Hub tag pagination exceeded ${MAX_REGISTRY_TAG_PAGES} pages for ${repo}`
                    );
                }
                const tagsData = await fetchJson(tagsUrl);
                if (Array.isArray(tagsData.results)) {
                    tags.push(...tagsData.results);
                }
                const next = typeof tagsData.next === "string" ? tagsData.next : "";
                tagsUrl = next || null;
            }
            const candidates = tags
                .map((item) => String(asRecord(item).name || ""))
                .filter((tag: string) => tag && tagMatches(service, tag))
                .sort(compareTags);
            latestTag = candidates.at(-1) || service.current_tag;
        }
    } else if (service.tag_match_pattern) {
        latestTag = service.tag_match_pattern;
    }
    let latestDigest: string | null = null;
    if (latestTag) {
        const tagData = await fetchJson(
            `https://hub.docker.com/v2/repositories/${repo}/tags/${encodeURIComponent(latestTag)}`
        );
        const platform = servicePlatform(service);
        const image = (Array.isArray(tagData.images) ? tagData.images : []).find(
            (candidate) => imageMatchesPlatform(asRecord(candidate), platform)
        );
        const digest = asRecord(image).digest ?? tagData.digest;
        latestDigest = typeof digest === "string" ? digest : null;
    }
    return { latestTag, latestDigest };
}

async function lookupRegistryV2(service: ManagedServiceRow) {
    const registry = imageRegistry(service.image_repo);
    const repo = stripRegistry(service.image_repo);
    let tag =
        service.tag_match_type === "exact"
            ? (service.tag_match_pattern ?? service.current_tag)
            : service.current_tag;
    if (needsFullTagScan(service)) {
        const tags: string[] = [];
        let tagsUrl: string | null = `https://${registry}/v2/${repo}/tags/list`;
        let tagPageCount = 0;
        while (tagsUrl) {
            tagPageCount += 1;
            if (tagPageCount > MAX_REGISTRY_TAG_PAGES) {
                throw new Error(
                    `${registry} tag pagination exceeded ${MAX_REGISTRY_TAG_PAGES} pages for ${repo}`
                );
            }
            const { body, headers } = await fetchRegistryJsonWithHeaders(tagsUrl);
            tags.push(
                ...(Array.isArray(body.tags)
                    ? body.tags.filter((item): item is string => typeof item === "string")
                    : [])
            );
            tagsUrl = parseNextLink(headers.get("link"), tagsUrl);
        }
        const candidates = tags
            .filter((candidate) => candidate && tagMatches(service, candidate))
            .sort(compareTags);
        tag = candidates.at(-1) ?? tag;
    }
    if (!tag) {
        return { latestTag: null, latestDigest: null };
    }
    const { body, headers } = await fetchRegistryJsonWithHeaders(
        `https://${registry}/v2/${repo}/manifests/${tag}`,
        {
            accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
        }
    );
    const manifestDigest = manifestDigestForPlatform(body, servicePlatform(service));
    return {
        latestTag: tag,
        latestDigest:
            manifestDigest ||
            headers.get("docker-content-digest") ||
            (typeof body.digest === "string" ? body.digest : null),
    };
}

const lookupGhcr = lookupRegistryV2;

async function lookupLatest(service: ManagedServiceRow) {
    if (process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY === "1") {
        return {
            latestTag: service.current_tag,
            latestDigest: service.current_digest,
        };
    }
    const registry = imageRegistry(service.image_repo);
    if (!SUPPORTED_REGISTRIES.has(registry)) {
        return {
            latestTag: null,
            latestDigest: null,
            unsupported: true,
        };
    }
    if (registry === "ghcr.io" || registry === "lscr.io") {
        return lookupRegistryV2(service);
    }
    return lookupDockerHub(service);
}

function hasUpdate(service: ManagedServiceRow): boolean {
    if (service.pin_mode === "digest") {
        return Boolean(
            service.latest_digest &&
            (!service.current_digest || service.latest_digest !== service.current_digest)
        );
    }
    return Boolean(
        (service.latest_tag &&
            (!service.current_tag || service.latest_tag !== service.current_tag)) ||
        (service.latest_digest &&
            (!service.current_digest || service.latest_digest !== service.current_digest))
    );
}

function buildTargetImageRef(service: ManagedServiceRow): string {
    const parsed = parseImageRef(service.compose_image_ref || service.image_repo);
    if (service.pin_mode === "digest" && service.latest_digest) {
        const tag = service.latest_tag || parsed.tag;
        return tag
            ? `${parsed.repo}:${tag}@${service.latest_digest}`
            : `${parsed.repo}@${service.latest_digest}`;
    }
    return `${parsed.repo}:${service.latest_tag || service.current_tag || "latest"}`;
}

function setNestedValue(target: JsonRecord, dottedPath: string, value: string) {
    const rawParts = dottedPath.split(".");
    const parts =
        rawParts[0] === "services" && rawParts.at(-1) === "image" && rawParts.length > 3
            ? ["services", rawParts.slice(1, -1).join("."), "image"]
            : rawParts;
    const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
    for (const part of parts) {
        if (unsafeKeys.has(part)) {
            throw new Error(`Unsafe compose image field segment: ${part}`);
        }
    }
    let current = target;
    for (const part of parts.slice(0, -1)) {
        if (!Object.hasOwn(current, part)) {
            throw new Error(`Compose image field path does not exist: ${dottedPath}`);
        }
        const next = current[part];
        if (
            !next ||
            typeof next !== "object" ||
            Object.getPrototypeOf(next) !== Object.prototype
        ) {
            throw new Error(`Compose image field path is not an object: ${dottedPath}`);
        }
        current = next as JsonRecord;
    }
    const lastPart = parts.at(-1) as string;
    if (!Object.hasOwn(current, lastPart)) {
        throw new Error(`Compose image field path does not exist: ${dottedPath}`);
    }
    current[lastPart] = value;
}

function writeFileWithMetadata(
    targetPath: string,
    content: string,
    stats: Pick<fs.Stats, "mode" | "uid" | "gid">
) {
    const mode = stats.mode & 0o7777;
    const fd = fs.openSync(
        targetPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        mode
    );
    let committed = false;
    try {
        fs.writeFileSync(fd, content, "utf8");
        fs.fchmodSync(fd, mode);
        const currentStats = fs.fstatSync(fd);
        if (currentStats.uid !== stats.uid || currentStats.gid !== stats.gid) {
            try {
                fs.fchownSync(fd, stats.uid, stats.gid);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EPERM") {
                    throw error;
                }
            }
        }
        committed = true;
    } finally {
        fs.closeSync(fd);
        if (!committed) {
            try {
                fs.unlinkSync(targetPath);
            } catch {
                // Preserve the original write failure.
            }
        }
    }
}

function insertEvent(
    service: ManagedServiceRow,
    eventType: string,
    message: string,
    details: Record<string, unknown> = {}
) {
    db.prepare(
        `INSERT INTO docker_update_events (
            managed_service_id, app_slug, service_name, event_type, from_tag, to_tag,
            from_digest, to_digest, message, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        service.id,
        service.app_slug,
        service.service_name,
        eventType,
        service.current_tag,
        service.latest_tag,
        service.current_digest,
        service.latest_digest,
        message,
        JSON.stringify(details),
        nowIso()
    );
}

function insertEventBestEffort(
    service: ManagedServiceRow,
    eventType: string,
    message: string,
    details: Record<string, unknown> = {}
) {
    try {
        insertEvent(service, eventType, message, details);
    } catch (error) {
        console.error("[DockerUpdater] Failed to persist update event", {
            error: caughtMessage(error),
            eventType,
            service: serviceLabel(service),
        });
    }
}

function createNotification(
    title: string,
    description: string,
    dedupeKey: string,
    type: "info" | "error" = "info",
    metadata: JsonRecord = {}
) {
    const timestamp = nowIso();
    db.prepare(
        `INSERT INTO notifications (
            title, description, type, source, dedupe_key, metadata_json,
            is_read, created_at, updated_at, occurred_at
         ) VALUES (?, ?, ?, 'docker-updater', ?, ?, 0, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            type = excluded.type,
            metadata_json = excluded.metadata_json,
            is_read = 0,
            updated_at = excluded.updated_at,
            occurred_at = excluded.occurred_at`
    ).run(
        title,
        description,
        type,
        dedupeKey,
        JSON.stringify(metadata),
        timestamp,
        timestamp,
        timestamp
    );
}

function createNotificationBestEffort(
    title: string,
    description: string,
    dedupeKey: string,
    type: "info" | "error" = "info",
    metadata: JsonRecord = {}
) {
    try {
        createNotification(title, description, dedupeKey, type, metadata);
    } catch (error) {
        console.error("[DockerUpdater] Failed to persist notification", {
            dedupeKey,
            error: caughtMessage(error),
            title,
        });
    }
}

function composeUpdateLockKey(service: ManagedServiceRow): string {
    return service.compose_path;
}

async function withComposeUpdateLock<T>(
    service: ManagedServiceRow,
    action: () => Promise<T>
): Promise<T> {
    const key = composeUpdateLockKey(service);
    const previous = composeUpdateLocks.get(key)?.promise ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    async function waitForCurrent(): Promise<void> {
        await previous;
        await current;
    }
    const next = { promise: waitForCurrent() };
    composeUpdateLocks.set(key, next);
    await previous;
    try {
        return await action();
    } finally {
        release();
        if (composeUpdateLocks.get(key) === next) {
            composeUpdateLocks.delete(key);
        }
    }
}

async function applyComposeUpdateUnlocked(
    service: ManagedServiceRow,
    targetImageRef: string
) {
    if (!service.compose_image_field) {
        throw new Error(
            `Service ${serviceLabel(service)} is missing compose image field`
        );
    }
    const composeImageField = service.compose_image_field;
    const configuredComposePath = service.compose_path;
    const composePath = fs.realpathSync(configuredComposePath);
    const raw = fs.readFileSync(composePath, "utf8");
    const originalStats = fs.statSync(composePath);
    const doc = YAML.parse(raw) as JsonRecord;
    setNestedValue(doc, composeImageField, targetImageRef);
    let composeStarted = false;
    const tempPath = path.join(
        path.dirname(composePath),
        `${path.basename(composePath)}.tmp-${randomUUID()}`
    );
    const rollbackTempPath = path.join(
        path.dirname(composePath),
        `${path.basename(composePath)}.rollback-${randomUUID()}`
    );
    try {
        writeFileWithMetadata(rollbackTempPath, raw, originalStats);
        writeFileWithMetadata(tempPath, YAML.stringify(doc), originalStats);
        fs.renameSync(tempPath, composePath);
        const command = getComposeCommand(composePath, service.service_name);
        composeStarted = true;
        const { stdout, stderr } = await execFileAsync(command.file, command.args, {
            cwd: path.dirname(composePath),
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 180_000,
        });
        try {
            fs.unlinkSync(rollbackTempPath);
        } catch {
            // The rollback file is only a best-effort safety net after success.
        }
        return { stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
        try {
            fs.unlinkSync(tempPath);
        } catch {
            // The temp file may have already been atomically moved into place.
        }
        let restored = false;
        try {
            if (fs.existsSync(rollbackTempPath)) {
                fs.renameSync(rollbackTempPath, composePath);
                restored = true;
            }
        } catch (rollbackError) {
            console.error("[DockerUpdater] Failed to restore compose file", {
                composePath,
                rollbackError,
            });
        }
        if (restored && composeStarted) {
            try {
                const command = getComposeCommand(composePath, service.service_name);
                await execFileAsync(command.file, command.args, {
                    cwd: path.dirname(composePath),
                    env: process.env,
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 180_000,
                });
            } catch (rollbackError) {
                console.error(
                    "[DockerUpdater] Failed to re-apply restored compose file",
                    {
                        composePath,
                        rollbackError,
                    }
                );
            }
        }
        throw error;
    }
}

function booleanLabel(value: string | undefined, fallback = false): boolean {
    if (value == null || value === "") return fallback;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function listComposeFiles(root = getDockerAppsRoot()): string[] {
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name, COMPOSE_FILENAME))
        .filter((file) => fs.existsSync(file));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

function servicesFromCompose(composePath: string):
    | {
          appSlug: string;
          ok: true;
          services: DiscoveredComposeService[];
      }
    | {
          appSlug: string;
          error: string;
          ok: false;
          services: DiscoveredComposeService[];
      } {
    const appSlug = path.basename(path.dirname(composePath));
    try {
        const parsed = YAML.parse(fs.readFileSync(composePath, "utf8"));
        if (!isPlainObject(parsed) || !isPlainObject(parsed.services)) {
            return {
                appSlug,
                error: `Compose file ${composePath} must contain a services object`,
                ok: false,
                services: [],
            };
        }

        const services: DiscoveredComposeService[] = [];
        const serviceErrors: string[] = [];
        for (const [serviceName, service] of Object.entries(parsed.services)) {
            if (!isPlainObject(service)) {
                serviceErrors.push(
                    `Compose service ${serviceName} in ${composePath} must be an object`
                );
                continue;
            }
            if (!("image" in service)) {
                continue;
            }
            if (typeof service.image !== "string") {
                serviceErrors.push(
                    `Compose service ${serviceName} in ${composePath} must define image as a string`
                );
                continue;
            }
            const imageRef = service.image;
            const labels = normalizeLabels(service.labels);
            const image = parseImageRef(imageRef);
            const configuredPinMode = labels
                .get("mira.updater.track")
                ?.trim()
                .toLowerCase();
            const tagPattern = labels.get("mira.updater.tagPattern") || null;
            const tagPatternIsRegex = booleanLabel(
                labels.get("mira.updater.tagPatternIsRegex"),
                false
            );
            const currentTag = image.tag ?? (image.digest ? null : "latest");
            const pinMode: "digest" | "tag" =
                configuredPinMode === "digest" || configuredPinMode === "tag"
                    ? configuredPinMode
                    : image.pinMode === "digest"
                      ? "digest"
                      : "tag";
            let tagMatchType: "exact" | "regex" = "exact";
            const tagMatchPattern = tagPattern ?? currentTag;
            if (tagPattern && tagPatternIsRegex) {
                try {
                    new RegExp(tagPattern);
                } catch (error) {
                    const message = `Invalid tag pattern regex for ${appSlug}/${serviceName}: ${tagPattern} (${caughtMessage(error)})`;
                    console.warn("[DockerUpdater] Ignoring invalid tag pattern regex", {
                        appSlug,
                        serviceName,
                        tagPattern,
                        error: caughtMessage(error),
                    });
                    serviceErrors.push(message);
                    continue;
                }
                if (!isSafeTagRegexPattern(tagPattern)) {
                    const message = `Unsafe tag pattern regex for ${appSlug}/${serviceName}: ${tagPattern} (pattern failed safety checks)`;
                    console.warn("[DockerUpdater] Ignoring unsafe tag pattern regex", {
                        appSlug,
                        serviceName,
                        tagPattern,
                        error: "pattern failed safety checks",
                    });
                    serviceErrors.push(message);
                    continue;
                }
                tagMatchType = "regex";
            }
            services.push({
                appSlug,
                serviceName,
                composePath,
                imageRepo: image.repo,
                composeImageRef: imageRef,
                composeImageField: `services.${serviceName}.image`,
                currentTag,
                currentDigest: image.digest,
                policy: booleanLabel(labels.get("mira.updater.autoUpdate"), false)
                    ? "auto"
                    : "notify",
                pinMode,
                tagMatchType,
                tagMatchPattern,
                enabled: labels.has("mira.updater.enabled")
                    ? booleanLabel(labels.get("mira.updater.enabled"), true)
                    : true,
                metadata: {
                    discoveredBy: "dashboard-docker-updater",
                    discoveredAt: nowIso(),
                    containerName:
                        typeof service.container_name === "string"
                            ? service.container_name
                            : null,
                    platform:
                        typeof service.platform === "string" ? service.platform : null,
                    labels: Object.fromEntries(labels),
                },
            });
        }
        if (serviceErrors.length > 0) {
            return {
                appSlug,
                error: serviceErrors.join("; "),
                ok: false,
                services,
            };
        }
        return {
            appSlug,
            ok: true,
            services,
        };
    } catch (error) {
        console.error("[DockerUpdater] Failed to discover compose services", {
            composePath,
            error,
        });
        return { appSlug, error: caughtMessage(error), ok: false, services: [] };
    }
}

export async function registerDockerUpdaterServices(): Promise<DockerUpdaterStepResult> {
    let composeFiles: string[];
    try {
        const appsRoot = getDockerAppsRoot();
        if (!fs.existsSync(appsRoot)) {
            return {
                ok: false,
                step: "register-services",
                stdout: "",
                stderr: JSON.stringify({
                    registered: 0,
                    failed: [
                        {
                            appSlug: "*",
                            error: `Compose apps root not found: ${appsRoot}`,
                        },
                    ],
                }),
            };
        }
        composeFiles = listComposeFiles(appsRoot);
    } catch (error) {
        return {
            ok: false,
            step: "register-services",
            stdout: "",
            stderr: JSON.stringify({
                registered: 0,
                failed: [{ appSlug: "*", error: caughtMessage(error) }],
            }),
        };
    }
    const discoveries = composeFiles.map(servicesFromCompose);
    const failedDiscoveries = discoveries.filter((discovery) => !discovery.ok);
    const successfulOrPartialDiscoveries = discoveries.filter(
        (discovery) => discovery.ok || discovery.services.length > 0
    );
    const services = successfulOrPartialDiscoveries.flatMap(
        (discovery) => discovery.services
    );
    const timestamp = nowIso();
    const upsert = db.prepare(
        `INSERT INTO docker_managed_services (
            app_slug, service_name, compose_path, image_repo, compose_image_ref,
            compose_image_field, current_tag, current_digest, policy, pin_mode,
            tag_match_type, tag_match_pattern, enabled, metadata_json,
            last_checked_at, last_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered')
         ON CONFLICT(app_slug, service_name) DO UPDATE SET
            compose_path = excluded.compose_path,
            image_repo = excluded.image_repo,
            compose_image_ref = excluded.compose_image_ref,
            compose_image_field = excluded.compose_image_field,
            current_tag = excluded.current_tag,
            current_digest = CASE
                WHEN excluded.current_digest IS NOT NULL THEN excluded.current_digest
                WHEN docker_managed_services.current_tag = excluded.current_tag
                    THEN docker_managed_services.current_digest
                ELSE NULL
            END,
            policy = excluded.policy,
            pin_mode = excluded.pin_mode,
            tag_match_type = excluded.tag_match_type,
            tag_match_pattern = excluded.tag_match_pattern,
            enabled = excluded.enabled,
            metadata_json = excluded.metadata_json,
            last_checked_at = docker_managed_services.last_checked_at,
            last_status = docker_managed_services.last_status`
    );
    let txnStarted = false;
    try {
        db.exec("BEGIN");
        txnStarted = true;
        for (const appSlug of new Set(
            successfulOrPartialDiscoveries.map((item) => item.appSlug)
        )) {
            const serviceNames = new Set(
                services
                    .filter((service) => service.appSlug === appSlug)
                    .map((service) => service.serviceName)
            );
            for (const row of db
                .prepare(
                    "SELECT id, service_name FROM docker_managed_services WHERE app_slug = ?"
                )
                .all(appSlug) as Array<{ id: number; service_name: string }>) {
                if (!serviceNames.has(row.service_name)) {
                    db.prepare("DELETE FROM docker_managed_services WHERE id = ?").run(
                        row.id
                    );
                }
            }
        }
        const discoveredAppSlugs = new Set(
            successfulOrPartialDiscoveries.map((discovery) => discovery.appSlug)
        );
        const failedAppSlugs = new Set(
            failedDiscoveries.map((discovery) => discovery.appSlug)
        );
        for (const row of db
            .prepare("SELECT DISTINCT app_slug FROM docker_managed_services")
            .all() as Array<{ app_slug: string }>) {
            if (
                !discoveredAppSlugs.has(row.app_slug) &&
                !failedAppSlugs.has(row.app_slug)
            ) {
                db.prepare("DELETE FROM docker_managed_services WHERE app_slug = ?").run(
                    row.app_slug
                );
            }
        }
        for (const service of services) {
            upsert.run(
                service.appSlug,
                service.serviceName,
                service.composePath,
                service.imageRepo,
                service.composeImageRef,
                service.composeImageField,
                service.currentTag,
                service.currentDigest,
                service.policy,
                service.pinMode,
                service.tagMatchType,
                service.tagMatchPattern,
                service.enabled ? 1 : 0,
                JSON.stringify(service.metadata),
                timestamp
            );
        }
        db.exec("COMMIT");
    } catch (error) {
        let failureMessage = caughtMessage(error);
        if (txnStarted) {
            try {
                db.exec("ROLLBACK");
            } catch (rollbackError) {
                failureMessage = `${failureMessage}; rollback failed: ${caughtMessage(rollbackError)}`;
            }
        }
        return {
            ok: false,
            step: "register-services",
            stdout: "",
            stderr: JSON.stringify({
                registered: 0,
                failed: [{ appSlug: "*", error: failureMessage }],
            }),
        };
    }
    return {
        step: "register-services",
        ok: failedDiscoveries.length === 0,
        stdout: JSON.stringify({
            ok: failedDiscoveries.length === 0,
            summary: {
                composeFiles: composeFiles.length,
                failedComposeFiles: failedDiscoveries.length,
                registeredServices: services.length,
            },
        }),
        stderr:
            failedDiscoveries.length === 0
                ? ""
                : JSON.stringify({
                      failed: failedDiscoveries.map((discovery) => ({
                          appSlug: discovery.appSlug,
                          blocking: discovery.services.length === 0,
                          error: discovery.error,
                      })),
                  }),
    };
}

export async function pollDockerUpdaterRegistries(
    serviceId?: number
): Promise<DockerUpdaterStepResult> {
    const timestamp = nowIso();
    const services =
        serviceId === undefined
            ? (db
                  .prepare(
                      "SELECT * FROM docker_managed_services WHERE enabled = 1 ORDER BY app_slug, service_name"
                  )
                  .all() as unknown as ManagedServiceRow[])
            : (db
                  .prepare(
                      "SELECT * FROM docker_managed_services WHERE id = ? AND enabled = 1 ORDER BY app_slug, service_name"
                  )
                  .all(serviceId) as unknown as ManagedServiceRow[]);
    const checked: string[] = [];
    const updates: string[] = [];
    const newUpdates: string[] = [];
    const skipped: Array<{ service: string; reason: string }> = [];
    const failures: Array<{ service: string; error: string }> = [];
    for (const service of services) {
        try {
            const latest = await lookupLatest(service);
            if ("unsupported" in latest && latest.unsupported) {
                skipped.push({
                    service: serviceLabel(service),
                    reason: `Unsupported image registry: ${imageRegistry(service.image_repo)}`,
                });
                db.prepare(
                    `UPDATE docker_managed_services
                     SET latest_tag = NULL, latest_digest = NULL,
                         last_checked_at = ?, last_status = 'unsupported_registry'
                     WHERE id = ?`
                ).run(timestamp, service.id);
                continue;
            }
            const updatedService = {
                ...service,
                latest_tag: latest.latestTag ?? null,
                latest_digest: latest.latestDigest ?? null,
            };
            const updateAvailable = hasUpdate(updatedService);
            const updateChanged =
                service.last_status !== "update_available" ||
                service.latest_tag !== updatedService.latest_tag ||
                service.latest_digest !== updatedService.latest_digest;
            db.prepare(
                `UPDATE docker_managed_services
                 SET latest_tag = ?, latest_digest = ?, last_checked_at = ?, last_status = ?
                 WHERE id = ?`
            ).run(
                latest.latestTag ?? null,
                latest.latestDigest ?? null,
                timestamp,
                updateAvailable ? "update_available" : "current",
                service.id
            );
            checked.push(serviceLabel(service));
            if (updateAvailable) {
                updates.push(serviceLabel(service));
                if (updateChanged) {
                    newUpdates.push(serviceLabel(service));
                    insertEventBestEffort(
                        updatedService,
                        "update_available",
                        "Docker update available"
                    );
                }
            }
        } catch (error) {
            failures.push({
                service: serviceLabel(service),
                error: caughtMessage(error),
            });
            db.prepare(
                `UPDATE docker_managed_services
                 SET latest_tag = NULL, latest_digest = NULL,
                     last_checked_at = ?, last_status = 'registry_check_failed'
                 WHERE id = ?`
            ).run(timestamp, service.id);
        }
    }
    if (newUpdates.length > 0) {
        createNotificationBestEffort(
            "Docker updates available",
            newUpdates.join(", "),
            "docker:updater:updates-available"
        );
    }
    return {
        step: "poll",
        ok: failures.length === 0,
        stdout: JSON.stringify({
            ok: failures.length === 0,
            checkedAt: timestamp,
            checked,
            skipped,
            updates,
        }),
        stderr: failures
            .map((failure) => `${failure.service}: ${failure.error}`)
            .join("\n"),
    };
}

async function applyServiceUpdate(
    service: ManagedServiceRow,
    eventPrefix: "auto" | "manual"
): Promise<DockerUpdaterStepResult> {
    return withComposeUpdateLock(service, async () => {
        const lockedService = db
            .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
            .get(service.id) as ManagedServiceRow | undefined;
        if (!lockedService || lockedService.enabled !== 1) {
            const code = lockedService ? "DISABLED" : "NOT_FOUND";
            return {
                step: `${eventPrefix}-update:${serviceLabel(service)}`,
                ok: false,
                code,
                stdout: "",
                stderr: "Docker updater service not found or disabled",
            };
        }
        if (!hasUpdate(lockedService)) {
            return {
                step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                ok: false,
                code: "CONFLICT",
                stdout: "",
                stderr: "No update available",
            };
        }
        const target = buildTargetImageRef(lockedService);
        let result: Awaited<ReturnType<typeof applyComposeUpdateUnlocked>>;
        try {
            // Compose writes tag-only refs for non-digest pins, then pulls so
            // digest drift still refreshes mutable tags without storing @digest.
            result = await applyComposeUpdateUnlocked(lockedService, target);
        } catch (error) {
            const message = caughtMessage(error);
            db.prepare(
                `UPDATE docker_managed_services
                 SET last_checked_at = ?, last_status = ?
                 WHERE id = ?`
            ).run(nowIso(), `${eventPrefix}_update_failed`, lockedService.id);
            insertEventBestEffort(
                lockedService,
                `${eventPrefix}_update_failed`,
                message,
                {
                    targetComposeImageRef: target,
                }
            );
            const [os = "linux", architecture = null] =
                servicePlatform(lockedService).split("/");
            createNotificationBestEffort(
                `Docker ${eventPrefix} update failed`,
                `${serviceLabel(lockedService)}: ${message}`,
                `docker:updater:${eventPrefix}-failed:${lockedService.id}:${nowIso().slice(0, 10)}`,
                "error",
                {
                    architecture,
                    digest: lockedService.latest_digest,
                    os,
                }
            );
            return {
                step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                ok: false,
                stdout: "",
                stderr: message,
            };
        }

        try {
            db.prepare(
                `UPDATE docker_managed_services
                 SET compose_image_ref = ?, current_tag = ?, current_digest = ?,
                     tag_match_pattern = CASE
                         WHEN tag_match_type = 'exact' THEN ?
                         ELSE tag_match_pattern
                     END,
                     last_updated_at = ?, last_checked_at = ?, last_status = 'updated'
                 WHERE id = ?`
            ).run(
                target,
                lockedService.latest_tag,
                lockedService.latest_digest,
                lockedService.latest_tag,
                nowIso(),
                nowIso(),
                lockedService.id
            );
            insertEventBestEffort(
                lockedService,
                `${eventPrefix}_update_succeeded`,
                "Docker service updated",
                { targetComposeImageRef: target }
            );
            createNotificationBestEffort(
                "Docker service updated",
                `${serviceLabel(lockedService)} updated to ${target}`,
                `docker:updater:updated:${lockedService.id}:${target}`
            );
            return {
                step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                ok: true,
                stdout: result.stdout,
                stderr: result.stderr,
            };
        } catch (error) {
            const message = caughtMessage(error);
            insertEventBestEffort(
                lockedService,
                `${eventPrefix}_update_reconcile_failed`,
                `Docker service updated but failed to persist updater state: ${message}`,
                {
                    targetComposeImageRef: target,
                }
            );
            const [os = "linux", architecture = null] =
                servicePlatform(lockedService).split("/");
            createNotificationBestEffort(
                `Docker ${eventPrefix} update needs reconciliation`,
                `${serviceLabel(lockedService)} updated to ${target}, but state persistence failed: ${message}`,
                `docker:updater:${eventPrefix}-reconcile-failed:${lockedService.id}:${nowIso().slice(0, 10)}`,
                "error",
                {
                    architecture,
                    digest: lockedService.latest_digest,
                    os,
                }
            );
            return {
                step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                ok: false,
                stdout: result.stdout,
                stderr: `Docker service updated but failed to persist updater state: ${message}`,
            };
        }
    });
}

async function pruneDanglingImagesBestEffort(): Promise<void> {
    try {
        await execFileAsync(getDockerBin(), ["image", "prune", "-f"], {
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 120_000,
        });
    } catch (error) {
        console.error("[DockerUpdater] Failed to prune dangling images", {
            error: caughtMessage(error),
        });
    }
}

export async function runDockerUpdaterService(
    serviceId?: number
): Promise<DockerUpdaterStepResult[]> {
    const requestedService =
        serviceId === undefined
            ? undefined
            : (db
                  .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
                  .get(serviceId) as ManagedServiceRow | undefined);
    const register = await registerDockerUpdaterServices();
    if (serviceId === undefined && shouldBlockGlobalUpdateForDiscoveryFailure(register)) {
        return [register];
    }
    if (serviceId !== undefined) {
        const service = db
            .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
            .get(serviceId) as ManagedServiceRow | undefined;
        if (!service) {
            if (
                requestedService &&
                shouldBlockManualUpdateForDiscoveryFailure(
                    register,
                    requestedService.app_slug
                )
            ) {
                return [
                    register,
                    {
                        step: `manual-update:${serviceLabel(requestedService)}`,
                        ok: false,
                        code: "CONFLICT",
                        stdout: "",
                        stderr: "Docker updater discovery failed for the selected service",
                    },
                ];
            }
            return [
                register,
                {
                    step: requestedService
                        ? `manual-update:${serviceLabel(requestedService)}`
                        : "manual-update",
                    ok: false,
                    code: "NOT_FOUND",
                    stdout: "",
                    stderr: "Docker updater service not found",
                },
            ];
        }
        if (shouldBlockManualUpdateForDiscoveryFailure(register, service.app_slug)) {
            return [
                register,
                {
                    step: `manual-update:${serviceLabel(service)}`,
                    ok: false,
                    code: "CONFLICT",
                    stdout: "",
                    stderr: "Docker updater discovery failed for the selected service",
                },
            ];
        }
        if (service.enabled !== 1) {
            return [
                register,
                {
                    step: `manual-update:${serviceLabel(service)}`,
                    ok: false,
                    code: "DISABLED",
                    stdout: "",
                    stderr: "Docker updater service not found or disabled",
                },
            ];
        }
        const poll = await pollDockerUpdaterRegistries(service.id);
        if (!poll?.ok) {
            return [register, poll].filter(
                (step): step is DockerUpdaterStepResult => step !== undefined
            );
        }
        const refreshedService = db
            .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
            .get(serviceId) as ManagedServiceRow | undefined;
        if (!refreshedService) {
            return [
                register,
                poll,
                {
                    step: "manual-update",
                    ok: false,
                    code: "NOT_FOUND",
                    stdout: "",
                    stderr: "Docker updater service not found after registry poll",
                },
            ];
        }
        if (refreshedService.enabled !== 1) {
            return [
                register,
                poll,
                {
                    step: `manual-update:${serviceLabel(refreshedService)}`,
                    ok: false,
                    code: "DISABLED",
                    stdout: "",
                    stderr: "Docker updater service not found or disabled",
                },
            ];
        }
        if (refreshedService.last_status === "unsupported_registry") {
            return [
                register,
                poll,
                {
                    step: `manual-update:${serviceLabel(refreshedService)}`,
                    ok: false,
                    code: "UNSUPPORTED_REGISTRY",
                    stdout: "",
                    stderr: `Unsupported image registry: ${imageRegistry(refreshedService.image_repo)}`,
                },
            ];
        }
        if (!hasUpdate(refreshedService)) {
            return [
                register,
                poll,
                {
                    step: `manual-update-skipped:${serviceLabel(refreshedService)}`,
                    ok: false,
                    code: "CONFLICT",
                    stdout: "No update available after registry poll",
                    stderr: "",
                },
            ];
        }
        const apply = await applyServiceUpdate(refreshedService, "manual");
        if (apply.ok) {
            await pruneDanglingImagesBestEffort();
        }
        return [register, poll, apply];
    }
    const blockedAppSlugs = failedDiscoveryAppSlugs(register);
    const poll = await pollDockerUpdaterRegistries();
    const autoServices = db
        .prepare(
            "SELECT * FROM docker_managed_services WHERE enabled = 1 AND policy = 'auto'"
        )
        .all() as unknown as ManagedServiceRow[];
    const applyResults: DockerUpdaterStepResult[] = [];
    for (const service of autoServices) {
        if (
            blockedAppSlugs.has(service.app_slug) ||
            service.last_status !== "update_available" ||
            !hasUpdate(service)
        ) {
            continue;
        }
        applyResults.push(await applyServiceUpdate(service, "auto"));
    }
    if (applyResults.some((step) => step.ok)) {
        await pruneDanglingImagesBestEffort();
    }
    return [register, poll, ...applyResults];
}

export function registerDockerUpdaterScheduledJobs(): void {
    const job = {
        id: "docker.updater",
        name: "Docker updater",
        description: "Poll Docker registries and apply approved automatic updates.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "docker.updater",
        actionPayload: {},
    } as const;
    registerScheduledJobAction(
        "docker.updater",
        async () => {
            const steps = await runDockerUpdaterService();
            const failed = steps.filter(
                (step) => !step.ok && !isNonblockingRegistrationFailure(step)
            );
            if (failed.length > 0) {
                throw new Error(
                    failed.map((step) => `${step.step}: ${step.stderr}`).join("\n")
                );
            }
            return { steps };
        },
        { timeoutMs: 30 * 60 * 1000 }
    );
    db.exec("BEGIN");
    try {
        removeScheduledJobsNotInAction("docker.updater", [job.id]);
        const existing = getScheduledJob(job.id);
        upsertScheduledJob({
            ...job,
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? job.scheduleType,
            intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
            timeOfDay: existing?.timeOfDay ?? null,
            cronExpression: existing?.cronExpression ?? null,
        });
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

export const __testing = {
    applyServiceUpdate,
    buildTargetImageRef,
    fetchJson,
    failedDiscoveryAppSlugs,
    getDockerAppsRoot,
    getComposeCommand,
    imageRegistry,
    imageMatchesPlatform,
    hasUpdate,
    listComposeFiles,
    lookupDockerHub,
    lookupGhcr,
    needsFullTagScan,
    normalizeDockerHubRepo,
    normalizeLabels,
    caughtMessage,
    fetchRegistryJson,
    isSafeTagRegexPattern,
    lookupLatest,
    parseBearerChallenge,
    parseNextLink,
    pruneDanglingImagesBestEffort,
    setNestedValue,
    shouldBlockGlobalUpdateForDiscoveryFailure,
    shouldBlockManualUpdateForDiscoveryFailure,
    servicesFromCompose,
    stripRegistry,
    tagMatches,
    writeFileWithMetadata,
};
