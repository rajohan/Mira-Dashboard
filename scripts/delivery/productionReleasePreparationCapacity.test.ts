import { describe, expect, test } from "bun:test";

import {
    maximumProductionReleaseArchiveBytes,
    maximumProductionReleaseArtifactTreeBytes,
    maximumProductionReleaseReceiptBytes,
} from "../../src/shared/productionReleaseArtifactReceipt.ts";
import { productionReleasePreparationCapacityPolicy } from "./productionReleasePreparationCapacity.ts";

describe("production release preparation capacity", () => {
    test("admits receipt, archive, extraction, and root staging ceilings", () => {
        expect(productionReleasePreparationCapacityPolicy.temporaryPreparationBytes).toBe(
            BigInt(maximumProductionReleaseArchiveBytes) +
                BigInt(maximumProductionReleaseReceiptBytes)
        );
        expect(productionReleasePreparationCapacityPolicy.hostPreparationBytes).toBe(
            BigInt(maximumProductionReleaseArchiveBytes) +
                BigInt(maximumProductionReleaseArtifactTreeBytes)
        );
    });
});
