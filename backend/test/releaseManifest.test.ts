import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
    createReleaseManifest,
    DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY,
    getRuntimeReleaseIdentity,
    loadReleaseManifest,
    loadRuntimeReleaseIdentity,
    parseReleaseManifest,
    RELEASE_MANIFEST_FILE_NAME,
    verifyReleaseArtifacts,
    writeReleaseManifest,
} from "../src/releaseManifest.ts";

const temporaryRoots: string[] = [];
const TEST_COMMIT = "a".repeat(40);
const TEST_BUILT_AT = new Date("2026-07-25T15:00:00.000Z");
const TEST_BUN_VERSION = "1.3.14";

function writeTestBuildIdentities(root: string, commitSha = TEST_COMMIT): void {
    writeFileSync(
        path.join(root, "dist", "build-identity.json"),
        `${JSON.stringify({
            bunVersion: TEST_BUN_VERSION,
            commitSha,
            component: "frontend",
            formatVersion: 1,
        })}\n`
    );
    writeFileSync(
        path.join(root, "backend", "dist", "build-identity.json"),
        `${JSON.stringify({
            bunVersion: TEST_BUN_VERSION,
            commitSha,
            component: "backend",
            formatVersion: 1,
        })}\n`
    );
}

function temporaryReleaseRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "mira-release-manifest-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, "backend", "dist"), { recursive: true });
    mkdirSync(path.join(root, "dist", "assets"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), "{}\n");
    writeFileSync(path.join(root, "bun.lock"), "root-lock\n");
    writeFileSync(path.join(root, "backend", "package.json"), "{}\n");
    writeFileSync(path.join(root, "backend", "bun.lock"), "backend-lock\n");
    writeFileSync(path.join(root, "dist", "index.html"), "<main>release</main>\n");
    writeFileSync(path.join(root, "dist", "assets", "app.js"), "export {};\n");
    writeTestBuildIdentities(root);
    writeFileSync(
        path.join(root, "backend", "dist", "databasePreflight.js"),
        "export {};\n"
    );
    writeFileSync(
        path.join(root, "backend", "dist", "resetDashboardPassword.js"),
        "export {};\n"
    );
    writeFileSync(path.join(root, "backend", "dist", "serverStart.js"), "export {};\n");
    writeFileSync(path.join(root, "backend", "dist", "workerStart.js"), "export {};\n");
    return root;
}

function manifestOptions(releaseRoot: string) {
    return {
        builtAt: TEST_BUILT_AT,
        bunVersion: TEST_BUN_VERSION,
        commitSha: TEST_COMMIT,
        commitTitle: "Test atomic release",
        releaseRoot,
    };
}

function runGit(releaseRoot: string, arguments_: string[]): string {
    const result = Bun.spawnSync({
        cmd: [
            "git",
            "-C",
            releaseRoot,
            "-c",
            "user.name=Mira release test",
            "-c",
            "user.email=mira-release-test@example.invalid",
            ...arguments_,
        ],
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr));
    }
    return new TextDecoder().decode(result.stdout).trim();
}

afterEach(() => {
    const rootsToRemove = [...temporaryRoots];
    temporaryRoots.length = 0;
    for (const root of rootsToRemove) {
        rmSync(root, { force: true, recursive: true });
    }
});

