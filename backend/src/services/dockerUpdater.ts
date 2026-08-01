import { database, sqlNullable } from "../database.ts";
import { runProcess } from "../lib/processes.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { registerDockerUpdaterServices } from "./dockerUpdater/composeDiscovery.ts";
import {
    applyComposeUpdateUnlocked,
    withComposeUpdateLock,
} from "./dockerUpdater/composeTransaction.ts";
import {
    buildTargetImageReference,
    hasUpdate,
    imageRegistry,
    lookupLatest,
    servicePlatform,
} from "./dockerUpdater/registryClient.ts";
import {
    createNotificationBestEffort,
    insertEventBestEffort,
} from "./dockerUpdater/repository.ts";
import {
    caughtMessage,
    getDockerBin,
    nowIso,
    serviceLabel,
} from "./dockerUpdater/support.ts";
import {
    type DockerUpdaterStepResult,
    type ManagedServiceRow,
    normalizeManagedServiceRow,
    normalizeManagedServiceRows,
} from "./dockerUpdater/types.ts";
import { syncDockerUpdaterChanges } from "./gitHygiene.ts";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    ScheduledJobActionError,
    upsertScheduledJob,
} from "./scheduledJobs.ts";

export type { DockerUpdaterStepResult } from "./dockerUpdater/types.ts";
export {
    isSafeTagPatternMatch,
    isSafeTagRegexPattern,
} from "./dockerUpdater/registryClient.ts";
export { registerDockerUpdaterServices } from "./dockerUpdater/composeDiscovery.ts";

const logger = createStructuredLogger("docker-updater");

function failedDiscoveryAppSlugs(register: DockerUpdaterStepResult): Set<string> {
    if (!register.stderr) {
        return new Set();
    }
    try {
        const parsed = JSON.parse(register.stderr) as {
            failed?: Array<{ appSlug?: unknown; blocking?: unknown }>;
        };
        return new Set(
            (parsed.failed ?? [])
                .filter(
                    (failure) =>
                        typeof failure.appSlug === "string" && failure.blocking !== false
                )
                .map((failure) => failure.appSlug as string)
        );
    } catch {
        return new Set(["*"]);
    }
}

function shouldBlockManualUpdateForDiscoveryFailure(
    register: DockerUpdaterStepResult,
    appSlug: string
): boolean {
    if (register.isOk) {
        return false;
    }
    const failedAppSlugs = failedDiscoveryAppSlugs(register);
    return failedAppSlugs.has("*") || failedAppSlugs.has(appSlug);
}

function shouldBlockGlobalUpdateForDiscoveryFailure(
    register: DockerUpdaterStepResult
): boolean {
    return !register.isOk && failedDiscoveryAppSlugs(register).has("*");
}

export function isNonblockingRegistrationFailure(step: DockerUpdaterStepResult): boolean {
    return (
        step.step === "register-services" &&
        !step.isOk &&
        failedDiscoveryAppSlugs(step).size === 0
    );
}

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
                 SET latest_tag = NULL, latest_digest = NULL,
                     last_checked_at = ?, last_status = 'registry_check_failed'
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

