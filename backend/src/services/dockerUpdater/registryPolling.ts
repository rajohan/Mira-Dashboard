import { database, sqlNullable } from "../../database/connection.ts";
import { createNotificationBestEffort } from "./notifications.ts";
import { hasUpdate, imageRegistry, lookupLatest } from "./registryClient.ts";
import { insertEventBestEffort } from "./repository.ts";
import { caughtMessage, nowIso, serviceLabel } from "./support.ts";
import {
    type DockerUpdaterStepResult,
    type ManagedServiceRow,
    normalizeManagedServiceRows,
} from "./types.ts";

export async function pollDockerUpdaterRegistries(
    serviceId?: number,
    signal?: AbortSignal
): Promise<DockerUpdaterStepResult> {
    signal?.throwIfAborted();
    const timestamp = nowIso();
    const services = normalizeManagedServiceRows(
        serviceId === undefined
            ? (database
                  .prepare(
                      "SELECT * FROM docker_managed_services WHERE enabled = 1 ORDER BY app_slug, service_name"
                  )
                  .all() as unknown as ManagedServiceRow[])
            : (database
                  .prepare(
                      "SELECT * FROM docker_managed_services WHERE id = ? AND enabled = 1 ORDER BY app_slug, service_name"
                  )
                  .all(serviceId) as unknown as ManagedServiceRow[])
    );
    const checkedServices: string[] = [];
    const updates: string[] = [];
    const newUpdates: string[] = [];
    const skipped: Array<{ service: string; reason: string }> = [];
    const failures: Array<{ service: string; error: string }> = [];
    for (const service of services) {
        try {
            signal?.throwIfAborted();
            const latest = await lookupLatest(service, signal);
            if ("unsupported" in latest && latest.unsupported) {
                skipped.push({
                    service: serviceLabel(service),
                    reason: `Unsupported image registry: ${imageRegistry(service.image_repo)}`,
                });
                database
                    .prepare(
                        `UPDATE docker_managed_services
                     SET latest_tag = NULL, latest_digest = NULL,
                         last_checked_at = ?, last_status = 'unsupported_registry'
                     WHERE id = ?`
                    )
                    .run(timestamp, service.id);
                continue;
            }
            const updatedService = {
                ...service,
                latest_tag: latest.latestTag ?? undefined,
                latest_digest: latest.latestDigest ?? undefined,
            };
            const isUpdateAvailable = hasUpdate(updatedService);
            const isUpdateChanged =
                service.last_status !== "update_available" ||
                service.latest_tag !== updatedService.latest_tag ||
                service.latest_digest !== updatedService.latest_digest;
            database
                .prepare(
                    `UPDATE docker_managed_services
                 SET latest_tag = ?, latest_digest = ?, last_checked_at = ?, last_status = ?
                 WHERE id = ?`
                )
                .run(
                    sqlNullable(latest.latestTag ?? undefined),
                    sqlNullable(latest.latestDigest ?? undefined),
                    timestamp,
                    isUpdateAvailable ? "update_available" : "current",
                    service.id
                );
            checkedServices.push(serviceLabel(service));
            if (isUpdateAvailable) {
                updates.push(serviceLabel(service));
                if (isUpdateChanged) {
                    newUpdates.push(serviceLabel(service));
                    insertEventBestEffort(
                        updatedService,
                        "update_available",
                        "Docker update available"
                    );
                }
            }
        } catch (error) {
            signal?.throwIfAborted();
            failures.push({
                service: serviceLabel(service),
                error: caughtMessage(error),
            });
            database
                .prepare(
                    `UPDATE docker_managed_services
                 SET last_checked_at = ?, last_status = 'registry_check_failed'
                 WHERE id = ?`
                )
                .run(timestamp, service.id);
        }
    }
    if (newUpdates.length > 0) {
        createNotificationBestEffort(
            "Docker updates available",
            newUpdates.join(", "),
            "docker:updater:updates-available"
        );
    }
    const isOk =
        failures.length === 0 || (serviceId === undefined && checkedServices.length > 0);
    return {
        step: "poll",
        isOk: isOk,
        stdout: JSON.stringify({
            isOk: isOk,
            checkedAt: timestamp,
            isChecked: checkedServices,
            skipped,
            updates,
        }),
        stderr: failures
            .map((failure) => `${failure.service}: ${failure.error}`)
            .join("\n"),
    };
}