describe("Dashboard release manifest", () => {
    it("builds a deterministic manifest for every runtime artifact", async () => {
        const root = temporaryReleaseRoot();
        const manifest = await createReleaseManifest(manifestOptions(root));

        expect(manifest).toMatchObject({
            builtAt: TEST_BUILT_AT.toISOString(),
            bunVersion: TEST_BUN_VERSION,
            commitSha: TEST_COMMIT,
            commitShort: "aaaaaaaa",
            commitTitle: "Test atomic release",
            components: {
                backendCommit: "aaaaaaaa",
                frontendCommit: "aaaaaaaa",
            },
            formatVersion: 1,
            schema: {
                maximumCompatible: DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
                minimumCompatible: DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.minimum,
                target: DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.target,
            },
        });
        expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual([
            "backend/bun.lock",
            "backend/dist/build-identity.json",
            "backend/dist/databasePreflight.js",
            "backend/dist/resetDashboardPassword.js",
            "backend/dist/serverStart.js",
            "backend/dist/workerStart.js",
            "backend/package.json",
            "bun.lock",
            "dist/assets/app.js",
            "dist/build-identity.json",
            "dist/index.html",
            "package.json",
        ]);
        expect(
            manifest.artifacts.every(
                (artifact) =>
                    /^[\da-f]{64}$/u.test(artifact.sha256) && artifact.sizeBytes > 0
            )
        ).toBe(true);
    });

    it("writes, reloads, and verifies a complete release", async () => {
        const root = temporaryReleaseRoot();
        const written = await writeReleaseManifest(manifestOptions(root));
        const loaded = await loadReleaseManifest(root);

        expect(loaded).toEqual(written);
        await expect(verifyReleaseArtifacts(root, loaded)).resolves.toBeUndefined();
        expect(
            readFileSync(path.join(root, RELEASE_MANIFEST_FILE_NAME), "utf8")
        ).toEndWith("\n");
    });

    it("fails artifact verification after content or inventory drift", async () => {
        const root = temporaryReleaseRoot();
        const manifest = await writeReleaseManifest(manifestOptions(root));

        writeFileSync(path.join(root, "backend", "dist", "serverStart.js"), "tampered\n");
        await expect(verifyReleaseArtifacts(root, manifest)).rejects.toThrow(
            "Release artifact verification failed: backend/dist/serverStart.js"
        );

        writeFileSync(path.join(root, "dist", "unexpected.js"), "unexpected\n");
        await expect(verifyReleaseArtifacts(root, manifest)).rejects.toThrow(
            "Release artifact inventory does not match its manifest"
        );
    });

    it("rejects symlinked and malformed artifact declarations", async () => {
        const root = temporaryReleaseRoot();
        symlinkSync(
            path.join(root, "dist", "index.html"),
            path.join(root, "dist", "assets", "linked.js")
        );

        await expect(createReleaseManifest(manifestOptions(root))).rejects.toThrow(
            "Release artifact tree must not contain symlinks"
        );

        const validRoot = temporaryReleaseRoot();
        const manifest = await createReleaseManifest(manifestOptions(validRoot));
        expect(() =>
            parseReleaseManifest({
                ...manifest,
                artifacts: [
                    ...manifest.artifacts.slice(0, -1),
                    {
                        path: "../outside",
                        sha256: "b".repeat(64),
                        sizeBytes: 1,
                    },
                ],
            })
        ).toThrow("Release manifest contains an invalid artifact");
        expect(() =>
            parseReleaseManifest({
                ...manifest,
                schema: {
                    ...manifest.schema,
                    minimumCompatible: manifest.schema.target + 1,
                },
            })
        ).toThrow("Release manifest schema range is invalid");
    });

    it("requires every runtime and recovery entrypoint", async () => {
        for (const entrypoint of ["resetDashboardPassword.js", "workerStart.js"]) {
            const root = temporaryReleaseRoot();
            rmSync(path.join(root, "backend", "dist", entrypoint));

            await expect(createReleaseManifest(manifestOptions(root))).rejects.toThrow(
                "Release manifest artifact inventory is invalid"
            );
        }
    });

    it("derives identity only from a clean Git release source", async () => {
        const root = temporaryReleaseRoot();
        writeFileSync(
            path.join(root, ".gitignore"),
            "/backend/dist/\n/dist/\n/release-manifest.json\n"
        );
        runGit(root, ["init", "--initial-branch=main"]);
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "Test release source"]);
        const commitSha = runGit(root, ["rev-parse", "HEAD"]);
        writeTestBuildIdentities(root, commitSha);

        await expect(createReleaseManifest({ releaseRoot: root })).resolves.toMatchObject(
            {
                commitTitle: "Test release source",
            }
        );

        writeFileSync(path.join(root, "untracked-runtime.ts"), "export {};\n");
        await expect(createReleaseManifest({ releaseRoot: root })).rejects.toThrow(
            "Release source contains uncommitted changes"
        );
    });

    it("refuses to stamp stale frontend or backend build outputs", async () => {
        for (const component of ["frontend", "backend"] as const) {
            const root = temporaryReleaseRoot();
            const identityPath =
                component === "frontend"
                    ? path.join(root, "dist", "build-identity.json")
                    : path.join(root, "backend", "dist", "build-identity.json");
            writeFileSync(
                identityPath,
                `${JSON.stringify({
                    bunVersion: TEST_BUN_VERSION,
                    commitSha: "b".repeat(40),
                    component,
                    formatVersion: 1,
                })}\n`
            );

            await expect(createReleaseManifest(manifestOptions(root))).rejects.toThrow(
                `${component} build identity does not match the release source`
            );
        }
    });

    it("requires the deployed manifest to match the running code in production", async () => {
        const root = temporaryReleaseRoot();
        const manifest = await writeReleaseManifest(manifestOptions(root));

        await expect(
            loadRuntimeReleaseIdentity(root, "production", TEST_COMMIT)
        ).resolves.toMatchObject({
            backendCommit: "aaaaaaaa",
            frontendCommit: "aaaaaaaa",
            ready: true,
            source: "manifest",
        });
        await expect(
            loadRuntimeReleaseIdentity(root, "production", "b".repeat(40))
        ).resolves.toMatchObject({
            issue: "manifest-code-mismatch",
            ready: false,
            source: "manifest",
        });

        writeFileSync(
            path.join(root, RELEASE_MANIFEST_FILE_NAME),
            `${JSON.stringify(
                {
                    ...manifest,
                    schema: {
                        ...manifest.schema,
                        migrationRegistrySha256: "b".repeat(64),
                    },
                },
                undefined,
                2
            )}\n`
        );
        await expect(
            loadRuntimeReleaseIdentity(root, "production", TEST_COMMIT)
        ).resolves.toMatchObject({
            issue: "manifest-code-mismatch",
            ready: false,
            source: "manifest",
        });
    });

    it("rejects a manifest built by another Bun runtime", async () => {
        const root = temporaryReleaseRoot();
        const manifest = await writeReleaseManifest(manifestOptions(root));
        writeFileSync(
            path.join(root, RELEASE_MANIFEST_FILE_NAME),
            `${JSON.stringify(
                {
                    ...manifest,
                    bunVersion: "0.0.0",
                },
                undefined,
                2
            )}\n`
        );

        await expect(
            loadRuntimeReleaseIdentity(root, "production", TEST_COMMIT)
        ).resolves.toMatchObject({
            issue: "manifest-code-mismatch",
            ready: false,
            source: "manifest",
        });
    });

    it("fails runtime readiness when a declared artifact changes", async () => {
        const root = temporaryReleaseRoot();
        await writeReleaseManifest(manifestOptions(root));
        writeFileSync(path.join(root, "backend", "dist", "serverStart.js"), "drift\n");

        await expect(
            loadRuntimeReleaseIdentity(root, "production", TEST_COMMIT)
        ).resolves.toMatchObject({
            issue: "manifest-invalid",
            ready: false,
        });
    });

    it("revalidates artifacts after an earlier readiness success", async () => {
        const root = temporaryReleaseRoot();
        await writeReleaseManifest(manifestOptions(root));

        await expect(
            getRuntimeReleaseIdentity(root, "production", TEST_COMMIT)
        ).resolves.toMatchObject({
            ready: true,
            source: "manifest",
        });
        writeFileSync(path.join(root, "dist", "assets", "app.js"), "drift\n");
        await expect(
            getRuntimeReleaseIdentity(root, "production", TEST_COMMIT)
        ).resolves.toMatchObject({
            issue: "manifest-invalid",
            ready: false,
        });
    });

    it("allows only non-production Git fallback when a manifest is absent", async () => {
        const root = temporaryReleaseRoot();

        await expect(
            loadRuntimeReleaseIdentity(root, "production", TEST_COMMIT)
        ).resolves.toMatchObject({
            issue: "manifest-missing",
            ready: false,
        });
        await expect(loadRuntimeReleaseIdentity(root, "test")).resolves.toMatchObject({
            ready: true,
        });
    });
});
