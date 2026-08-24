import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    logMaintenanceAvailabilityFutureToleranceMs,
    logMaintenanceAvailabilityMaximumAgeMs,
    logMaintenanceAvailabilityProjectionFileName,
    logMaintenanceAvailabilityProjectionMaximumBytes,
} from "../../../shared/logMaintenanceAvailabilityProjection.ts";
import { captureFailure } from "../../test/support/promise.ts";
import { createLogMaintenanceAvailabilityProbe } from "./logMaintenanceAvailability.ts";

const nowMs = 1_800_000_000_000;
const expectedUserId = process.getuid?.() ?? 0;
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-log-availability-"));
    temporaryRoots.push(root);
    return root;
}

async function writeProjection(root: string, projection?: unknown): Promise<string> {
    const value = projection ?? {
        observedAtMs: nowMs,
        policies: ["docker-managed", "host-rsyslog"],
        version: 1,
    };
    const filePath = path.join(root, logMaintenanceAvailabilityProjectionFileName);
    await writeFile(filePath, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    await chmod(filePath, 0o600);
    return filePath;
}

function createProbe(root: string, clock = nowMs) {
    return createLogMaintenanceAvailabilityProbe({
        expectedUserId,
        logMaintenanceRoot: root,
        nowMs: () => clock,
    });
}

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map(async (root) => {
            await chmod(root, 0o700).catch(() => {});
            await rm(root, { force: true, recursive: true });
        })
    );
});

describe("worker-owned log-maintenance availability reader", () => {
    test("reads only the fresh canonical fixed-policy projection", async () => {
        const root = await temporaryRoot();
        await writeProjection(root);

        expect(await createProbe(root).availablePolicies()).toEqual([
            "docker-managed",
            "host-rsyslog",
        ]);
    });

    test("fails closed when the projection is missing, stale, or too far in the future", async () => {
        const missingRoot = await temporaryRoot();
        expect(await createProbe(missingRoot).availablePolicies()).toEqual([]);

        const staleRoot = await temporaryRoot();
        await writeProjection(staleRoot, {
            observedAtMs: nowMs - logMaintenanceAvailabilityMaximumAgeMs - 1,
            policies: ["docker-managed"],
            version: 1,
        });
        expect(await createProbe(staleRoot).availablePolicies()).toEqual([]);

        const futureRoot = await temporaryRoot();
        await writeProjection(futureRoot, {
            observedAtMs: nowMs + logMaintenanceAvailabilityFutureToleranceMs + 1,
            policies: ["docker-managed"],
            version: 1,
        });
        expect(await createProbe(futureRoot).availablePolicies()).toEqual([]);
    });

    test("rejects noncanonical, duplicate, and provider-shaped projection data", async () => {
        for (const projection of [
            {
                observedAtMs: nowMs,
                policies: ["host-rsyslog", "docker-managed"],
                version: 1,
            },
            {
                observedAtMs: nowMs,
                policies: ["docker-managed", "docker-managed"],
                version: 1,
            },
            {
                observedAtMs: nowMs,
                policies: ["docker-managed"],
                secret: "must-not-cross",
                version: 1,
            },
        ]) {
            const root = await temporaryRoot();
            await writeProjection(root, projection);
            expect(await createProbe(root).availablePolicies()).toEqual([]);
        }
    });

    test("rejects symlinked roots and symlinked or hard-linked projections", async () => {
        const realRoot = await temporaryRoot();
        await writeProjection(realRoot);
        const parent = await temporaryRoot();
        const linkedRoot = path.join(parent, "linked-root");
        await symlink(realRoot, linkedRoot);
        expect(await createProbe(linkedRoot).availablePolicies()).toEqual([]);

        const symlinkRoot = await temporaryRoot();
        const target = path.join(symlinkRoot, "projection-target.json");
        await writeFile(
            target,
            `${JSON.stringify({ observedAtMs: nowMs, policies: [], version: 1 })}\n`,
            { mode: 0o600 }
        );
        await symlink(
            target,
            path.join(symlinkRoot, logMaintenanceAvailabilityProjectionFileName)
        );
        expect(await createProbe(symlinkRoot).availablePolicies()).toEqual([]);

        const hardLinkRoot = await temporaryRoot();
        const projectionPath = await writeProjection(hardLinkRoot);
        await link(projectionPath, path.join(hardLinkRoot, "projection-hard-link.json"));
        expect(await createProbe(hardLinkRoot).availablePolicies()).toEqual([]);
    });

    test("rejects unsafe root/file mode, owner identity, and file size", async () => {
        const rootMode = await temporaryRoot();
        await writeProjection(rootMode);
        await chmod(rootMode, 0o750);
        expect(await createProbe(rootMode).availablePolicies()).toEqual([]);

        const fileMode = await temporaryRoot();
        const filePath = await writeProjection(fileMode);
        await chmod(filePath, 0o640);
        expect(await createProbe(fileMode).availablePolicies()).toEqual([]);

        const ownerRoot = await temporaryRoot();
        await writeProjection(ownerRoot);
        const mismatchedOwner = createLogMaintenanceAvailabilityProbe({
            expectedUserId: expectedUserId + 1,
            logMaintenanceRoot: ownerRoot,
            nowMs: () => nowMs,
        });
        expect(await mismatchedOwner.availablePolicies()).toEqual([]);

        const oversizedRoot = await temporaryRoot();
        await writeFile(
            path.join(oversizedRoot, logMaintenanceAvailabilityProjectionFileName),
            Buffer.alloc(logMaintenanceAvailabilityProjectionMaximumBytes + 1, 0x20),
            { mode: 0o600 }
        );
        expect(await createProbe(oversizedRoot).availablePolicies()).toEqual([]);
    });

    test("contains invalid clocks and caller cancellation without exposing reasons", async () => {
        const root = await temporaryRoot();
        await writeProjection(root);
        expect(
            await createLogMaintenanceAvailabilityProbe({
                expectedUserId,
                logMaintenanceRoot: root,
                nowMs: () => Number.NaN,
            }).availablePolicies()
        ).toEqual([]);

        const failure = await captureFailure(() =>
            createProbe(root).availablePolicies(AbortSignal.abort("private reason"))
        );
        expect(failure).toEqual(new Error("Log maintenance availability is unavailable"));
        expect(JSON.stringify(failure)).not.toContain("private reason");
    });

    test("rejects invalid configured roots before filesystem access", () => {
        expect(() =>
            createLogMaintenanceAvailabilityProbe({
                logMaintenanceRoot: "relative",
            })
        ).toThrow("Log maintenance availability is unavailable");
    });
});
