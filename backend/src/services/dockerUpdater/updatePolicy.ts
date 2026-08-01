import { database } from "../../database.ts";
import { registerDockerUpdaterServices } from "./composeDiscovery.ts";
import { syncDockerUpdaterChangesBestEffort } from "./gitSync.ts";
import { hasUpdate, imageRegistry } from "./registryClient.ts";
import { pollDockerUpdaterRegistries } from "./registryPolling.ts";
import { applyServiceUpdate, pruneDanglingImagesBestEffort } from "./serviceUpdate.ts";
import { serviceLabel } from "./support.ts";
import {
    type DockerUpdaterStepResult,
    type ManagedServiceRow,
    normalizeManagedServiceRow,
    normalizeManagedServiceRows,
} from "./types.ts";

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

function isAutomaticUpdateEligible(
    service: ManagedServiceRow,
    blockedAppSlugs: ReadonlySet<string>
): boolean {
    return (
        !blockedAppSlugs.has(service.app_slug) &&
        service.last_status === "update_available" &&
        hasUpdate(service)
    );
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
        const completionSignal = signal?.aborted ? undefined : signal;
        if (apply.isOk) {
            await pruneDanglingImagesBestEffort(completionSignal);
        }
        const steps = [register, poll, apply];
        await syncDockerUpdaterChangesBestEffort(
            steps,
            completionSignal,
            protectMutation
        );
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
        if (signal?.aborted) {
            if (isMutationProtected) break;
            signal.throwIfAborted();
        }
        if (!isAutomaticUpdateEligible(service, blockedAppSlugs)) {
            continue;
        }
        protectMutation();
        applyResults.push(await applyServiceUpdate(service, "auto", signal));
    }
    const completionSignal = isMutationProtected && signal?.aborted ? undefined : signal;
    if (applyResults.some((step) => step.isOk)) {
        await pruneDanglingImagesBestEffort(completionSignal);
    }
    const steps = [register, poll, ...applyResults];
    await syncDockerUpdaterChangesBestEffort(steps, completionSignal, protectMutation);
    return steps;
}
