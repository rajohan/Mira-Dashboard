import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import safeRegex from "safe-regex2";
import YAML from "yaml";

import { db } from "../db.js";
import { nonEmptyEnvFallback } from "../lib/values.js";

const APPS_ROOT = nonEmptyEnvFallback("MIRA_DOCKER_APPS_ROOT", "/opt/docker/apps");
const COMPOSE_FILENAME = "compose.yaml";
const execFileAsync = promisify(execFile);

export interface DockerUpdaterStepResult {
    step: string;
    ok: boolean;
    stdout: string;
    stderr: string;
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
}

type JsonRecord = Record<string, unknown>;

interface ComposeService {
    image?: unknown;
    labels?: unknown;
    container_name?: unknown;
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
        return response.json() as Promise<JsonRecord>;
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timeout for ${url}`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function isGhcrRepo(repo: string): boolean {
    return repo.startsWith("ghcr.io/");
}

function stripRegistry(repo: string) {
    if (isGhcrRepo(repo)) {
        return repo.replace(/^ghcr\.io\//u, "");
    }
    if (repo.startsWith("docker.io/")) {
        return repo.replace(/^docker\.io\//u, "");
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

async function lookupDockerHub(service: ManagedServiceRow) {
    const repo = normalizeDockerHubRepo(stripRegistry(service.image_repo));
    const tagsUrl = `https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100`;
    const tagsData = await fetchJson(tagsUrl);
    const candidates = (Array.isArray(tagsData.results) ? tagsData.results : [])
        .map((item) => String(asRecord(item).name || ""))
        .filter((tag: string) => tag && tagMatches(service, tag))
        .sort(compareTags);
    const latestTag = candidates.at(-1) || service.current_tag;
    let latestDigest = service.current_digest;
    if (latestTag) {
        const tagData = await fetchJson(
            `https://hub.docker.com/v2/repositories/${repo}/tags/${encodeURIComponent(latestTag)}`
        );
        const image = (Array.isArray(tagData.images) ? tagData.images : []).find(
            (candidate) => {
                const image = asRecord(candidate);
                return (
                    image.architecture === "arm64" &&
                    (image.variant === null ||
                        image.variant === undefined ||
                        image.variant === "v8")
                );
            }
        );
        latestDigest = String(asRecord(image).digest ?? tagData.digest ?? latestDigest);
    }
    return { latestTag, latestDigest };
}

