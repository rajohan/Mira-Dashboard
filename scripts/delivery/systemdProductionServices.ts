import { secondsToMilliseconds } from "date-fns";
import * as v from "valibot";

import { healthReadinessPath } from "../../src/contracts/system.ts";
import type { PublishedReleaseAuthority } from "../../src/shared/publishedReleaseAuthority.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import { runProductionDeliveryTargetSmoke } from "./productionDeliverySmoke.ts";
import type { ProductionServiceController } from "./productionReleaseActivation.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import type { InstalledProductionRuntime } from "./productionRuntime.ts";
import { pointProductionProcessesAtRelease } from "./productionRuntimePointers.ts";
import {
    executeSystemctlProcess,
    requireSuccessfulSystemctlProcess,
    type SystemctlExecutor,
} from "./systemctlProcess.ts";
import { verifyPublishedProductionSystemdUnitsInstalledAtRoot } from "./verifyProductionSystemdUnits.ts";

const systemdServiceFailureMessage = "Production service control failed";
const readinessAttemptTimeoutMs = secondsToMilliseconds(2);
const readinessDeadlineMs = secondsToMilliseconds(30);
const readinessRetryMs = 250;
const webUnit = "mira-dashboard-web.service";
const workerUnit = "mira-dashboard-worker.service";
const provisioningUnitPrefix = "mira-dashboard-production-provisioning@";
const provisioningDeadlineMs = secondsToMilliseconds(15 * 60 + 30);
const maximumSystemdUnitNameBytes = 255;
const systemctlExecutableDefault = "/usr/bin/systemctl";
const loopbackReadinessUrlSchema = v.pipe(
    v.string(),
    v.url(),
    v.check((input) => {
        try {
            const url = new URL(input);
            return (
                url.protocol === "http:" &&
                url.hostname === "127.0.0.1" &&
                url.pathname === healthReadinessPath &&
                url.search.length === 0 &&
                url.hash.length === 0 &&
                url.username.length === 0 &&
                url.password.length === 0
            );
        } catch {
            return false;
        }
    }, systemdServiceFailureMessage)
);

export type { SystemctlProcessResult } from "./systemctlProcess.ts";

/** Explicit systemd and readiness boundaries for one project-local deployment. */
export interface SystemdProductionServiceOptions {
    readonly allowEmptyOperatorSmoke?: boolean;
    readonly execute?: SystemctlExecutor;
    readonly fetch?: (request: Request) => Promise<Response>;
    readonly verifyUnits?: typeof verifyPublishedProductionSystemdUnitsInstalledAtRoot;
    readonly readinessUrl: string;
    readonly releaseAuthority?: PublishedReleaseAuthority;
    readonly smoke?: typeof runProductionDeliveryTargetSmoke;
    readonly systemctlExecutable?: string;
}

function serviceFailure(): Error {
    return new Error(systemdServiceFailureMessage);
}

function validateExecutable(executable: string): void {
    if (
        !executable.startsWith("/") ||
        executable.includes("\0") ||
        executable.length > 4096
    ) {
        throw serviceFailure();
    }
}

async function requireSystemctlSuccess(
    execute: SystemctlExecutor,
    executable: string,
    arguments_: readonly string[],
    deadlineMs?: number
): Promise<void> {
    try {
        const options =
            deadlineMs === undefined ? Object.freeze({}) : Object.freeze({ deadlineMs });
        await requireSuccessfulSystemctlProcess(execute, executable, arguments_, options);
    } catch {
        throw serviceFailure();
    }
}

async function stopUnits(
    execute: NonNullable<SystemdProductionServiceOptions["execute"]>,
    executable: string
): Promise<void> {
    let failed = false;
    try {
        await requireSystemctlSuccess(execute, executable, ["stop", webUnit]);
    } catch {
        failed = true;
    }
    try {
        await requireSystemctlSuccess(execute, executable, ["stop", workerUnit]);
    } catch {
        failed = true;
    }
    if (failed) throw serviceFailure();
}

async function probeReadiness(
    fetch_: NonNullable<SystemdProductionServiceOptions["fetch"]>,
    readinessUrl: string
): Promise<boolean> {
    try {
        const response = await fetch_(
            new Request(readinessUrl, {
                cache: "no-store",
                method: "HEAD",
                signal: AbortSignal.timeout(readinessAttemptTimeoutMs),
            })
        );
        return response.status === 200;
    } catch {
        return false;
    }
}

