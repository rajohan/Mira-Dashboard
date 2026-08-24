import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function currentProcessIdentity() {
    const processStat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    const processFields = processStat
        .slice(processStat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/u);
    const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
    const processStartTicks = processFields[19];
    if (processStartTicks === undefined) throw new Error("Missing process identity");
    return Object.freeze({
        bootId: bootId.trim(),
        processStartTicks,
    });
}

describe("Bun build admission", () => {
    test("runs competing operations one at a time", async () => {
        const repositoryRoot = await repositoryFixture();
        const events: string[] = [];
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstMayFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });

        const first = withBunBuildAdmission(repositoryRoot, async () => {
            events.push("first-start");
            markFirstStarted();
            await firstMayFinish;
            events.push("first-end");
        });
        let second: Promise<void> | undefined;
        try {
            await firstStarted;
            second = withBunBuildAdmission(repositoryRoot, () => {
                events.push("second");
                return Promise.resolve();
            });
            await Bun.sleep(20);

            expect(events).toEqual(["first-start"]);
            releaseFirst();
            await Promise.all([first, second]);
            expect(events).toEqual(["first-start", "first-end", "second"]);
        } finally {
            releaseFirst();
            await Promise.allSettled([first, ...(second === undefined ? [] : [second])]);
        }
    });

    test("recovers a validated dead-owner lock and rejects malformed lock data", async () => {
        const recoveredRoot = await repositoryFixture();
        const recoveredDist = path.join(recoveredRoot, "dist");
        await mkdir(recoveredDist);
        const identity = await currentProcessIdentity();
        await writeFile(
            path.join(recoveredDist, ".bun-build.lock"),
            `${JSON.stringify({
                bootId: identity.bootId,
                pid: 1_999_999_999,
                processStartTicks: "1",
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

    test("recovers owners invalidated by a reboot or PID reuse", async () => {
        const identity = await currentProcessIdentity();
        for (const owner of [
            {
                bootId: "11111111-1111-4111-8111-111111111111",
                pid: process.pid,
                processStartTicks: identity.processStartTicks,
            },
            {
                bootId: identity.bootId,
                pid: process.pid,
                processStartTicks: identity.processStartTicks === "1" ? "2" : "1",
            },
        ]) {
            const repositoryRoot = await repositoryFixture();
            const dist = path.join(repositoryRoot, "dist");
            await mkdir(dist);
            await writeFile(
                path.join(dist, ".bun-build.lock"),
                `${JSON.stringify({ ...owner, token: Bun.randomUUIDv7() })}\n`,
                { mode: 0o600 }
            );
            let ran = false;

            await withBunBuildAdmission(repositoryRoot, () => {
                ran = true;
                return Promise.resolve();
            });

            expect(ran).toBeTrue();
        }
    });
});
