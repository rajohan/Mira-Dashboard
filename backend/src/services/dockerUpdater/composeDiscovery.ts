import fs from "node:fs";
import path from "node:path";

import { YAML } from "bun";

import { database, sqlNullable } from "../../database/connection.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { stringFallback } from "../../lib/values.ts";
import { getDockerAppsRoot, managedComposePath } from "./composeProject.ts";
import { isSafeTagRegexPattern } from "./registryClient.ts";
import { caughtMessage, nowIso, parseImageReference } from "./support.ts";
import type { DiscoveredComposeService, DockerUpdaterStepResult } from "./types.ts";

const logger = createStructuredLogger("docker-updater");
const COMPOSE_FILENAMES = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
];

function normalizeComposeLabelValue(value: unknown): string {
    return stringFallback(value).replaceAll("$$", "$");
}

function normalizeLabels(rawLabels: unknown): Map<string, string> {
    if (Array.isArray(rawLabels)) {
        return new Map(
            rawLabels.map((label) => {
                const text = String(label);
                const index = text.indexOf("=");
                return index === -1
                    ? [text, ""]
                    : [
                          text.slice(0, index),
                          normalizeComposeLabelValue(text.slice(index + 1)),
                      ];
            })
        );
    }
    if (rawLabels && typeof rawLabels === "object") {
        return new Map(
            Object.entries(rawLabels).map(([key, value]) => [
                String(key),
                normalizeComposeLabelValue(value),
            ])
        );
    }
    return new Map();
}

