import { lstat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";

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

/**
 * Admits all download and extraction staging before any release bytes are written.
 * @param checkoutRoot Canonical checkout filesystem used for unprivileged extraction.
 * @param hostProvisioningDirectory Existing ancestor for clean-host root staging.
 */
export async function admitProductionReleasePreparation(
    checkoutRoot: string,
    hostProvisioningDirectory?: string
): Promise<void> {
    try {
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
                lstat(demand.directory, { bigint: true }),
                statfs(demand.directory, { bigint: true }),
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
