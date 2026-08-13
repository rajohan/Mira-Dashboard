import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDevelopmentRuntimeAuthority } from "../../../worker/developmentRuntimeAuthority.ts";
import {
    createJobWorkerActionResolver,
    type JobWorkerActionResolverDependencies,
} from "./actionExecutors.ts";
import {
    assertSourceDevelopmentActionComposition,
    sourceDevelopmentExecutableJobActionDefinitions,
} from "./sourceDevelopmentActionComposition.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
    );
});

async function resolverDependencies(): Promise<JobWorkerActionResolverDependencies> {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "source-actions-"));
    temporaryRoots.push(stateRoot);
    await writeFile(
        path.join(stateRoot, ".mira-dashboard-development-state.json"),
        JSON.stringify({
            formatVersion: 1,
            owner: "mira-dashboard-source-development-v1",
        }),
        { mode: 0o600 }
    );
    const authority = createDevelopmentRuntimeAuthority({
        nowMs: () => 1_800_000_000_000,
        stateRoot,
    });
    return {
        actionDefinitions: sourceDevelopmentExecutableJobActionDefinitions,
        backups: {
            activityRepository: {
                isAttentionRun: () => false,
                read: () => ({ state: "idle" }),
            },
            executionPort: authority.backups,
        },
        databaseObservability: {
            collect: () => Promise.reject(new Error("not executed by composition test")),
        },
        delivery: authority.createDelivery({
            readActionActive: () => Promise.resolve(false),
            readActivePreviewOperation: () => Promise.resolve(void 0),
            readPrevious: () => void 0,
        }),
        docker: Object.freeze({
            ...authority.docker,
            readPrevious: () => void 0,
        }),
        hostOperations: {
            availableOperations: () =>
                Promise.resolve([
                    "system-cleanup" as const,
                    "system-restart" as const,
                    "system-update" as const,
                ]),
            request: () => Promise.reject(new Error("not executed by composition test")),
        },
        logMaintenance: {
            run: () => Promise.reject(new Error("not executed by composition test")),
        },
        moltbook: {
            collect: () => Promise.reject(new Error("not executed by composition test")),
        },
        openClawGateway: {
            restart: () => Promise.reject(new Error("not executed by composition test")),
        },
        openClawServiceActions: {
            cleanupSessions: () =>
                Promise.reject(new Error("not executed by composition test")),
            updateInstallation: () =>
                Promise.reject(new Error("not executed by composition test")),
        },
        overviewProviders: authority.overviewProviders,
        sqliteMaintenance: {
            run: () => Promise.reject(new Error("not executed by composition test")),
        },
        workspaceFiles: {
            apply: () => Promise.reject(new Error("not executed by composition test")),
            removeSettledReplacementIntent: () => Promise.resolve(),
        },
    };
}

describe("source-development Job action composition", () => {
    test("resolves one real worker executor for every advertised definition", async () => {
        expect(assertSourceDevelopmentActionComposition).not.toThrow();
        const resolver = createJobWorkerActionResolver(await resolverDependencies());

        for (const definition of sourceDevelopmentExecutableJobActionDefinitions) {
            expect(resolver(definition.actionKey)?.actionKey).toBe(definition.actionKey);
        }
    });

    test("fails closed if an advertised authority has no executor port", async () => {
        const { hostOperations: _hostOperations, ...incomplete } =
            await resolverDependencies();

        expect(() => createJobWorkerActionResolver(incomplete)).toThrow(
            "executor keys do not exactly match action definitions"
        );
    });
});