function isBooleanLabel(value: string | undefined, isFallback = false): boolean {
    if (value === undefined || value === "") return isFallback;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function listComposeFiles(root = getDockerAppsRoot()): string[] {
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
            const appRoot = path.join(root, entry.name);
            const composePath = COMPOSE_FILENAMES.map((filename) =>
                path.join(appRoot, filename)
            ).find((file) => {
                try {
                    managedComposePath(file);
                    return true;
                } catch {
                    return false;
                }
            });
            return composePath ? [managedComposePath(composePath)] : [];
        });
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
          isOk: true;
          services: DiscoveredComposeService[];
      }
    | {
          appSlug: string;
          error: string;
          isOk: false;
          services: DiscoveredComposeService[];
      } {
    const appSlug = path.basename(path.dirname(composePath));
    try {
        const parsed = YAML.parse(fs.readFileSync(composePath, "utf8"));
        if (!isPlainObject(parsed) || !isPlainObject(parsed.services)) {
            return {
                appSlug,
                error: `Compose file ${composePath} must contain a services object`,
                isOk: false,
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
            const imageReference = service.image;
            const labels = normalizeLabels(service.labels);
            const image = parseImageReference(imageReference);
            const configuredPinMode = labels
                .get("mira.updater.track")
                ?.trim()
                .toLowerCase();
            const tagPattern = labels.get("mira.updater.tagPattern") || undefined;
            const isTagPatternIsRegex = isBooleanLabel(
                labels.get("mira.updater.tagPatternIsRegex"),
                true
            );
            const currentTag = image.tag ?? (image.digest ? undefined : "latest");
            let pinMode: "digest" | "tag" = image.pinMode === "digest" ? "digest" : "tag";
            if (configuredPinMode === "digest" || configuredPinMode === "tag") {
                pinMode = configuredPinMode;
            }
            let tagMatchType: "exact" | "regex" = "exact";
            const tagMatchPattern = tagPattern ?? currentTag;
            if (tagPattern && isTagPatternIsRegex) {
                if (!isSafeTagRegexPattern(tagPattern)) {
                    const message = `Unsafe tag pattern regex for ${appSlug}/${serviceName}: ${tagPattern} (pattern failed safety checks)`;
                    logger.warn("docker_updater.unsafe_tag_pattern_ignored", {
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
                composeImageRef: imageReference,
                composeImageField: `services.${serviceName}.image`,
                currentTag,
                currentDigest: image.digest,
                policy: isBooleanLabel(labels.get("mira.updater.autoUpdate"), false)
                    ? "auto"
                    : "notify",
                pinMode,
                tagMatchType,
                tagMatchPattern,
                enabled: labels.has("mira.updater.enabled")
                    ? isBooleanLabel(labels.get("mira.updater.enabled"), true)
                    : true,
                metadata: {
                    discoveredBy: "dashboard-docker-updater",
                    discoveredAt: nowIso(),
                    containerName:
                        typeof service.container_name === "string"
                            ? service.container_name
                            : undefined,
                    platform:
                        typeof service.platform === "string"
                            ? service.platform
                            : undefined,
                    labels: Object.fromEntries(labels),
                },
            });
        }
        if (serviceErrors.length > 0) {
            return {
                appSlug,
                error: serviceErrors.join("; "),
                isOk: false,
                services,
            };
        }
        return {
            appSlug,
            isOk: true,
            services,
        };
    } catch (error) {
        logger.error("docker_updater.compose_discovery_failed", {
            composePath,
            error,
        });
        return { appSlug, error: caughtMessage(error), isOk: false, services: [] };
    }
}

export function registerDockerUpdaterServices(
    signal?: AbortSignal
): DockerUpdaterStepResult {
    signal?.throwIfAborted();
    let composeFiles: string[];
    try {
        const appsRoot = getDockerAppsRoot();
        if (!fs.existsSync(appsRoot)) {
            return {
                isOk: false,
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
            isOk: false,
            step: "register-services",
            stdout: "",
            stderr: JSON.stringify({
                registered: 0,
                failed: [{ appSlug: "*", error: caughtMessage(error) }],
            }),
        };
    }
    const discoveries = composeFiles.map((composeFile) =>
        servicesFromCompose(composeFile)
    );
    const failedDiscoveries = discoveries.filter((discovery) => !discovery.isOk);
    const successfulOrPartialDiscoveries = discoveries.filter(
        (discovery) => discovery.isOk || discovery.services.length > 0
    );
    const services = successfulOrPartialDiscoveries.flatMap(
        (discovery) => discovery.services
    );
    const timestamp = nowIso();
    const upsert = database.prepare(
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
    let isTxnStarted = false;
    try {
        signal?.throwIfAborted();
        database.run("BEGIN IMMEDIATE");
        isTxnStarted = true;
        const failedAppSlugs = new Set(
            failedDiscoveries.map((discovery) => discovery.appSlug)
        );
        const discoveredAppSlugs = new Set(
            successfulOrPartialDiscoveries.map((item) => item.appSlug)
        );
        for (const appSlug of discoveredAppSlugs) {
            if (failedAppSlugs.has(appSlug)) {
                continue;
            }
            const serviceNames = new Set(
                services
                    .filter((service) => service.appSlug === appSlug)
                    .map((service) => service.serviceName)
            );
            for (const row of database
                .prepare(
                    "SELECT id, service_name FROM docker_managed_services WHERE app_slug = ?"
                )
                .all(appSlug) as Array<{ id: number; service_name: string }>) {
                if (!serviceNames.has(row.service_name)) {
                    database
                        .prepare("DELETE FROM docker_managed_services WHERE id = ?")
                        .run(row.id);
                }
            }
        }
        for (const row of database
            .prepare("SELECT DISTINCT app_slug FROM docker_managed_services")
            .all() as Array<{ app_slug: string }>) {
            if (
                !discoveredAppSlugs.has(row.app_slug) &&
                !failedAppSlugs.has(row.app_slug)
            ) {
                database
                    .prepare("DELETE FROM docker_managed_services WHERE app_slug = ?")
                    .run(row.app_slug);
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
                sqlNullable(service.currentTag),
                sqlNullable(service.currentDigest),
                service.policy,
                service.pinMode,
                service.tagMatchType,
                sqlNullable(service.tagMatchPattern),
                service.enabled ? 1 : 0,
                JSON.stringify(service.metadata),
                timestamp
            );
        }
        database.run("COMMIT");
    } catch (error) {
        let failureMessage = caughtMessage(error);
        if (isTxnStarted) {
            try {
                database.run("ROLLBACK");
            } catch (rollbackError) {
                failureMessage += `; rollback failed: ${caughtMessage(rollbackError)}`;
            }
        }
        signal?.throwIfAborted();
        return {
            isOk: false,
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
        isOk: failedDiscoveries.length === 0,
        stdout: JSON.stringify({
            isOk: failedDiscoveries.length === 0,
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
