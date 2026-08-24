import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
    serializeReleaseManifest,
} from "../../../shared/releaseManifest.ts";
import { loadRuntimeRelease } from "./runtimeRelease.ts";

const temporaryDirectories: string[] = [];
const commitSha = "b".repeat(40);
const revision = "a".repeat(40);
const checksum = "c".repeat(64);
const observedRuntime = { revision, version: "1.4.0" } as const;

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => {
            const releases = path.join(directory, "releases");
            await chmod(releases, 0o700).catch(() => {});
            const entries = await readdir(releases, { withFileTypes: true }).catch(
                () => []
            );
            await Promise.all(
                entries
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => chmod(path.join(releases, entry.name), 0o700))
            );
            await rm(directory, { force: true, recursive: true });
        })
    );
});

function manifest() {
    return {
        artifacts: [{ bytes: 3, path: "server/web.js", sha256: checksum }],
        buildCommands: [...releaseBuildCommands],
        deliveryProtocols: [...releaseDeliveryProtocols],
        display: { builtAtMs: 1, commitTitle: "Test release", schemaTarget: 1 },
        documentationSha256: checksum,
        formatVersion: 1,
        lockfileSha256: checksum,
        migrations: [
            {
                id: "20260804022252_dashboard-foundation",
                migrationSha256: checksum,
                snapshotSha256: checksum,
            },
        ],
        packages: [{ name: "react", scope: "dependency" as const, version: "19.2.8" }],
        processRoles: [...releaseProcessRoles],
        runtime: observedRuntime,
        source: { commitSha, treeState: "clean" as const },
    };
}

async function releaseFixture(): Promise<{
    releaseRoot: string;
    releasesDirectory: string;
}> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-runtime-release-"));
    temporaryDirectories.push(root);
    const releasesDirectory = path.join(root, "releases");
    const releaseRoot = path.join(releasesDirectory, commitSha);
    await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
    await writeFile(
        path.join(releaseRoot, "release-manifest.json"),
        serializeReleaseManifest(manifest()),
        { mode: 0o600 }
    );
    await chmod(path.join(releaseRoot, "release-manifest.json"), 0o400);
    await chmod(releaseRoot, 0o500);
    await chmod(releasesDirectory, 0o700);
    return { releaseRoot, releasesDirectory };
}

describe("runtime release", () => {
    test("loads an exact immutable release and runtime identity", async () => {
        const fixture = await releaseFixture();

        const release = await loadRuntimeRelease(
            fixture.releasesDirectory,
            fixture.releaseRoot,
            "web",
            observedRuntime
        );

        expect(release.releaseRoot).toBe(fixture.releaseRoot);
        expect(release.manifest).toEqual(manifest());
        expect(Object.isFrozen(release)).toBe(true);
    });

    test("rejects writable manifests, symlink roots and runtime mismatch", async () => {
        const writable = await releaseFixture();
        await chmod(path.join(writable.releaseRoot, "release-manifest.json"), 0o600);
        expect(
            loadRuntimeRelease(
                writable.releasesDirectory,
                writable.releaseRoot,
                "worker",
                observedRuntime
            )
        ).rejects.toThrow("Runtime release is invalid");

        const linked = await releaseFixture();
        const linkPath = path.join(linked.releasesDirectory, "linked-release");
        await symlink(linked.releaseRoot, linkPath, "dir");
        expect(
            loadRuntimeRelease(linked.releasesDirectory, linkPath, "web", observedRuntime)
        ).rejects.toThrow("Runtime release is invalid");

        const mismatch = await releaseFixture();
        expect(
            loadRuntimeRelease(mismatch.releasesDirectory, mismatch.releaseRoot, "web", {
                revision: "d".repeat(40),
                version: "1.4.0",
            })
        ).rejects.toThrow("Runtime release is invalid");
    });

    test("rejects release replacement after reading the held manifest", async () => {
        const fixture = await releaseFixture();
        const displaced = `${fixture.releaseRoot}-displaced`;
        let replaced = false;

        expect(
            loadRuntimeRelease(
                fixture.releasesDirectory,
                fixture.releaseRoot,
                "web",
                observedRuntime,
                {
                    afterManifestRead: async () => {
                        replaced = true;
                        await rename(fixture.releaseRoot, displaced);
                        await mkdir(fixture.releaseRoot, { mode: 0o500 });
                    },
                }
            )
        ).rejects.toThrow("Runtime release is invalid");
        expect(replaced).toBe(true);
    });
});
