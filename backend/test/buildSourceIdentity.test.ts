import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    isReleaseBuildCommit,
    resolveBuildSourceIdentity,
} from "../../scripts/buildSourceIdentity.ts";

const temporaryRoots: string[] = [];

function runGit(repoDirectory: string, arguments_: string[]): string {
    const result = Bun.spawnSync({
        cmd: [
            "git",
            "-C",
            repoDirectory,
            "-c",
            "user.name=Mira build test",
            "-c",
            "user.email=mira-build-test@example.invalid",
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

describe("release build source identity", () => {
    it("marks tracked and untracked source changes as non-release builds", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-build-identity-"));
        temporaryRoots.push(root);
        mkdirSync(path.join(root, "src"));
        writeFileSync(path.join(root, "src", "entry.ts"), "export const value = 1;\n");
        runGit(root, ["init", "--initial-branch=main"]);
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "Initial source"]);
        const commit = runGit(root, ["rev-parse", "HEAD"]);

        expect(resolveBuildSourceIdentity(root)).toBe(commit);
        expect(isReleaseBuildCommit(commit)).toBe(true);

        writeFileSync(path.join(root, "src", "entry.ts"), "export const value = 2;\n");
        expect(resolveBuildSourceIdentity(root)).toBe(`${commit}-dirty`);
        expect(isReleaseBuildCommit(`${commit}-dirty`)).toBe(false);

        runGit(root, ["restore", "src/entry.ts"]);
        writeFileSync(path.join(root, "src", "new.ts"), "export {};\n");
        expect(resolveBuildSourceIdentity(root)).toBe(`${commit}-dirty`);
    });

    it("returns unknown outside a readable Git source tree", () => {
        const root = mkdtempSync(path.join(tmpdir(), "mira-build-identity-"));
        temporaryRoots.push(root);

        expect(resolveBuildSourceIdentity(root)).toBe("unknown");
        expect(isReleaseBuildCommit("unknown")).toBe(false);
    });
});
