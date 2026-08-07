import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import { withBunBuildAdmission } from "./buildAdmission.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function repositoryFixture(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-build-admission-"));
    temporaryDirectories.push(root);
    return root;
}

describe("Bun build admission", () => {
    test("runs competing operations one at a time", async () => {
        const repositoryRoot = await repositoryFixture();
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstMayFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = withBunBuildAdmission(repositoryRoot, async () => {
            events.push("first-start");
            await firstMayFinish;
            events.push("first-end");
        });
        await Bun.sleep(20);
        const second = withBunBuildAdmission(repositoryRoot, () => {
            events.push("second");
            return Promise.resolve();
        });
        await Bun.sleep(20);

        expect(events).toEqual(["first-start"]);
        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual(["first-start", "first-end", "second"]);
    });

    test("recovers a validated dead-owner lock and rejects malformed lock data", async () => {
        const recoveredRoot = await repositoryFixture();
        const recoveredDist = path.join(recoveredRoot, "dist");
        await mkdir(recoveredDist);
        await writeFile(
            path.join(recoveredDist, ".bun-build.lock"),
            `${JSON.stringify({
                pid: 1_999_999_999,
                token: Bun.randomUUIDv7(),
            })}\n`,
            { mode: 0o600 }
        );
        let ran = false;
        await withBunBuildAdmission(recoveredRoot, () => {
            ran = true;
            return Promise.resolve();
        });
        expect(ran).toBeTrue();

        const malformedRoot = await repositoryFixture();
        const malformedDist = path.join(malformedRoot, "dist");
        await mkdir(malformedDist);
        await writeFile(path.join(malformedDist, ".bun-build.lock"), "not-json\n", {
            mode: 0o600,
        });
        const failure = await rejectionError(
            withBunBuildAdmission(malformedRoot, () => Promise.resolve())
        );
        expect(failure.message).toBe("Bun build admission failed");
    });
});
