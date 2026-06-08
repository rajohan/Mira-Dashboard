import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import safeRegex from "safe-regex2";
import YAML from "yaml";

import { db } from "../db.js";
import { nonEmptyEnvFallback } from "../lib/values.js";

const COMPOSE_FILENAME = "compose.yaml";
const execFileAsync = promisify(execFile);
const SUPPORTED_REGISTRIES = new Set(["docker.io", "ghcr.io"]);
const composeUpdateLocks = new Map<string, Promise<void>>();

function getDockerBin(): string {
    return nonEmptyEnvFallback("MIRA_DOCKER_BIN", "docker");
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
            args: ["-f", composePath, "up", "-d", serviceName],
        };
    }
    return {
        file: getDockerBin(),
        args: ["compose", "-f", composePath, "up", "-d", serviceName],
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

interface ComposeService {
    image?: unknown;
    labels?: unknown;
    container_name?: unknown;
    platform?: unknown;
}

interface RegistryFetchOptions {
    accept?: string;
}

function nowIso(): string {
    return new Date().toISOString();
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
            return baseUrl ? new URL(link, baseUrl).toString() : link;
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
    const first = repo.split("/")[0] || "";
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
        return new RegExp(service.tag_match_pattern).test(tag);
    }
    return tag === service.tag_match_pattern;
}

