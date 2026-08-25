import type { BigIntStats, BigIntStatsFs } from "node:fs";
import { lstat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    maximumProductionReleaseArchiveBytes,
    maximumProductionReleaseArtifactTreeBytes,
    maximumProductionReleaseReceiptBytes,
} from "../../src/shared/productionReleaseArtifactReceipt.ts";
import {
    maximumReleaseArtifactCount,
    maximumReleaseArtifactDirectoryCount,
} from "./releaseArtifactInventory.ts";

const failureMessage = "Production release preparation capacity admission failed";
const reserveBytes = 64n * 1024n * 1024n;
const reserveInodes = 64n;
const temporaryPreparationBytes =
    BigInt(maximumProductionReleaseArchiveBytes) +
    BigInt(maximumProductionReleaseReceiptBytes);
const hostPreparationBytes =
    BigInt(maximumProductionReleaseArchiveBytes) +
    BigInt(maximumProductionReleaseArtifactTreeBytes);

/** Test-visible exact byte ceilings used by filesystem admission. */
export const productionReleasePreparationCapacityPolicy = Object.freeze({
    hostPreparationBytes,
    temporaryPreparationBytes,
});

export interface ProductionReleasePreparationCapacityDependencies {
    readonly lstat?: (target: string) => Promise<BigIntStats>;
    readonly statfs?: (target: string) => Promise<BigIntStatsFs>;
}

/**
 * Admits all download and extraction staging before any release bytes are written.
 * @param checkoutRoot Canonical checkout filesystem used for unprivileged extraction.
 * @param hostProvisioningRoot Canonical root used for privileged release staging.
 * @param dependencies Optional fixed filesystem inspection seams.
 */
export async function admitProductionReleasePreparation(
    checkoutRoot: string,
    hostProvisioningRoot?: string,
    dependencies: ProductionReleasePreparationCapacityDependencies = {}
): Promise<void> {
    try {
        const inspect =
            dependencies.lstat ?? ((target) => lstat(target, { bigint: true }));
        const measure =
            dependencies.statfs ?? ((target) => statfs(target, { bigint: true }));
        let hostProvisioningDirectory: string | undefined;
        if (hostProvisioningRoot !== undefined) {
            try {
                const status = await inspect(hostProvisioningRoot);
                if (!status.isDirectory() || status.isSymbolicLink()) {
                    throw new Error(failureMessage);
                }
                hostProvisioningDirectory = hostProvisioningRoot;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                hostProvisioningDirectory = path.dirname(hostProvisioningRoot);
            }
        }
        const demands = [
            {
                bytes: temporaryPreparationBytes,
                directory: tmpdir(),
                inodes: 3n,
            },
            {
                bytes: BigInt(maximumProductionReleaseArtifactTreeBytes),
                directory: checkoutRoot,
                inodes:
                    BigInt(maximumReleaseArtifactCount) +
                    BigInt(maximumReleaseArtifactDirectoryCount) +
                    1n,
            },
            ...(hostProvisioningDirectory === undefined
                ? []
                : [
                      {
                          bytes: hostPreparationBytes,
                          directory: hostProvisioningDirectory,
                          inodes:
                              BigInt(maximumReleaseArtifactCount) +
                              BigInt(maximumReleaseArtifactDirectoryCount) +
                              8n,
                      },
                  ]),
        ] as const;
        const capacities = new Map<
            bigint,
            {
                availableBytes: bigint;
                availableInodes: bigint;
                blockSize: bigint;
                requiredBytes: bigint;
                requiredInodes: bigint;
            }
        >();
        for (const demand of demands) {
            const [status, capacity] = await Promise.all([
                inspect(demand.directory),
                measure(demand.directory),
            ]);
            if (
                !status.isDirectory() ||
                status.isSymbolicLink() ||
                capacity.bsize <= 0n ||
                capacity.bavail < 0n ||
                capacity.ffree < 0n
            ) {
                throw new Error(failureMessage);
            }
            const current = capacities.get(status.dev);
            if (current !== undefined && current.blockSize !== capacity.bsize) {
                throw new Error(failureMessage);
            }
            const measuredAvailableBytes = capacity.bsize * capacity.bavail;
            capacities.set(status.dev, {
                availableBytes:
                    current !== undefined &&
                    current.availableBytes < measuredAvailableBytes
                        ? current.availableBytes
                        : measuredAvailableBytes,
                availableInodes:
                    current === undefined || current.availableInodes > capacity.ffree
                        ? capacity.ffree
                        : current.availableInodes,
                blockSize: capacity.bsize,
                requiredBytes: (current?.requiredBytes ?? 0n) + demand.bytes,
                requiredInodes: (current?.requiredInodes ?? 0n) + demand.inodes,
            });
        }
        for (const capacity of capacities.values()) {
            if (
                capacity.availableBytes <
                    capacity.requiredBytes +
                        capacity.requiredInodes * capacity.blockSize +
                        reserveBytes ||
                capacity.availableInodes < capacity.requiredInodes + reserveInodes
            ) {
                throw new Error(failureMessage);
            }
        }
    } catch {
        throw new Error(failureMessage);
    }
}
