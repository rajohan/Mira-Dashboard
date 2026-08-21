import { describe, expect, test } from "bun:test";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    type DevelopmentFileRootPreparationTestHooks,
    prepareDevelopmentFileRoots,
} from "./developmentFileRoots.ts";
import { resolveDevelopmentStackConfig } from "./developmentStackConfig.ts";
import { prepareDevelopmentState } from "./developmentState.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");

async function captureFailure(operation: () => Promise<void>): Promise<Error> {
    const failure = await operation().then(
        () => null,
        (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected file-root failure");
    return failure;
}

describe("development file roots", () => {
    test("never chmods a swapped directory target outside held state", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-directory-swap-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const hooksRoot = path.join(config.openClawRoot, "hooks");
        const detachedHooksRoot = path.join(config.openClawRoot, "hooks.detached");
        const outsideRoot = path.join(temporaryRoot, "outside-hooks");
        const outsideSentinel = path.join(outsideRoot, "sentinel.txt");
        let injected = false;
        const testHooks: DevelopmentFileRootPreparationTestHooks = {
            async afterStage(stage, segments) {
                if (
                    injected ||
                    stage !== "directory-opened" ||
                    segments.join("/") !== "openclaw-home/hooks"
                ) {
                    return;
                }
                injected = true;
                await rename(hooksRoot, detachedHooksRoot);
                await symlink(outsideRoot, hooksRoot);
            },
        };

        try {
            await prepareDevelopmentState(config);
            await rm(hooksRoot, { recursive: true });
            await mkdir(outsideRoot, { mode: 0o755 });
            await chmod(outsideRoot, 0o755);
            await writeFile(outsideSentinel, "outside\n", { mode: 0o644 });
            const outsideBefore = await lstat(outsideRoot);
            const outsideMode = outsideBefore.mode & 0o777;

            const failure = await captureFailure(() =>
                prepareDevelopmentFileRoots(config, testHooks)
            );

            expect(injected).toBeTrue();
            expect(failure.message).toBe("Development file root is invalid");
            const outsideAfter = await lstat(outsideRoot);
            expect(outsideAfter.mode & 0o777).toBe(outsideMode);
            expect(await readFile(outsideSentinel, "utf8")).toBe("outside\n");
            expect(await readdir(outsideRoot)).toEqual(["sentinel.txt"]);
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("never creates through a pre-open swapped parent outside held state", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-file-swap-")
        );
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
            },
            repositoryRoot
        );
        const transformsRoot = path.join(config.openClawRoot, "hooks", "transforms");
        const transformPath = path.join(transformsRoot, "agentmail.ts");
        const detachedTransformsRoot = `${transformsRoot}.detached`;
        const detachedTransformPath = path.join(detachedTransformsRoot, "agentmail.ts");
        const outsideRoot = path.join(temporaryRoot, "outside-transforms");
        const outsideSentinel = path.join(outsideRoot, "sentinel.txt");
        let injected = false;
        const testHooks: DevelopmentFileRootPreparationTestHooks = {
            async afterStage(stage, segments) {
                if (
                    injected ||
                    stage !== "before-child-mutation" ||
                    segments.join("/") !== "openclaw-home/hooks/transforms"
                ) {
                    return;
                }
                injected = true;
                await rename(transformsRoot, detachedTransformsRoot);
                await symlink(outsideRoot, transformsRoot);
            },
        };

        try {
            await prepareDevelopmentState(config);
            await rm(transformPath);
            await mkdir(outsideRoot, { mode: 0o755 });
            await chmod(outsideRoot, 0o755);
            await writeFile(outsideSentinel, "outside\n", { mode: 0o644 });
            await chmod(outsideSentinel, 0o644);
            const [outsideRootBefore, outsideFileBefore] = await Promise.all([
                lstat(outsideRoot),
                lstat(outsideSentinel),
            ]);
            const outsideRootMode = outsideRootBefore.mode & 0o777;
            const outsideFileMode = outsideFileBefore.mode & 0o777;

            const failure = await captureFailure(() =>
                prepareDevelopmentFileRoots(config, testHooks)
            );

            expect(injected).toBeTrue();
            expect(failure.message).toBe("Development file root is invalid");
            expect(await readFile(outsideSentinel, "utf8")).toBe("outside\n");
            const [outsideRootAfter, outsideFileAfter] = await Promise.all([
                lstat(outsideRoot),
                lstat(outsideSentinel),
            ]);
            expect(outsideRootAfter.mode & 0o777).toBe(outsideRootMode);
            expect(outsideFileAfter.mode & 0o777).toBe(outsideFileMode);
            expect(await readdir(outsideRoot)).toEqual(["sentinel.txt"]);
            expect(await readFile(detachedTransformPath, "utf8")).toBe("");
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });
});