function isSafeTagRegexPattern(pattern: string): boolean {
    if (pattern.length > 128) {
        return false;
    }
    return safeRegex(pattern);
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

async function lookupDockerHub(service: ManagedServiceRow) {
    const repo = normalizeDockerHubRepo(stripRegistry(service.image_repo));
    let latestTag = service.current_tag;
    if (service.tag_match_type === "regex") {
        const tags: unknown[] = [];
        let tagsUrl: string | null =
            `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`;
        while (tagsUrl) {
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
    } else if (service.tag_match_pattern) {
        latestTag = service.tag_match_pattern;
    }
    let latestDigest = service.current_digest;
    if (latestTag) {
        const tagData = await fetchJson(
            `https://hub.docker.com/v2/repositories/${repo}/tags/${encodeURIComponent(latestTag)}`
        );
        const platform = servicePlatform(service);
        const image = (Array.isArray(tagData.images) ? tagData.images : []).find(
            (candidate) => imageMatchesPlatform(asRecord(candidate), platform)
        );
        const digest = asRecord(image).digest ?? tagData.digest ?? latestDigest;
        latestDigest = typeof digest === "string" ? digest : null;
    }
    return { latestTag, latestDigest };
}

async function lookupGhcr(service: ManagedServiceRow) {
    const repo = stripRegistry(service.image_repo);
    let tag =
        service.tag_match_type === "exact" && service.tag_match_pattern
            ? service.tag_match_pattern
            : service.current_tag;
    if (service.tag_match_type === "regex" && service.tag_match_pattern) {
        const tags: string[] = [];
        let tagsUrl: string | null = `https://ghcr.io/v2/${repo}/tags/list`;
        while (tagsUrl) {
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
        return { latestTag: service.current_tag, latestDigest: service.current_digest };
    }
    const { body, headers } = await fetchRegistryJsonWithHeaders(
        `https://ghcr.io/v2/${repo}/manifests/${tag}`,
        {
            accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
        }
    );
    return {
        latestTag: tag,
        latestDigest:
            headers.get("docker-content-digest") ||
            (typeof body.digest === "string" ? body.digest : service.latest_digest),
    };
}

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
    return registry === "ghcr.io" ? lookupGhcr(service) : lookupDockerHub(service);
}

function hasUpdate(service: ManagedServiceRow): boolean {
    if (service.pin_mode === "digest") {
        return Boolean(
            service.latest_digest &&
            (!service.current_digest || service.latest_digest !== service.current_digest)
        );
    }
    return Boolean(
        service.latest_tag &&
        service.current_tag &&
        service.latest_tag !== service.current_tag
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
    let current = target;
    for (const part of parts.slice(0, -1)) {
        current[part] =
            current[part] && typeof current[part] === "object" ? current[part] : {};
        current = current[part] as JsonRecord;
    }
    current[parts.at(-1) as string] = value;
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

function createNotification(
    title: string,
    description: string,
    dedupeKey: string,
    type: "info" | "error" = "info"
) {
    const timestamp = nowIso();
    db.prepare(
        `INSERT INTO notifications (
            title, description, type, source, dedupe_key, metadata_json,
            is_read, created_at, updated_at, occurred_at
         ) VALUES (?, ?, ?, 'docker-updater', ?, '{}', 0, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            type = excluded.type,
            is_read = 0,
            updated_at = excluded.updated_at,
            occurred_at = excluded.occurred_at`
    ).run(title, description, type, dedupeKey, timestamp, timestamp, timestamp);
}

function composeUpdateLockKey(service: ManagedServiceRow): string {
    return service.compose_path;
}

async function withComposeUpdateLock<T>(
    service: ManagedServiceRow,
    action: () => Promise<T>
): Promise<T> {
    const key = composeUpdateLockKey(service);
    const previous = composeUpdateLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const next = previous.then(
        () => current,
        () => current
    );
    composeUpdateLocks.set(key, next);
    await previous.catch(() => {});
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
    const composePath = service.compose_path;
    const raw = fs.readFileSync(composePath, "utf8");
    const doc = YAML.parse(raw) as JsonRecord;
    setNestedValue(doc, composeImageField, targetImageRef);
    let composeStarted = false;
    try {
        fs.writeFileSync(composePath, YAML.stringify(doc));
        const command = getComposeCommand(composePath, service.service_name);
        composeStarted = true;
        const { stdout, stderr } = await execFileAsync(command.file, command.args, {
            cwd: path.dirname(composePath),
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 180_000,
        });
        return { stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
        let restored = false;
        try {
            fs.writeFileSync(composePath, raw);
            restored = true;
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

function servicesFromCompose(composePath: string) {
    const appSlug = path.basename(path.dirname(composePath));
    try {
        const parsed = YAML.parse(fs.readFileSync(composePath, "utf8")) as {
            services?: Record<string, ComposeService>;
        } | null;
        return {
            appSlug,
            ok: true,
            services: Object.entries(parsed?.services ?? {})
                .filter(([, service]) => service?.image)
                .map(([serviceName, service]) => {
                    const imageRef = String(service.image);
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
                    return {
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
                        pinMode:
                            configuredPinMode === "digest" || configuredPinMode === "tag"
                                ? configuredPinMode
                                : image.pinMode,
                        tagMatchType: tagPattern && tagPatternIsRegex ? "regex" : "exact",
                        tagMatchPattern: tagPattern ?? currentTag,
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
                                typeof service.platform === "string"
                                    ? service.platform
                                    : null,
                            labels: Object.fromEntries(labels),
                        },
                    };
                }),
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
    if (failedDiscoveries.length > 0) {
        return {
            ok: false,
            step: "register-services",
            stdout: "",
            stderr: JSON.stringify({
                registered: 0,
                failed: failedDiscoveries.map((discovery) => ({
                    appSlug: discovery.appSlug,
                    error: discovery.error,
                })),
            }),
        };
    }
    const successfulDiscoveries = discoveries.filter((discovery) => discovery.ok);
    const services = successfulDiscoveries.flatMap((discovery) => discovery.services);
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
            current_digest = excluded.current_digest,
            policy = excluded.policy,
            pin_mode = excluded.pin_mode,
            tag_match_type = excluded.tag_match_type,
            tag_match_pattern = excluded.tag_match_pattern,
            enabled = excluded.enabled,
            metadata_json = excluded.metadata_json,
            last_checked_at = docker_managed_services.last_checked_at,
            last_status = docker_managed_services.last_status`
    );
    db.exec("BEGIN");
    try {
        for (const appSlug of new Set(
            successfulDiscoveries.map((item) => item.appSlug)
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
            discoveries.map((discovery) => discovery.appSlug)
        );
        for (const row of db
            .prepare("SELECT DISTINCT app_slug FROM docker_managed_services")
            .all() as Array<{ app_slug: string }>) {
            if (!discoveredAppSlugs.has(row.app_slug)) {
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
        db.exec("ROLLBACK");
        throw error;
    }
    return {
        step: "register",
        ok: true,
        stdout: JSON.stringify({
            ok: true,
            summary: {
                composeFiles: composeFiles.length,
                registeredServices: services.length,
            },
        }),
        stderr: "",
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
                insertEvent(
                    updatedService,
                    "update_available",
                    "Docker update available"
                );
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
    if (updates.length > 0) {
        createNotification(
            "Docker updates available",
            updates.join(", "),
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
        const target = buildTargetImageRef(lockedService);
        if (!hasUpdate(lockedService)) {
            return {
                step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                ok: false,
                code: "CONFLICT",
                stdout: "",
                stderr: "No update available",
            };
        }
        try {
            const result = await applyComposeUpdateUnlocked(lockedService, target);
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
            insertEvent(
                lockedService,
                `${eventPrefix}_update_succeeded`,
                "Docker service updated",
                { targetComposeImageRef: target }
            );
            createNotification(
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
            db.prepare(
                `UPDATE docker_managed_services
                 SET last_checked_at = ?, last_status = ?
                 WHERE id = ?`
            ).run(nowIso(), `${eventPrefix}_update_failed`, lockedService.id);
            insertEvent(lockedService, `${eventPrefix}_update_failed`, message, {
                targetComposeImageRef: target,
            });
            createNotification(
                `Docker ${eventPrefix} update failed`,
                `${serviceLabel(lockedService)}: ${message}`,
                `docker:updater:${eventPrefix}-failed:${lockedService.id}:${nowIso().slice(0, 10)}`,
                "error"
            );
            return {
                step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                ok: false,
                stdout: "",
                stderr: message,
            };
        }
    });
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
    if (!register.ok) {
        return [register];
    }
    if (serviceId !== undefined) {
        const service = db
            .prepare(
                "SELECT * FROM docker_managed_services WHERE id = ? AND enabled = 1 LIMIT 1"
            )
            .get(serviceId) as ManagedServiceRow | undefined;
        const poll = service ? await pollDockerUpdaterRegistries(service.id) : undefined;
        if (!service) {
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
        if (!register.ok || !poll?.ok) {
            return [register, poll].filter(
                (step): step is DockerUpdaterStepResult => step !== undefined
            );
        }
        const refreshedService = db
            .prepare(
                "SELECT * FROM docker_managed_services WHERE id = ? AND enabled = 1 LIMIT 1"
            )
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
                    ok: true,
                    stdout: "No update available after registry poll",
                    stderr: "",
                },
            ];
        }
        return [register, poll, await applyServiceUpdate(refreshedService, "manual")];
    }
    const poll = await pollDockerUpdaterRegistries();
    const autoServices = db
        .prepare(
            "SELECT * FROM docker_managed_services WHERE enabled = 1 AND policy = 'auto'"
        )
        .all() as unknown as ManagedServiceRow[];
    const applyResults: DockerUpdaterStepResult[] = [];
    for (const service of autoServices.filter(
        (candidate) =>
            candidate.last_status === "update_available" && hasUpdate(candidate)
    )) {
        applyResults.push(await applyServiceUpdate(service, "auto"));
    }
    return [register, poll, ...applyResults];
}

export const __testing = {
    applyServiceUpdate,
    buildTargetImageRef,
    fetchJson,
    getDockerAppsRoot,
    getComposeCommand,
    imageRegistry,
    imageMatchesPlatform,
    hasUpdate,
    listComposeFiles,
    lookupDockerHub,
    lookupGhcr,
    normalizeDockerHubRepo,
    normalizeLabels,
    caughtMessage,
    fetchRegistryJson,
    isSafeTagRegexPattern,
    lookupLatest,
    parseBearerChallenge,
    parseNextLink,
    setNestedValue,
    servicesFromCompose,
    stripRegistry,
    tagMatches,
};
