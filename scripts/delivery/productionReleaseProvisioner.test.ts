import { describe, expect, test } from "bun:test";

import {
    parseProductionProvisioningAuthority,
    productionMaintenanceGroupIsTrusted,
} from "./productionReleaseProvisioner.ts";

describe("production release root provisioner", () => {
    test("parses only exact local and semantic release authorities", () => {
        const releaseId = "a".repeat(40);
        expect(parseProductionProvisioningAuthority(`${releaseId}--local`)).toEqual({
            releaseId,
            source: "local",
        });
        expect(parseProductionProvisioningAuthority(`${releaseId}--v1.2.3`)).toEqual({
            releaseId,
            source: "v1.2.3",
        });
        for (const authority of [
            `${releaseId}--v1.2.3/service`,
            `${releaseId}--../local`,
            `-${releaseId}--local`,
        ]) {
            expect(() => parseProductionProvisioningAuthority(authority)).toThrow(
                "Production release provisioning failed"
            );
        }
    });

    test("rejects privileged, aliased, and unexpected maintenance groups", () => {
        const trusted = "mira-dashboard-log-maintenance:x:986:ubuntu";
        expect(productionMaintenanceGroupIsTrusted(trusted, trusted)).toBe(true);
        expect(
            productionMaintenanceGroupIsTrusted(
                "mira-dashboard-log-maintenance:x:0:ubuntu",
                "mira-dashboard-log-maintenance:x:0:ubuntu"
            )
        ).toBe(false);
        expect(
            productionMaintenanceGroupIsTrusted(
                trusted,
                `${trusted}\nprivileged-alias:x:986:`
            )
        ).toBe(false);
        expect(
            productionMaintenanceGroupIsTrusted(
                "mira-dashboard-log-maintenance:x:986:root",
                "mira-dashboard-log-maintenance:x:986:root"
            )
        ).toBe(false);
    });
});
