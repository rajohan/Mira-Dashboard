import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    type DevelopmentChildProcess,
    runDevelopmentStack,
} from "./developmentRuntime.ts";
import { resolveDevelopmentStackConfig } from "./developmentStackConfig.ts";
import { prepareDevelopmentRuntimeState } from "./developmentState.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");

interface FakeChild {
    readonly child: DevelopmentChildProcess;
    exit(code: number): void;
    readonly signals: Array<number | NodeJS.Signals | undefined>;
}

function fakeChild(): FakeChild {
    let exitCode: number | null = null;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
    });
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    const exit = (code: number) => {
        if (exitCode !== null) return;
        exitCode = code;
        resolveExit(code);
    };
    return {
        child: {
            exited,
            get exitCode() {
                return exitCode;
            },
            kill(signal) {
                signals.push(signal);
                exit(0);
            },
        },
        exit,
        signals,
    };
}

async function runtimeConfig(temporaryRoot: string) {
    const tokenPath = path.join(temporaryRoot, "gateway-token");
    await writeFile(tokenPath, "development-test-token\n", { mode: 0o600 });
    return resolveDevelopmentStackConfig(
        {
            MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE: tokenPath,
            MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
        },
        repositoryRoot
    );
}

async function expectLeaseReleased(
    config: Awaited<ReturnType<typeof runtimeConfig>>
): Promise<void> {
    const entries = await readdir(config.stateRoot);
    expect(
        entries.filter((entry) => entry.startsWith(".mira-dashboard-development-lease-"))
    ).toEqual([]);
    const session = await prepareDevelopmentRuntimeState(config);
    await session.release();
}

describe("development runtime lifecycle", () => {
    test("stops already-started children and releases state when a later spawn fails", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-runtime-spawn-")
        );
        const config = await runtimeConfig(temporaryRoot);
        const web = fakeChild();
        let spawnCalls = 0;

        try {
            const failure = await runDevelopmentStack(config, {
                spawn() {
                    spawnCalls += 1;
                    if (spawnCalls === 1) return web.child;
                    throw new Error("simulated worker spawn failure");
                },
            }).then(
                () => null,
                (error: unknown) => error
            );
            expect(failure).toBeInstanceOf(Error);
            if (!(failure instanceof Error)) throw new Error("Expected spawn failure");
            expect(failure.message).toContain("simulated worker spawn failure");
            expect(web.signals).toEqual(["SIGTERM"]);
            await expectLeaseReleased(config);
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("stops sibling processes and releases state after one child exits", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-runtime-exit-")
        );
        const config = await runtimeConfig(temporaryRoot);
        const web = fakeChild();
        const worker = fakeChild();
        const frontend = fakeChild();
        const children = [web, worker, frontend];
        let resolveStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        let spawnCalls = 0;

        try {
            const running = runDevelopmentStack(config, {
                spawn() {
                    const next = children[spawnCalls];
                    spawnCalls += 1;
                    if (spawnCalls === children.length) resolveStarted();
                    if (next === undefined) throw new Error("Unexpected child spawn");
                    return next.child;
                },
            });
            await Promise.race([
                started,
                Bun.sleep(5000).then(() => {
                    throw new Error("Development children did not start");
                }),
            ]);
            web.exit(7);

            expect(await running).toBe(7);
            expect(web.signals).toEqual([]);
            expect(worker.signals).toEqual(["SIGTERM"]);
            expect(frontend.signals).toEqual(["SIGTERM"]);
            await expectLeaseReleased(config);
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });
});
