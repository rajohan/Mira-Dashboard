import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDevelopmentRuntimeAuthority } from "./developmentRuntimeAuthority.ts";
import { FixedDockerOperationsError } from "./docker/fixedDockerOperations.ts";

const now = 1_800_000_000_000;
const sourceRevision = "d".repeat(64);
const containerId = "a".repeat(64);
const firstPullRequestHead = "a".repeat(40);
const secondPullRequestHead = "b".repeat(40);
const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
    );
});

async function developmentStateRoot(): Promise<string> {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "development-runtime-"));
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

const deliveryAuthority = Object.freeze({
    readActionActive: () => Promise.resolve(false),
    readActivePreviewOperation: () => Promise.resolve(void 0),
    readPrevious: () => void 0,
});

describe("source-development runtime authority", () => {
    test("projects representative contract-valid production data without provider authority", async () => {
        const authority = createDevelopmentRuntimeAuthority({
            nowMs: () => now,
            stateRoot: await developmentStateRoot(),
        });
        const delivery = authority.createDelivery(deliveryAuthority);

        const [database, docker, backups, git, quota, weather, deliverySections] =
            await Promise.all([
                authority.databaseObservability.collect(),
                authority.docker.refresh(),
                authority.backups.refresh(),
                authority.overviewProviders.git(),
                authority.overviewProviders.quota(),
                authority.overviewProviders.weather(),
                delivery.refresh({}),
            ]);

        expect(database.databases.map(({ name }) => name)).toEqual(["mira", "postgres"]);
        expect(database.summary.maintenance.status).toBe("healthy");
        expect(docker.containers).toHaveLength(1);
        expect(docker.updaterServices[0]?.status.state).toBe("update-available");
        expect(backups.kopia.kind).toBe("succeeded");
        expect(backups.walg.kind).toBe("succeeded");
        expect(git.repositories).toHaveLength(3);
        expect(quota.providers.map(({ status }) => status)).toEqual([
            "available",
            "available",
            "available",
            "available",
        ]);
        expect(quota.providers[3]?.windows).toHaveLength(2);
        expect(weather.location).toBe("Spydeberg");
        expect(deliverySections.map(({ section }) => section)).toEqual([
            "pull-requests",
            "preview",
            "checkout",
            "releases",
        ]);
        const pullRequestsSection = deliverySections.find(
            ({ section }) => section === "pull-requests"
        );
        if (
            pullRequestsSection === undefined ||
            pullRequestsSection.section !== "pull-requests" ||
            pullRequestsSection.state !== "succeeded"
        ) {
            throw new TypeError("Development pull request projection is missing");
        }
        const nativeGroup = pullRequestsSection.payload.groups.find(
            ({ kind }) => kind === "native-stack"
        );
        const ordinaryGroup = pullRequestsSection.payload.groups.find(
            ({ kind }) => kind === "standalone-mira"
        );
        if (nativeGroup === undefined || ordinaryGroup === undefined) {
            throw new TypeError("Development pull request groups are missing");
        }
        for (const member of nativeGroup.members) {
            for (const actionId of ["merge", "merge-and-deploy"] as const) {
                expect(
                    member.actions.find(({ action }) => action === actionId)
                ).toMatchObject({
                    available: false,
                    reason: "head-guard-unavailable",
                });
            }
        }
        for (const member of [...nativeGroup.members, ...ordinaryGroup.members]) {
            expect(
                member.actions.find(({ action }) => action === "reject")
            ).toMatchObject({
                available: false,
                reason: "head-guard-unavailable",
            });
        }
        const ordinary = ordinaryGroup.members[0];
        if (ordinary === undefined) {
            throw new TypeError("Development ordinary pull request is missing");
        }
        for (const actionId of [
            "approve-review",
            "merge",
            "merge-and-deploy",
            "preview-start",
            "update-branch",
        ] as const) {
            expect(
                ordinary.actions.find(({ action }) => action === actionId)
            ).toMatchObject({
                available: true,
            });
        }

        const [logs, imagePrune, volumePrune] = await Promise.all([
            authority.dockerOperations.readContainerLogs({
                containerId,
                sourceRevision,
                tail: 100,
            }),
            authority.dockerOperations.previewPrune({
                sourceRevision,
                target: "images",
            }),
            authority.dockerOperations.previewPrune({
                sourceRevision,
                target: "volumes",
            }),
        ]);
        expect(logs).toMatchObject({ containerId, redacted: true, truncated: false });
        expect(imagePrune.items).toHaveLength(1);
        expect(volumePrune.items).toHaveLength(1);

        const serialized = JSON.stringify({
            backups,
            database,
            deliverySections,
            docker,
            git,
            quota,
            weather,
        });
        expect(serialized).not.toContain("/opt/docker");
        expect(serialized).not.toContain("MIRA_GITHUB_TOKEN");
        expect(serialized).not.toContain("DATABASE_PASSWORD");
    });

    test("simulates mutations through normal ports and journals marked receipts", async () => {
        const stateRoot = await developmentStateRoot();
        const authority = createDevelopmentRuntimeAuthority({
            nowMs: () => now,
            stateRoot,
        });
        const delivery = authority.createDelivery(deliveryAuthority);

        expect(
            await authority.docker.execute({
                containerId,
                operation: "container-restart",
                sourceRevision,
            })
        ).toMatchObject({ outcome: "completed", targetCount: 1 });
        expect(
            await authority.backups.run({
                expectedSourceRevision: sourceRevision,
                type: "kopia",
            })
        ).toEqual({ outcome: "completed", sourceRevision });
        expect(
            await delivery.execute({
                expectedHeads: [
                    { headSha: firstPullRequestHead, number: 41 },
                    { headSha: secondPullRequestHead, number: 42 },
                ],
                number: 42,
                operation: "start-preview",
                previewRevision: sourceRevision,
                sourceRevision,
            })
        ).toMatchObject({ operation: "start-preview", outcome: "completed" });
        await authority.databaseObservability.collect();

        const refreshed = await delivery.refresh({});
        expect(refreshed.find(({ section }) => section === "preview")).toMatchObject({
            payload: { preview: { number: 42, status: "running" } },
            state: "succeeded",
        });
        const receiptText = await readFile(
            path.join(stateRoot, "development-authority-simulator", "receipts.ndjson"),
            "utf8"
        );
        const receipts = receiptText
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { operation: string; outcome: string });
        expect(receipts.map(({ operation }) => operation)).toEqual([
            "docker:container-restart",
            "backup:kopia-run",
            "delivery:start-preview",
            "database:observe",
        ]);
        expect(receipts.every(({ outcome }) => outcome === "simulated")).toBeTrue();
    });

    test("exposes deterministic conflict and unknown-outcome paths without dispatch", async () => {
        const authority = createDevelopmentRuntimeAuthority({
            nowMs: () => now,
            outcomes: {
                conflict: new Set(["docker:stack-stop"]),
                unknown: new Set([
                    "backup:kopia-run",
                    "delivery:start-preview",
                    "docker:container-restart",
                ]),
            },
            stateRoot: await developmentStateRoot(),
        });
        const delivery = authority.createDelivery(deliveryAuthority);

        expect(
            await authority.docker.execute({
                containerId,
                operation: "container-restart",
                sourceRevision,
            })
        ).toMatchObject({ outcome: "unknown-outcome" });
        expect(
            authority.dockerOperations.execute({
                containerId,
                operation: "container-restart",
                sourceRevision,
            })
        ).rejects.toEqual(
            expect.objectContaining({
                name: "FixedDockerOperationsError",
                reason: "unknown-outcome",
            })
        );
        expect(
            authority.dockerOperations.execute({
                operation: "stack-stop",
                sourceRevision,
            })
        ).rejects.toEqual(
            expect.objectContaining({
                name: "FixedDockerOperationsError",
                reason: "conflict",
            })
        );
        expect(
            authority.dockerOperations.previewPrune({
                sourceRevision: "c".repeat(64),
                target: "images",
            })
        ).rejects.toBeInstanceOf(FixedDockerOperationsError);
        expect(
            await authority.backups.run({
                expectedSourceRevision: sourceRevision,
                type: "kopia",
            })
        ).toEqual({ outcome: "unknown-outcome" });
        expect(
            await delivery.execute({
                expectedHeads: [
                    { headSha: firstPullRequestHead, number: 41 },
                    { headSha: secondPullRequestHead, number: 42 },
                ],
                number: 42,
                operation: "start-preview",
                previewRevision: sourceRevision,
                sourceRevision,
            })
        ).toEqual({ operation: "start-preview", outcome: "unknown-outcome" });
    });
});