async function awaitReadiness(
    fetch_: NonNullable<SystemdProductionServiceOptions["fetch"]>,
    readinessUrl: string
): Promise<void> {
    const deadline = Date.now() + readinessDeadlineMs;
    while (Date.now() < deadline) {
        if (await probeReadiness(fetch_, readinessUrl)) return;
        await Bun.sleep(readinessRetryMs);
    }
    throw serviceFailure();
}

async function requireUnitsActive(
    execute: NonNullable<SystemdProductionServiceOptions["execute"]>,
    executable: string
): Promise<void> {
    for (const unit of [workerUnit, webUnit]) {
        await requireSystemctlSuccess(execute, executable, [
            "is-active",
            "--quiet",
            unit,
        ]);
    }
}

/**
 * Creates the idempotent root-systemd adapter used by crash-safe activation.
 * Release/runtime pointers are changed only while the activation orchestrator has stopped writers.
 * @param lease Active deployment lease captured by the controller.
 * @param paths Exact project-local production paths.
 * @param options Loopback readiness URL plus injectable process boundaries.
 * @returns Service controller for worker-first start, web-first stop, and readiness proof.
 */
export function createSystemdProductionServiceController(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    options: SystemdProductionServiceOptions
): ProductionServiceController {
    const readinessUrl = v.parse(loopbackReadinessUrlSchema, options.readinessUrl);
    const executable = options.systemctlExecutable ?? systemctlExecutableDefault;
    validateExecutable(executable);
    const execute = options.execute ?? executeSystemctlProcess;
    const fetch_ = options.fetch ?? fetch;
    const verifyUnits =
        options.verifyUnits ?? verifyPublishedProductionSystemdUnitsInstalledAtRoot;
    const smoke = options.smoke ?? runProductionDeliveryTargetSmoke;

    return Object.freeze({
        async provision(release: PublishedProductionRelease): Promise<void> {
            const releaseId = release.manifest.source.commitSha;
            const authority = options.releaseAuthority;
            const receiptDigest = authority?.assets.find(
                ({ name }) => name === "receipt.json"
            )?.digest;
            const archiveDigest = authority?.assets.find(
                ({ name }) => name === "release.tar"
            )?.digest;
            const instance =
                authority?.releaseId === releaseId &&
                receiptDigest !== undefined &&
                archiveDigest !== undefined
                    ? `${releaseId}--${authority.tagName}--${receiptDigest.slice("sha256:".length)}--${archiveDigest.slice("sha256:".length)}`
                    : `${releaseId}--local`;
            if (
                !/^[a-f\d]{40}--(?:local|v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?--[a-f\d]{64}--[a-f\d]{64})$/u.test(
                    instance
                )
            ) {
                throw serviceFailure();
            }
            const unit = `${provisioningUnitPrefix}${instance}.service`;
            if (Buffer.byteLength(unit) > maximumSystemdUnitNameBytes) {
                throw serviceFailure();
            }
            await requireSystemctlSuccess(
                execute,
                executable,
                ["start", unit],
                provisioningDeadlineMs
            );
        },
        async settle(release: PublishedProductionRelease): Promise<void> {
            const releaseId = release.manifest.source.commitSha;
            await requireSystemctlSuccess(
                execute,
                executable,
                [
                    "start",
                    `${provisioningUnitPrefix}${releaseId}--local--settled.service`,
                ],
                provisioningDeadlineMs
            );
        },
        prepare(release: PublishedProductionRelease): Promise<void> {
            return verifyUnits(lease, paths, release);
        },
        async start(
            release: PublishedProductionRelease,
            runtime: InstalledProductionRuntime
        ): Promise<void> {
            await pointProductionProcessesAtRelease(lease, paths, release, runtime);
            await requireSystemctlSuccess(execute, executable, ["restart", workerUnit]);
            await requireSystemctlSuccess(execute, executable, ["restart", webUnit]);
        },
        stop: () => stopUnits(execute, executable),
        async verifyReady(): Promise<void> {
            await requireUnitsActive(execute, executable);
            await awaitReadiness(fetch_, readinessUrl);
            await requireUnitsActive(execute, executable);
        },
        async verifySmoke(
            release: PublishedProductionRelease,
            runtime: InstalledProductionRuntime,
            transitionId: string
        ): Promise<void> {
            await smoke(paths, release, runtime, readinessUrl, transitionId, {
                allowEmptyOperator: options.allowEmptyOperatorSmoke,
            });
            await requireUnitsActive(execute, executable);
        },
    });
}