async function applyServiceUpdate(
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
                    step: `${eventPrefix}-update:${serviceLabel(service)}`,
                    isOk: false,
                    code,
                    stdout: "",
                    stderr: "Docker updater service not found or disabled",
                };
            }
            if (!hasUpdate(lockedService)) {
                return {
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

async function pruneDanglingImagesBestEffort(signal?: AbortSignal): Promise<void> {
    try {
        const result = await runProcess(getDockerBin(), ["image", "prune", "-f"], {
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
            signal,
            timeoutMs: 120_000,
        });
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

async function syncDockerUpdaterChangesBestEffort(
    steps: DockerUpdaterStepResult[],
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<void> {
    const updateSteps = steps.filter((step) => step.step.includes("-update:"));
    if (updateSteps.length === 0) {
        try {
            const pendingResult = await syncDockerUpdaterChanges(
                [],
                signal,
                protectFromCancellation
            );
            if (pendingResult.pushed) {
                steps.push({
                    step: "git-sync:docker",
                    isOk: true,
                    stdout: JSON.stringify(pendingResult),
                    stderr: "",
                });
            }
        } catch (error) {
            signal?.throwIfAborted();
            steps.push({
                step: "git-sync:docker",
                isOk: false,
                stdout: "",
                stderr: caughtMessage(error),
            });
        }
        return;
    }
    const changedPaths = updateSteps.flatMap((step) => step.changedPaths ?? []);
    if (changedPaths.length === 0) {
        try {
            const pendingResult = await syncDockerUpdaterChanges(
                [],
                signal,
                protectFromCancellation
            );
            steps.push({
                step: "git-sync:docker",
                isOk: true,
                stdout: JSON.stringify(
                    pendingResult.pushed
                        ? pendingResult
                        : {
                              changedPaths: [],
                              pushed: false,
                              skippedReason: "no updated compose paths",
                          }
                ),
                stderr: "",
            });
        } catch (error) {
            signal?.throwIfAborted();
            steps.push({
                step: "git-sync:docker",
                isOk: false,
                stdout: "",
                stderr: caughtMessage(error),
            });
        }
        return;
    }
    try {
        const result = await syncDockerUpdaterChanges(
            changedPaths,
            signal,
            protectFromCancellation
        );
        steps.push({
            step: "git-sync:docker",
            isOk: true,
            stdout: JSON.stringify(result),
            stderr: "",
        });
    } catch (error) {
        signal?.throwIfAborted();
        steps.push({
            step: "git-sync:docker",
            isOk: false,
            stdout: "",
            stderr: caughtMessage(error),
        });
    }
}

export async function runDockerUpdaterService(
    serviceId?: number,
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<DockerUpdaterStepResult[]> {
    signal?.throwIfAborted();
    let isMutationProtected = false;
    const protectMutation = () => {
        if (isMutationProtected) return;
        protectFromCancellation?.();
        isMutationProtected = true;
    };
    const requestedService =
        serviceId === undefined
            ? undefined
            : normalizeManagedServiceRow(
                  database
                      .prepare(
                          "SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1"
                      )
                      .get(serviceId) as ManagedServiceRow | undefined
              );
    const register = registerDockerUpdaterServices(signal);
    if (serviceId === undefined && shouldBlockGlobalUpdateForDiscoveryFailure(register)) {
        return [register];
    }
    if (serviceId !== undefined) {
        const service = normalizeManagedServiceRow(
            database
                .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
                .get(serviceId) as ManagedServiceRow | undefined
        );
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
                        isOk: false,
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
                    isOk: false,
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
                    isOk: false,
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
                    isOk: false,
                    code: "DISABLED",
                    stdout: "",
                    stderr: "Docker updater service not found or disabled",
                },
            ];
        }
        const poll = await pollDockerUpdaterRegistries(service.id, signal);
        if (!poll?.isOk) {
            return [register, poll].filter(
                (step): step is DockerUpdaterStepResult => step !== undefined
            );
        }
        const refreshedService = normalizeManagedServiceRow(
            database
                .prepare("SELECT * FROM docker_managed_services WHERE id = ? LIMIT 1")
                .get(serviceId) as ManagedServiceRow | undefined
        );
        if (!refreshedService) {
            return [
                register,
                poll,
                {
                    step: "manual-update",
                    isOk: false,
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
                    isOk: false,
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
                    isOk: false,
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
                    isOk: false,
                    code: "CONFLICT",
                    stdout: "No update available after registry poll",
                    stderr: "",
                },
            ];
        }
        protectMutation();
        const apply = await applyServiceUpdate(refreshedService, "manual", signal);
        if (apply.isOk) {
            await pruneDanglingImagesBestEffort(signal);
        }
        const steps = [register, poll, apply];
        await syncDockerUpdaterChangesBestEffort(steps, signal, protectMutation);
        return steps;
    }
    const blockedAppSlugs = failedDiscoveryAppSlugs(register);
    const poll = await pollDockerUpdaterRegistries(undefined, signal);
    const autoServices = normalizeManagedServiceRows(
        database
            .prepare(
                "SELECT * FROM docker_managed_services WHERE enabled = 1 AND policy = 'auto'"
            )
            .all() as unknown as ManagedServiceRow[]
    );
    const applyResults: DockerUpdaterStepResult[] = [];
    for (const service of autoServices) {
        signal?.throwIfAborted();
        if (
            blockedAppSlugs.has(service.app_slug) ||
            service.last_status !== "update_available" ||
            !hasUpdate(service)
        ) {
            continue;
        }
        protectMutation();
        applyResults.push(await applyServiceUpdate(service, "auto", signal));
    }
    if (applyResults.some((step) => step.isOk)) {
        await pruneDanglingImagesBestEffort(signal);
    }
    const steps = [register, poll, ...applyResults];
    await syncDockerUpdaterChangesBestEffort(steps, signal, protectMutation);
    return steps;
}

export function registerDockerUpdaterScheduledJobs(): void {
    const job = {
        id: "docker.updater",
        name: "Docker updater",
        description: "Poll Docker registries and apply approved automatic updates.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "04:10",
        actionKey: "docker.updater",
        actionPayload: {},
        resourceClass: "exclusive",
    } as const;
    registerScheduledJobAction(
        "docker.updater",
        async (executionJob, signal, context) => {
            const rawServiceId = executionJob.actionPayload.serviceId;
            let serviceId: number | undefined = Number.NaN;
            if (rawServiceId === undefined) {
                serviceId = undefined;
            }
            if (
                typeof rawServiceId === "number" &&
                Number.isSafeInteger(rawServiceId) &&
                rawServiceId > 0
            ) {
                serviceId = rawServiceId;
            }
            if (Number.isNaN(serviceId)) {
                throw Object.assign(new Error("Invalid Docker updater service id"), {
                    statusCode: 400,
                });
            }
            const steps = await runDockerUpdaterService(
                serviceId,
                signal,
                context.protectFromCancellation
            );
            const failed = steps.filter(
                (step) =>
                    !step.isOk &&
                    !isNonblockingRegistrationFailure(step) &&
                    step.step !== "git-sync:docker"
            );
            if (failed.length > 0) {
                throw new ScheduledJobActionError(
                    failed.map((step) => `${step.step}: ${step.stderr}`).join("\n"),
                    { serviceId, steps }
                );
            }
            return { serviceId, steps };
        },
        { timeoutMs: 30 * 60 * 1000 }
    );
    database.run("BEGIN IMMEDIATE");
    try {
        removeScheduledJobsNotInAction("docker.updater", [job.id]);
        const existing = getScheduledJob(job.id);
        upsertScheduledJob({
            ...job,
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? job.scheduleType,
            intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
            timeOfDay: existing ? existing.timeOfDay : job.timeOfDay,
            cronExpression: existing ? existing.cronExpression : undefined,
        });
        database.run("COMMIT");
    } catch (error) {
        database.run("ROLLBACK");
        throw error;
    }
}
