import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { logRotationEpochProjectionFileName } from "../../../shared/logRotationEpochProjection.ts";
import { createLogRotationEpochProbe } from "./logRotationEpochProbe.ts";

const roots: string[] = [];
const epoch = "019feb02-8b7d-7062-94c6-2708cc994799";
const otherEpoch = "019feb02-8b7e-72ab-8f76-19b2ce15c8ef";

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "mira-log-epochs-"));
    roots.push(root);
    await chmod(root, 0o700);
    const projectionPath = path.join(root, logRotationEpochProjectionFileName);
    return {
        projectionPath,
        probe: createLogRotationEpochProbe({ logMaintenanceRoot: root }),
        root,
    };
}

async function writeProjection(
    projectionPath: string,
    entries: readonly {
        readonly epoch: string;
        readonly sourceId: string;
        readonly state: "committed" | "rotating";
    }[] = [
        {
            epoch,
            sourceId: "dashboard.web.stdout",
            state: "committed",
        },
    ]
): Promise<void> {
    await writeFile(
        projectionPath,
        `${JSON.stringify({
            entries,
            version: 1,
        })}\n`,
        { mode: 0o600 }
    );
}

async function expectUnavailable(operation: Promise<unknown>): Promise<void> {
    try {
        await operation;
    } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Log rotation epoch is unavailable");
        return;
    }
    throw new Error("Expected epoch probe to reject");
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("worker-owned log rotation epoch probe", () => {
    test("returns an exact durable epoch and treats a missing projection as not-yet-rotated", async () => {
        const { probe, projectionPath } = await fixture();
        expect(await probe.epoch("dashboard.web.stdout")).toBeUndefined();
        await writeProjection(projectionPath);
        const old = new Date("2020-01-01T00:00:00.000Z");
        await utimes(projectionPath, old, old);

        expect(await probe.epoch("dashboard.web.stdout")).toBe(epoch);
        expect(await probe.epoch("dashboard.worker.stdout")).toBeUndefined();
    });

    test("fails closed only for the source whose copytruncate is rotating", async () => {
        const { probe, projectionPath } = await fixture();
        await writeProjection(projectionPath, [
            {
                epoch,
                sourceId: "dashboard.web.stdout",
                state: "rotating",
            },
            {
                epoch: otherEpoch,
                sourceId: "dashboard.worker.stdout",
                state: "committed",
            },
        ]);

        expect(probe.epoch("dashboard.web.stdout")).rejects.toThrow(
            "Log rotation epoch is unavailable"
        );
        expect(await probe.epoch("dashboard.worker.stdout")).toBe(otherEpoch);
        expect(await probe.epoch("dashboard.worker.stderr")).toBeUndefined();
    });

    test("fails closed for corrupt, unsafe, symlinked, and hardlinked projections", async () => {
        const { probe, projectionPath, root } = await fixture();
        await writeFile(projectionPath, "not-json\n", { mode: 0o600 });
        expect(probe.epoch("dashboard.web.stdout")).rejects.toThrow(
            "Log rotation epoch is unavailable"
        );

        await writeProjection(projectionPath);
        await chmod(projectionPath, 0o644);
        expect(probe.epoch("dashboard.web.stdout")).rejects.toThrow(
            "Log rotation epoch is unavailable"
        );

        await rm(projectionPath);
        const outside = path.join(root, "outside");
        await writeFile(outside, "{}\n", { mode: 0o600 });
        await symlink(outside, projectionPath);
        expect(probe.epoch("dashboard.web.stdout")).rejects.toThrow(
            "Log rotation epoch is unavailable"
        );

        await rm(projectionPath);
        await link(outside, projectionPath);
        expect(probe.epoch("dashboard.web.stdout")).rejects.toThrow(
            "Log rotation epoch is unavailable"
        );

        await rm(projectionPath);
        await chmod(root, 0o755);
        expect(probe.epoch("dashboard.web.stdout")).rejects.toThrow(
            "Log rotation epoch is unavailable"
        );
    });

    test("rejects noncanonical and over-budget source inventories", async () => {
        const { probe, projectionPath } = await fixture();
        const entries = Array.from({ length: 65 }, (_, index) => ({
            epoch,
            sourceId: `dashboard.source-${String(index).padStart(2, "0")}`,
            state: "committed" as const,
        }));
        await writeFile(projectionPath, `${JSON.stringify({ entries, version: 1 })}\n`, {
            mode: 0o600,
        });

        await expectUnavailable(probe.epoch("dashboard.web.stdout"));

        await writeProjection(projectionPath, [
            {
                epoch,
                sourceId: "dashboard.web.stdout",
                state: "committed",
            },
            {
                epoch: otherEpoch,
                sourceId: "dashboard.a.stdout",
                state: "committed",
            },
        ]);
        await expectUnavailable(probe.epoch("dashboard.web.stdout"));
    });
});
