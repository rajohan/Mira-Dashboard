import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDevelopmentAuthoritySimulators } from "./developmentAuthoritySimulators.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots
            .splice(0)
            .map((temporaryRoot) => rm(temporaryRoot, { force: true, recursive: true }))
    );
});

async function developmentStateRoot(): Promise<string> {
    const stateRoot = await mkdtemp(
        path.join(tmpdir(), "mira-dashboard-source-authority-")
    );
    temporaryRoots.push(stateRoot);
    await writeFile(
        path.join(stateRoot, ".mira-dashboard-development-state.json"),
        JSON.stringify({
            formatVersion: 1,
            owner: "mira-dashboard-source-development-v1",
        }),
        { mode: 0o600 }
    );
    return stateRoot;
}

describe("source-development authority simulators", () => {
    test("simulates fixed privileged ports and journals only aggregate receipts", async () => {
        const stateRoot = await developmentStateRoot();
        const simulators = createDevelopmentAuthoritySimulators({
            nowMs: () => 1_800_000_000_000,
            stateRoot,
        });

        expect(await simulators.hostOperations.availableOperations()).toEqual([
            "dashboard-restart",
            "dashboard-stack-restart",
            "system-cleanup",
            "system-restart",
            "system-update",
            "worker-restart",
        ]);
        expect(await simulators.hostOperations.request("system-cleanup")).toEqual({
            status: "completed",
        });
        expect(await simulators.hostOperations.request("system-restart")).toEqual({
            status: "accepted",
        });
        expect(
            await simulators.hostOperations.request("dashboard-stack-restart")
        ).toEqual({ status: "accepted" });
        await simulators.openClawGateway.restart();
        expect(await simulators.openClawServiceActions.cleanupSessions()).toMatchObject({
            status: "completed",
            storesProcessed: 0,
        });
        expect(await simulators.openClawServiceActions.updateInstallation()).toEqual({
            status: "accepted",
        });

        const journal = await readFile(
            path.join(stateRoot, "development-authority-simulator", "receipts.ndjson"),
            "utf8"
        );
        const receipts = journal
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as unknown);
        expect(receipts).toEqual([
            {
                completedAtMs: 1_800_000_000_000,
                operation: "system-cleanup",
                outcome: "simulated",
            },
            {
                completedAtMs: 1_800_000_000_000,
                operation: "system-restart",
                outcome: "simulated",
            },
            {
                completedAtMs: 1_800_000_000_000,
                operation: "dashboard-stack-restart",
                outcome: "simulated",
            },
            {
                completedAtMs: 1_800_000_000_000,
                operation: "openclaw-restart",
                outcome: "simulated",
            },
            {
                completedAtMs: 1_800_000_000_000,
                operation: "openclaw-cleanup",
                outcome: "simulated",
            },
            {
                completedAtMs: 1_800_000_000_000,
                operation: "openclaw-update",
                outcome: "simulated",
            },
        ]);
    });

    test("fails closed outside an exact marked development state", async () => {
        const unmarkedRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-unmarked-authority-")
        );
        temporaryRoots.push(unmarkedRoot);

        expect(() =>
            createDevelopmentAuthoritySimulators({ stateRoot: unmarkedRoot })
        ).toThrow("Development simulator");
    });
});