async function lookupGhcr(service: ManagedServiceRow) {
    const repo = stripRegistry(service.image_repo);
    const tag = service.current_tag || service.tag_match_pattern;
    if (!tag) {
        return { latestTag: service.latest_tag, latestDigest: service.latest_digest };
    }
    const response = await fetch(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
        headers: {
            Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json",
            "User-Agent": "mira-dashboard-docker-updater/1.0",
        },
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ghcr.io/${repo}:${tag}`);
    }
    return {
        latestTag: tag,
        latestDigest:
            response.headers.get("docker-content-digest") || service.latest_digest,
    };
}

async function lookupLatest(service: ManagedServiceRow) {
    if (process.env.MIRA_DOCKER_UPDATER_SKIP_REGISTRY === "1") {
        return {
            latestTag: service.latest_tag || service.current_tag,
            latestDigest: service.latest_digest || service.current_digest,
        };
    }
    return isGhcrRepo(service.image_repo)
        ? lookupGhcr(service)
        : lookupDockerHub(service);
}

function hasUpdate(service: ManagedServiceRow): boolean {
    if (service.pin_mode === "digest") {
        return Boolean(
            service.latest_digest &&
            service.current_digest &&
            service.latest_digest !== service.current_digest
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
        return parsed.tag
            ? `${parsed.repo}:${parsed.tag}@${service.latest_digest}`
            : `${parsed.repo}@${service.latest_digest}`;
    }
    return `${parsed.repo}:${service.latest_tag || service.current_tag || "latest"}`;
}

function setNestedValue(target: JsonRecord, dottedPath: string, value: string) {
    const parts = dottedPath.split(".");
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
            managed_service_id, event_type, from_tag, to_tag, from_digest, to_digest,
            message, details_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        service.id,
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

function createNotification(title: string, description: string, dedupeKey: string) {
    const timestamp = nowIso();
    db.prepare(
        `INSERT INTO notifications (
            title, description, type, source, dedupe_key, metadata_json,
            is_read, created_at, updated_at, occurred_at
         ) VALUES (?, ?, 'info', 'docker-updater', ?, '{}', 0, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            updated_at = excluded.updated_at,
            occurred_at = excluded.occurred_at`
    ).run(title, description, dedupeKey, timestamp, timestamp, timestamp);
}

async function applyComposeUpdate(service: ManagedServiceRow, targetImageRef: string) {
    if (!service.compose_image_field) {
        throw new Error(
            `Service ${serviceLabel(service)} is missing compose image field`
        );
    }
    const composePath = service.compose_path;
    const raw = fs.readFileSync(composePath, "utf8");
    const doc = YAML.parse(raw) as JsonRecord;
    setNestedValue(doc, service.compose_image_field, targetImageRef);
    fs.writeFileSync(composePath, YAML.stringify(doc));
    try {
        const { stdout, stderr } = await execFileAsync(
            "docker",
            ["compose", "-f", composePath, "up", "-d", service.service_name],
            {
                cwd: path.dirname(composePath),
                env: process.env,
                maxBuffer: 10 * 1024 * 1024,
                timeout: 180_000,
            }
        );
        return { stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
        try {
            fs.writeFileSync(composePath, raw);
        } catch (rollbackError) {
            console.error("[DockerUpdater] Failed to restore compose file", {
                composePath,
                rollbackError,
            });
        }
        throw error;
    }
}

function booleanLabel(value: string | undefined, fallback = false): boolean {
    if (value == null || value === "") return fallback;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function listComposeFiles(root = APPS_ROOT): string[] {
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name, COMPOSE_FILENAME))
        .filter((file) => fs.existsSync(file));
}

function servicesFromCompose(composePath: string) {
    const appSlug = path.basename(path.dirname(composePath));
    const parsed = YAML.parse(fs.readFileSync(composePath, "utf8")) as {
        services?: Record<string, ComposeService>;
    } | null;
    return Object.entries(parsed?.services ?? {})
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
            return {
                appSlug,
                serviceName,
                composePath,
                imageRepo: image.repo,
                composeImageRef: imageRef,
                composeImageField: `services.${serviceName}.image`,
                currentTag: image.tag,
                currentDigest: image.digest,
                policy: booleanLabel(labels.get("mira.updater.autoUpdate"), false)
                    ? "auto"
                    : "notify",
                pinMode:
                    configuredPinMode === "digest" || configuredPinMode === "tag"
                        ? configuredPinMode
                        : image.pinMode,
                tagMatchType: tagPattern ? "regex" : "exact",
                tagMatchPattern: tagPattern ?? image.tag,
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
                    labels: Object.fromEntries(labels),
                },
            };
        });
}

export async function registerDockerUpdaterServices(): Promise<DockerUpdaterStepResult> {
    const composeFiles = listComposeFiles();
    const services = composeFiles.flatMap(servicesFromCompose);
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
            last_checked_at = excluded.last_checked_at,
            last_status = excluded.last_status`
    );
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

export async function pollDockerUpdaterRegistries(): Promise<DockerUpdaterStepResult> {
    const timestamp = nowIso();
    const services = db
        .prepare(
            "SELECT * FROM docker_managed_services WHERE enabled = 1 ORDER BY app_slug, service_name"
        )
        .all() as unknown as ManagedServiceRow[];
    const checked: string[] = [];
    const updates: string[] = [];
    const failures: Array<{ service: string; error: string }> = [];
    for (const service of services) {
        try {
            const latest = await lookupLatest(service);
            db.prepare(
                `UPDATE docker_managed_services
                 SET latest_tag = ?, latest_digest = ?, last_checked_at = ?, last_status = ?
                 WHERE id = ?`
            ).run(
                latest.latestTag ?? null,
                latest.latestDigest ?? null,
                timestamp,
                latest.latestTag !== service.current_tag ||
                    latest.latestDigest !== service.current_digest
                    ? "update_available"
                    : "current",
                service.id
            );
            checked.push(serviceLabel(service));
            const updatedService = {
                ...service,
                latest_tag: latest.latestTag ?? null,
                latest_digest: latest.latestDigest ?? null,
            };
            if (hasUpdate(updatedService)) {
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
                 SET last_checked_at = ?, last_status = 'registry_check_failed'
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
    const target = buildTargetImageRef(service);
    try {
        const result = await applyComposeUpdate(service, target);
        db.prepare(
            `UPDATE docker_managed_services
             SET compose_image_ref = ?, current_tag = ?, current_digest = ?,
                 last_updated_at = ?, last_checked_at = ?, last_status = 'updated'
             WHERE id = ?`
        ).run(
            target,
            service.pin_mode === "tag" ? service.latest_tag : service.current_tag,
            service.pin_mode === "digest"
                ? service.latest_digest
                : service.current_digest,
            nowIso(),
            nowIso(),
            service.id
        );
        insertEvent(
            service,
            `${eventPrefix}_update_succeeded`,
            "Docker service updated",
            { targetComposeImageRef: target }
        );
        createNotification(
            "Docker service updated",
            `${serviceLabel(service)} updated to ${target}`,
            `docker:updater:updated:${service.id}:${target}`
        );
        return {
            step: `${eventPrefix}-update:${serviceLabel(service)}`,
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
        ).run(nowIso(), `${eventPrefix}_update_failed`, service.id);
        insertEvent(service, `${eventPrefix}_update_failed`, message, {
            targetComposeImageRef: target,
        });
        createNotification(
            `Docker ${eventPrefix} update failed`,
            `${serviceLabel(service)}: ${message}`,
            `docker:updater:${eventPrefix}-failed:${service.id}:${nowIso().slice(0, 10)}`
        );
        return {
            step: `${eventPrefix}-update:${serviceLabel(service)}`,
            ok: false,
            stdout: "",
            stderr: message,
        };
    }
}

export async function runDockerUpdaterService(
    serviceId?: number
): Promise<DockerUpdaterStepResult[]> {
    const register = await registerDockerUpdaterServices();
    const poll = await pollDockerUpdaterRegistries();
    if (serviceId !== undefined) {
        const service = db
            .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
            .get(serviceId) as ManagedServiceRow | undefined;
        if (!service) {
            return [
                register,
                poll,
                {
                    step: "manual-update",
                    ok: false,
                    stdout: "",
                    stderr: "Docker updater service not found",
                },
            ];
        }
        return [register, poll, await applyServiceUpdate(service, "manual")];
    }
    const autoServices = db
        .prepare(
            "SELECT * FROM docker_managed_services WHERE enabled = 1 AND policy = 'auto'"
        )
        .all() as unknown as ManagedServiceRow[];
    const applyResults: DockerUpdaterStepResult[] = [];
    for (const service of autoServices.filter(hasUpdate)) {
        applyResults.push(await applyServiceUpdate(service, "auto"));
    }
    return [register, poll, ...applyResults];
}

export const __testing = {
    applyServiceUpdate,
    buildTargetImageRef,
    fetchJson,
    hasUpdate,
    listComposeFiles,
    lookupDockerHub,
    lookupGhcr,
    normalizeDockerHubRepo,
    normalizeLabels,
    caughtMessage,
    isSafeTagRegexPattern,
    setNestedValue,
    servicesFromCompose,
    stripRegistry,
    tagMatches,
};
