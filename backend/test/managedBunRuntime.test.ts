import { afterEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    bunExecutableMatchesRuntime,
    bunExecutableRuntimeIdentity,
    hasManagedBunRuntime,
    installManagedBunRuntime,
    isBunRuntimeVersion,
    managedBunRuntimeExecutablePath,
    pruneManagedBunRuntimes,
    requireManagedBunRuntime,
    resolveDashboardReleaseBuildBunExecutable,
} from "../src/managedBunRuntime.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
    const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
    temporaryRoots.push(root);
    return root;
}

function writeFakeBun(
    filePath: string,
    version: string,
    revision = `${version}+deadbeef`
): void {
    writeFileSync(
        filePath,
        `#!/bin/sh
if [ "\${1:-}" = "--revision" ]; then
    printf '%s\\n' '${revision}'
    exit 0
fi
printf '%s\\n' "\${1:-}"
`
    );
    chmodSync(filePath, 0o700);
}

afterEach(() => {
    for (const root of temporaryRoots) {
        rmSync(root, { force: true, recursive: true });
    }
    temporaryRoots.length = 0;
});

describe("managed Bun runtimes", () => {
    it("accepts only bounded revision-qualified identities across Bun majors", () => {
        expect(isBunRuntimeVersion("1.3.14+0d9b296af")).toBe(true);
        expect(isBunRuntimeVersion("2.0.0-canary.1+build.2")).toBe(true);
        expect(isBunRuntimeVersion("1.3.14")).toBe(false);
        expect(isBunRuntimeVersion("2.0.0")).toBe(false);
        expect(isBunRuntimeVersion("1.3")).toBe(false);
        expect(isBunRuntimeVersion("1.3.14foo")).toBe(false);
        expect(isBunRuntimeVersion("01.3.14")).toBe(false);
        expect(isBunRuntimeVersion("1.3.14-01")).toBe(false);
        expect(isBunRuntimeVersion("../1.3.14")).toBe(false);
        expect(isBunRuntimeVersion("not-semver")).toBe(false);
    });

    it("atomically installs and resolves an exact release runtime", async () => {
        const root = temporaryRoot("mira-managed-bun");
        const runtimeRoot = path.join(root, "runtimes");
        const source = path.join(root, "bun-source");
        const identity = "1.3.14+0d9b296af";
        writeFakeBun(source, "1.3.14", identity);
        linkSync(source, path.join(root, "package-hardlink"));

        const installed = await installManagedBunRuntime(source, identity, {
            runtimeRoot,
        });

        expect(installed).toBe(managedBunRuntimeExecutablePath(identity, runtimeRoot));
        expect(bunExecutableRuntimeIdentity(installed)).toBe(identity);
        expect(bunExecutableMatchesRuntime(installed, identity)).toBe(true);
        expect(bunExecutableMatchesRuntime(installed, "1.3.14")).toBe(false);
        expect(hasManagedBunRuntime(identity, runtimeRoot)).toBe(true);
        expect(requireManagedBunRuntime(identity, runtimeRoot)).toBe(installed);
        expect(await installManagedBunRuntime(source, identity, { runtimeRoot })).toBe(
            installed
        );
        expect(
            readFileSync(installed, "utf8").includes(
                String.raw`printf '%s\n' '1.3.14+0d9b296af'`
            )
        ).toBe(true);
        expect(readdirSync(path.join(runtimeRoot, identity))).toEqual(["bun"]);
        expect(statSync(installed).nlink).toBe(1);

        linkSync(installed, path.join(root, "external-runtime-hardlink"));
        expect(hasManagedBunRuntime(identity, runtimeRoot)).toBe(false);
        expect(() => requireManagedBunRuntime(identity, runtimeRoot)).toThrow(
            `Managed Bun runtime ${identity} is not available`
        );
    });

    it("rejects missing, mismatched, and noncanonical runtimes", async () => {
        const root = temporaryRoot("mira-managed-bun-invalid");
        const runtimeRoot = path.join(root, "runtimes");
        const source = path.join(root, "bun-source");
        const versionOnlySource = path.join(root, "bun-version-only");
        writeFakeBun(source, "2.0.0", "2.0.0+feedface");
        writeFakeBun(versionOnlySource, "2.0.0", "2.0.0");

        expect(bunExecutableRuntimeIdentity(versionOnlySource)).toBeUndefined();

        const installError = await installManagedBunRuntime(source, "1.3.14", {
            runtimeRoot,
        }).then(
            () => null,
            (error: unknown) => error
        );
        expect(installError).toBeInstanceOf(Error);
        expect((installError as Error).message).toContain(
            "must be revision-qualified semver"
        );
        expect(() => requireManagedBunRuntime("2.0.0", runtimeRoot)).toThrow(
            "must be revision-qualified semver"
        );
        expect(() => managedBunRuntimeExecutablePath("../2.0.0", runtimeRoot)).toThrow(
            "must be revision-qualified semver"
        );
    });

    it("recovers an interrupted hardlink publication on retry", async () => {
        const root = temporaryRoot("mira-managed-bun-recovery");
        const runtimeRoot = path.join(root, "runtimes");
        const source = path.join(root, "bun-source");
        const identity = "1.4.0-canary.1+feedface";
        writeFakeBun(source, "1.4.0-canary.1", identity);
        const installed = await installManagedBunRuntime(source, identity, {
            runtimeRoot,
        });
        linkSync(
            installed,
            path.join(path.dirname(installed), ".staging-interrupted-install")
        );

        expect(hasManagedBunRuntime(identity, runtimeRoot)).toBe(false);
        expect(await installManagedBunRuntime(source, identity, { runtimeRoot })).toBe(
            installed
        );
        expect(hasManagedBunRuntime(identity, runtimeRoot)).toBe(true);
        expect(readdirSync(path.dirname(installed))).toEqual(["bun"]);
    });

    it("prunes only runtimes unreferenced by retained releases", async () => {
        const root = temporaryRoot("mira-managed-bun-prune");
        const runtimeRoot = path.join(root, "runtimes");
        const retainedSource = path.join(root, "bun-retained");
        const removedSource = path.join(root, "bun-removed");
        const retainedIdentity = "1.4.0-canary.1+feedface";
        const removedIdentity = "2.0.0+deadbeef";
        writeFakeBun(retainedSource, "1.4.0-canary.1", retainedIdentity);
        writeFakeBun(removedSource, "2.0.0", removedIdentity);
        await installManagedBunRuntime(retainedSource, retainedIdentity, {
            runtimeRoot,
        });
        await installManagedBunRuntime(removedSource, removedIdentity, {
            runtimeRoot,
        });
        const interruptedRetirement = path.join(
            runtimeRoot,
            ".retired-00000000-0000-7000-8000-000000000000"
        );
        mkdirSync(interruptedRetirement);
        writeFileSync(path.join(interruptedRetirement, "stale"), "stale");
        writeFileSync(path.join(runtimeRoot, "README"), "operator note\n");

        const result = await pruneManagedBunRuntimes([retainedIdentity], runtimeRoot);

        expect(result).toEqual({
            removed: [removedIdentity],
            retained: [retainedIdentity],
            warnings: ["Skipped unrecognized managed Bun runtime entry README"],
        });
        expect(hasManagedBunRuntime(retainedIdentity, runtimeRoot)).toBe(true);
        expect(hasManagedBunRuntime(removedIdentity, runtimeRoot)).toBe(false);
        expect(readdirSync(runtimeRoot).toSorted()).toEqual([retainedIdentity, "README"]);
        const unavailableRuntimeError = await pruneManagedBunRuntimes(
            [removedIdentity],
            runtimeRoot
        ).catch((error: unknown) => error);
        expect(unavailableRuntimeError).toBeInstanceOf(Error);
        expect((unavailableRuntimeError as Error).message).toBe(
            `Retained release requires unavailable managed Bun runtime ${removedIdentity}`
        );
    });

    it("selects the host bootstrap Bun independently of the active worker", () => {
        expect(
            resolveDashboardReleaseBuildBunExecutable({
                HOME: "/srv/dashboard-user",
            })
        ).toBe("/srv/dashboard-user/.bun/bin/bun");
        expect(
            resolveDashboardReleaseBuildBunExecutable({
                HOME: "/srv/dashboard-user",
                MIRA_DASHBOARD_DEPLOY_BUN_EXECUTABLE: "/opt/bun/candidate",
            })
        ).toBe("/opt/bun/candidate");
    });

    it("launches the active release with its exact cached major runtime", () => {
        const projectRoot = temporaryRoot("mira-managed-bun-launcher");
        const releaseCommit = "a".repeat(40);
        const releasesRoot = path.join(projectRoot, "production", "releases");
        const releaseRoot = path.join(releasesRoot, "releases", releaseCommit);
        const releaseBackend = path.join(releaseRoot, "backend");
        const currentRelease = path.join(releasesRoot, "current");
        const runtime = path.join(
            projectRoot,
            "production",
            "runtimes",
            "bun",
            "2.0.0+feedface",
            "bun"
        );
        mkdirSync(releaseBackend, { recursive: true });
        symlinkSync(path.join("releases", releaseCommit), currentRelease);
        mkdirSync(path.dirname(runtime), { recursive: true });
        writeFileSync(
            path.join(releaseRoot, "release-manifest.json"),
            `${JSON.stringify({ bunVersion: "2.0.0+feedface" })}\n`
        );
        writeFakeBun(runtime, "2.0.0", "2.0.0+feedface");

        const launcher = path.resolve(
            import.meta.dirname,
            "../../scripts/runManagedDashboardRelease.sh"
        );
        const launched = Bun.spawnSync({
            cmd: [launcher, "dist/workerStart.js"],
            env: {
                MIRA_DASHBOARD_PROJECT_ROOT: projectRoot,
                PATH: "/usr/bin:/bin",
            },
            cwd: releaseBackend,
            stderr: "pipe",
            stdout: "pipe",
        });
        expect(launched.exitCode).toBe(0);
        expect(new TextDecoder().decode(launched.stdout).trim()).toBe(
            "dist/workerStart.js"
        );

        const versionOnlyRuntime = path.join(
            projectRoot,
            "production",
            "runtimes",
            "bun",
            "2.0.0",
            "bun"
        );
        mkdirSync(path.dirname(versionOnlyRuntime), { recursive: true });
        writeFakeBun(versionOnlyRuntime, "2.0.0", "2.0.0+feedface");
        writeFileSync(
            path.join(releaseRoot, "release-manifest.json"),
            `${JSON.stringify({ bunVersion: "2.0.0" })}\n`
        );
        const versionOnly = Bun.spawnSync({
            cmd: [launcher, "dist/workerStart.js"],
            cwd: releaseBackend,
            env: {
                MIRA_DASHBOARD_PROJECT_ROOT: projectRoot,
                PATH: "/usr/bin:/bin",
            },
            stderr: "pipe",
            stdout: "pipe",
        });
        expect(versionOnly.exitCode).toBe(78);
        expect(new TextDecoder().decode(versionOnly.stderr)).toContain(
            "release manifest has no valid Bun runtime"
        );

        const rejected = Bun.spawnSync({
            cmd: [launcher, "arbitrary.js"],
            env: {
                MIRA_DASHBOARD_PROJECT_ROOT: projectRoot,
                PATH: "/usr/bin:/bin",
            },
            cwd: releaseBackend,
            stderr: "pipe",
            stdout: "pipe",
        });
        expect(rejected.exitCode).toBe(64);
    });
});
