import { describe, expect, it } from "bun:test";

import { isDatabaseSchemaCompatible } from "../src/databaseSchemaCompatibility.ts";
import { evaluateReadiness, type ReadinessSignals } from "../src/health.ts";

function readySignals(): ReadinessSignals {
    return {
        database: {
            currentSchemaVersion: 6,
            maximumCompatibleSchemaVersion: 6,
            minimumCompatibleSchemaVersion: 6,
            ready: true,
            targetSchemaVersion: 6,
        },
        frontendReady: true,
        gatewayConnected: true,
        release: {
            artifactCount: 8,
            backendCommit: "aaaaaaaa",
            commitSha: "a".repeat(40),
            frontendCommit: "aaaaaaaa",
            manifestFormatVersion: 2,
            ready: true,
            source: "manifest",
        },
        sessionCount: 4,
        workerReady: true,
    };
}

describe("Dashboard readiness contract", () => {
    it("requires release, database, frontend, and worker readiness", () => {
        const ready = evaluateReadiness(readySignals());
        expect(ready).toMatchObject({
            checks: {
                database: { ready: true },
                frontend: { ready: true },
                release: { ready: true },
                worker: { ready: true },
            },
            status: "isReady",
        });
        expect(ready.checks.release).toEqual({
            manifestFormatVersion: 2,
            ready: true,
            source: "manifest",
        });
        expect("commitSha" in ready.checks.release).toBe(false);
        expect("backendCommit" in ready.checks.release).toBe(false);
        expect("frontendCommit" in ready.checks.release).toBe(false);
        expect("schema" in ready.checks.release).toBe(false);

        const baseline = readySignals();
        const blockedSignals: ReadinessSignals[] = [
            {
                ...baseline,
                database: { ...baseline.database, ready: false },
            },
            { ...baseline, frontendReady: false },
            {
                ...baseline,
                release: { ...baseline.release, ready: false },
            },
            { ...baseline, workerReady: false },
        ];
        for (const signals of blockedSignals) {
            expect(evaluateReadiness(signals).status).toBe("notReady");
        }
    });

    it("reports Gateway availability without using it as a rollback signal", () => {
        const signals = readySignals();
        signals.gatewayConnected = false;

        expect(evaluateReadiness(signals)).toMatchObject({
            dependencies: {
                gatewayConnected: false,
            },
            status: "isReady",
        });
    });

    it("accepts only database schemas inside the release runtime window", () => {
        expect(isDatabaseSchemaCompatible(7, { maximum: 7, minimum: 6 })).toBe(true);
        expect(isDatabaseSchemaCompatible(5, { maximum: 7, minimum: 6 })).toBe(false);
        expect(isDatabaseSchemaCompatible(8, { maximum: 7, minimum: 6 })).toBe(false);
    });
});
