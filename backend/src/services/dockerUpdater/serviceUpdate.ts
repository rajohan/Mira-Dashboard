import { database, sqlNullable } from "../../database/connection.ts";
import { runProcess } from "../../lib/processes.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    applyComposeUpdateUnlocked,
    withComposeUpdateLock,
} from "./composeTransaction.ts";
import { createNotificationBestEffort } from "./notifications.ts";
import {
    buildTargetImageReference,
    hasUpdate,
    servicePlatform,
} from "./registryClient.ts";
import { insertEventBestEffort } from "./repository.ts";
import { caughtMessage, getDockerBin, nowIso, serviceLabel } from "./support.ts";
import {
    type DockerUpdaterStepResult,
    type ManagedServiceRow,
    normalizeManagedServiceRow,
} from "./types.ts";

const logger = createStructuredLogger("docker-updater");

export async function applyServiceUpdate(
    service: ManagedServiceRow,
    eventPrefix: "auto" | "manual",
    signal?: AbortSignal
): Promise<DockerUpdaterStepResult> {
    return withComposeUpdateLock(
        service,
        async () => {
            signal?.throwIfAborted();
            const lockedService = normalizeManagedServiceRow(
                database
                    .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
                    .get(service.id) as ManagedServiceRow | undefined
            );
            if (!lockedService || lockedService.enabled !== 1) {
                const code = lockedService ? "DISABLED" : "NOT_FOUND";
                return {
                    kind: "update",
                    step: `${eventPrefix}-update:${serviceLabel(service)}`,
                    isOk: false,
                    code,
                    stdout: "",
                    stderr: "Docker updater service not found or disabled",
                };
            }
            if (!hasUpdate(lockedService)) {
                return {
                    kind: "update",
                    step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                    isOk: false,
                    code: "CONFLICT",
                    stdout: "",
                    stderr: "No update available",
                };
            }
            const target = buildTargetImageReference(lockedService);
            let result: Awaited<ReturnType<typeof applyComposeUpdateUnlocked>>;
            try {
                // Compose writes tag-only refs for non-digest pins, then pulls so
                // digest drift still refreshes mutable tags without storing @digest.
                result = await applyComposeUpdateUnlocked(lockedService, target, signal);
            } catch (error) {
                signal?.throwIfAborted();
                const message = caughtMessage(error);
                database
                    .prepare(
                        `UPDATE docker_managed_services
                 SET last_checked_at = ?, last_status = ?
                 WHERE id = ?`
                    )
                    .run(nowIso(), `${eventPrefix}_update_failed`, lockedService.id);
                insertEventBestEffort(
                    lockedService,
                    `${eventPrefix}_update_failed`,
                    message,
                    {
                        targetComposeImageRef: target,
                    }
                );
                const [os = "linux", architecture] = servicePlatform(lockedService).split(
                    "/",
                    2
                );
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
                    kind: "update",
                    step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                    isOk: false,
                    stdout: "",
                    stderr: message,
                };
            }

            try {
                database
                    .prepare(
                        `UPDATE docker_managed_services
                 SET compose_image_ref = ?, current_tag = ?, current_digest = ?,
                     tag_match_pattern = CASE
                         WHEN tag_match_type = 'exact' THEN ?
                         ELSE tag_match_pattern
                     END,
                     last_updated_at = ?, last_checked_at = ?, last_status = 'updated'
                 WHERE id = ?`
                    )
                    .run(
                        target,
                        sqlNullable(lockedService.latest_tag),
                        sqlNullable(lockedService.latest_digest),
                        sqlNullable(lockedService.latest_tag),
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
                    kind: "update",
                    step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                    changedPaths: result.changedPaths,
                    isOk: true,
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
                const [os = "linux", architecture] = servicePlatform(lockedService).split(
                    "/",
                    2
                );
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
                    kind: "update",
                    step: `${eventPrefix}-update:${serviceLabel(lockedService)}`,
                    changedPaths: result.changedPaths,
                    isOk: false,
                    stdout: result.stdout,
                    stderr: `Docker service updated but failed to persist updater state: ${message}`,
                };
            }
        },
        signal
    );
}

export async function pruneDanglingImagesBestEffort(signal?: AbortSignal): Promise<void> {
    try {
        const result = await runProcess(
            getDockerBin(),
            ["image", "prune", "-f", "--filter", "until=24h"],
            {
                env: process.env,
                maxBuffer: 10 * 1024 * 1024,
                signal,
                timeoutMs: 120_000,
            }
        );
        if (result.code !== 0) {
            throw new Error(
                result.stderr.trim() || `docker image prune exited ${result.code}`
            );
        }
    } catch (error) {
        signal?.throwIfAborted();
        logger.error("docker_updater.image_prune_failed", {
            error: caughtMessage(error),
        });
    }
}
