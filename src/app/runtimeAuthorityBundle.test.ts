import { describe, expect, test } from "bun:test";

import {
    assertSourceDevelopmentAuthorityParity,
    productionAuthorityBundle,
    productionCapabilityIds,
    sourceDevelopmentAuthorityBundle,
} from "../server/platform/runtime/runtimeAuthorityBundle.ts";

describe("production/source-development authority bundle", () => {
    test("keeps structural API inventories exact and classifies every production capability", () => {
        expect(assertSourceDevelopmentAuthorityParity).not.toThrow();
        expect(sourceDevelopmentAuthorityBundle.inventory.routes).toEqual(
            productionAuthorityBundle.inventory.routes
        );
        expect(sourceDevelopmentAuthorityBundle.inventory.procedures).toEqual(
            productionAuthorityBundle.inventory.procedures
        );
        expect(sourceDevelopmentAuthorityBundle.inventory.cacheProviders).toEqual(
            productionAuthorityBundle.inventory.cacheProviders
        );
        expect(sourceDevelopmentAuthorityBundle.inventory.serviceActions).toEqual(
            productionAuthorityBundle.inventory.serviceActions
        );
        expect(
            Object.keys(sourceDevelopmentAuthorityBundle.capabilities).toSorted()
        ).toEqual([...productionCapabilityIds].toSorted());
    });

    test("keeps the complete production Job and schedule inventory in source development", () => {
        const executable = new Set(sourceDevelopmentAuthorityBundle.inventory.actions);
        expect(
            sourceDevelopmentAuthorityBundle.inventory.scheduledActions.every(
                (actionKey) => executable.has(actionKey)
            )
        ).toBeTrue();
        expect(sourceDevelopmentAuthorityBundle.inventory.actions).toEqual(
            productionAuthorityBundle.inventory.actions
        );
        expect(sourceDevelopmentAuthorityBundle.inventory.scheduledActions).toEqual(
            productionAuthorityBundle.inventory.scheduledActions
        );
    });

    test("makes the P0 authority substitutions explicit", () => {
        expect(sourceDevelopmentAuthorityBundle.capabilities).toMatchObject({
            "backup-operations": "simulated",
            "database-observability": "simulated",
            "delivery-operations": "simulated",
            "docker-operations": "simulated",
            "gateway-mutations": "simulated",
            "gateway-reads": "live-read",
            "service-actions": "simulated",
            terminal: "isolated",
        });
    });
});
