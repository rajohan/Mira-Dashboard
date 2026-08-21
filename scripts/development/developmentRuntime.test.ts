import { describe, expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readDevelopmentMigrationIdentity } from "./developmentMigrationIdentity.ts";
import { guardedDevelopmentChildCommand } from "./developmentProcessGuard.ts";
import {
    type DevelopmentChildProcess,
    runDevelopmentStack,
} from "./developmentRuntime.ts";
import { resolveDevelopmentStackConfig } from "./developmentStackConfig.ts";
import { prepareDevelopmentRuntimeState } from "./developmentState.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const sourceCommit = "0".repeat(40);
const runtimeMigrationId = "20260812000001_development-runtime-test";
const runtimeSnapshot = '{"version":1}\n';
const developmentTestEnvironment = Object.freeze({
    MOLTBOOK_API_KEY: "moltbook-development-test-key",
});

interface FakeChild {
    readonly child: DevelopmentChildProcess;
    exit(code: number): void;
    readonly firstSignal: Promise<number | NodeJS.Signals | undefined>;
    readonly signals: Array<number | NodeJS.Signals | undefined>;
}

function fakeChild(options: { readonly ignoreSigterm?: boolean } = {}): FakeChild {
    let exitCode: number | null = null;
    let resolveExit!: (code: number) => void;
    let resolveFirstSignal!: (signal: number | NodeJS.Signals | undefined) => void;
    const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
    });
    const firstSignal = new Promise<number | NodeJS.Signals | undefined>((resolve) => {
        resolveFirstSignal = resolve;
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
                if (signals.length === 1) resolveFirstSignal(signal);
                if (signal === "SIGTERM" && options.ignoreSigterm === true) return;
                exit(0);
            },
        },
        exit,
        firstSignal,
        signals,
    };
}

function sha256(contents: string): string {
    return new Bun.CryptoHasher("sha256").update(contents).digest("hex");
}

function runtimeMigrationManifest(migrationSql: string): string {
    return `export interface MigrationManifestEntry {
    readonly id: string;
    readonly migrationSha256: string;
    readonly snapshotSha256: string;
}

export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([
    Object.freeze({
        id: "${runtimeMigrationId}",
        migrationSha256: "${sha256(migrationSql)}",
        snapshotSha256: "${sha256(runtimeSnapshot)}",
    }),
]);
`;
}

async function writeRuntimeMigrationFixture(
    repositoryRootPath: string,
    migrationSql: string
): Promise<void> {
    const migrationRoot = path.join(repositoryRootPath, "migrations", runtimeMigrationId);
    const manifestRoot = path.join(repositoryRootPath, "src", "shared");
    await Promise.all([
        mkdir(migrationRoot, { recursive: true }),
        mkdir(manifestRoot, { recursive: true }),
    ]);
    await Promise.all([
        writeFile(path.join(migrationRoot, "migration.sql"), migrationSql, "utf8"),
        writeFile(path.join(migrationRoot, "snapshot.json"), runtimeSnapshot, "utf8"),
        writeFile(
            path.join(manifestRoot, "databaseMigrationManifest.ts"),
            runtimeMigrationManifest(migrationSql),
            "utf8"
        ),
    ]);
}

async function runtimeConfig(temporaryRoot: string, repositoryRootPath = repositoryRoot) {
    const tokenPath = path.join(temporaryRoot, "gateway-token");
    await writeFile(tokenPath, "development-test-token\n", { mode: 0o600 });
    return resolveDevelopmentStackConfig(
        {
            MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE: tokenPath,
            MIRA_DASHBOARD_PROJECT_ROOT: path.join(temporaryRoot, "project"),
        },
        repositoryRootPath
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

describe("development process guard", () => {
    test("rejects invalid direct-child commands and parent process IDs", () => {
        expect(() => guardedDevelopmentChildCommand([], process.pid)).toThrow(
            "Development child command must use an absolute executable"
        );
        expect(() =>
            guardedDevelopmentChildCommand(["relative-executable"], process.pid)
        ).toThrow("Development child command must use an absolute executable");
        expect(() => guardedDevelopmentChildCommand(["/bin/true"], 1)).toThrow(
            "Development child command parent PID is invalid"
        );
        expect(() => guardedDevelopmentChildCommand(["/bin/true"], 1.5)).toThrow(
            "Development child command parent PID is invalid"
        );
    });
});

describe("development runtime lifecycle", () => {
    test("keeps the default state root outside a top-level source checkout", () => {
        const xdgStateRoot = path.join(tmpdir(), "mira-dashboard-development-xdg-state");
        const config = resolveDevelopmentStackConfig(
            {
                MIRA_DASHBOARD_PROJECT_ROOT: repositoryRoot,
                XDG_STATE_HOME: xdgStateRoot,
            },
            repositoryRoot
        );

        expect(config.stateRoot).toBe(
            path.join(xdgStateRoot, "mira-dashboard", "development", "source-local")
        );
        expect(path.relative(repositoryRoot, config.stateRoot)).toStartWith("..");
    });

    test("stops already-started children and releases state when a later spawn fails", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-runtime-spawn-")
        );
        const config = await runtimeConfig(temporaryRoot);
        const web = fakeChild();
        let spawnCalls = 0;

        try {
            const failure = await runDevelopmentStack(config, {
                environment: developmentTestEnvironment,
                resolveSourceCommit: () => Promise.resolve(sourceCommit),
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
        const commands: Array<readonly string[]> = [];
        let resolveStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        let spawnCalls = 0;

        try {
            const running = runDevelopmentStack(config, {
                environment: developmentTestEnvironment,
                resolveSourceCommit: () => Promise.resolve(sourceCommit),
                spawn(command) {
                    commands.push(command);
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
            expect(commands).toEqual([
                [process.execPath, "--watch", "src/app/developmentWeb.ts", sourceCommit],
                [
                    process.execPath,
                    "--watch",
                    "src/app/developmentWorker.ts",
                    sourceCommit,
                ],
                [process.execPath, "scripts/developmentFrontend.ts"],
            ]);
            await expectLeaseReleased(config);
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("repairs a watched-child migration failure by resetting SQLite and restarting every child", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-runtime-migration-")
        );
        const sourceRoot = path.join(temporaryRoot, "source");
        const initialSql = "CREATE TABLE runtime_one (id INTEGER PRIMARY KEY);\n";
        const changedSql = "CREATE TABLE runtime_two (id INTEGER PRIMARY KEY);\n";
        await writeRuntimeMigrationFixture(sourceRoot, initialSql);
        const config = await runtimeConfig(temporaryRoot, sourceRoot);
        const initialFingerprint = await readDevelopmentMigrationIdentity(sourceRoot);
        const firstWeb = fakeChild();
        const firstWorker = fakeChild();
        const firstFrontend = fakeChild();
        const secondWeb = fakeChild();
        const secondWorker = fakeChild();
        const secondFrontend = fakeChild();
        const children = [
            firstWeb,
            firstWorker,
            firstFrontend,
            secondWeb,
            secondWorker,
            secondFrontend,
        ];
        const commands: Array<readonly string[]> = [];
        let resolveFirstStarted!: () => void;
        let resolveSecondStarted!: () => void;
        const firstStarted = new Promise<void>((resolve) => {
            resolveFirstStarted = resolve;
        });
        const secondStarted = new Promise<void>((resolve) => {
            resolveSecondStarted = resolve;
        });
        let spawnCalls = 0;
        let running: Promise<number> | undefined;

        try {
            running = runDevelopmentStack(config, {
                environment: developmentTestEnvironment,
                resolveSourceCommit: () => Promise.resolve(sourceCommit),
                spawn(command) {
                    commands.push(command);
                    const next = children[spawnCalls];
                    spawnCalls += 1;
                    if (spawnCalls === 3) resolveFirstStarted();
                    if (spawnCalls === 6) resolveSecondStarted();
                    if (next === undefined) throw new Error("Unexpected child spawn");
                    return next.child;
                },
            });
            await Promise.race([
                firstStarted,
                Bun.sleep(5000).then(() => {
                    throw new Error("Initial development children did not start");
                }),
            ]);
            await Promise.all([
                writeFile(config.databasePath, "stale database", { mode: 0o600 }),
                writeFile(`${config.databasePath}-wal`, "stale sidecar", { mode: 0o600 }),
            ]);

            const migrationPath = path.join(
                sourceRoot,
                "migrations",
                runtimeMigrationId,
                "migration.sql"
            );
            await writeFile(migrationPath, changedSql, "utf8");
            firstWeb.exit(1);
            await Bun.sleep(150);
            await writeFile(
                path.join(sourceRoot, "src", "shared", "databaseMigrationManifest.ts"),
                runtimeMigrationManifest(changedSql),
                "utf8"
            );

            await Promise.race([
                secondStarted,
                Bun.sleep(5000).then(() => {
                    throw new Error("Development children did not recover");
                }),
            ]);
            expect(firstWeb.signals).toEqual([]);
            expect(firstWorker.signals).toEqual(["SIGTERM"]);
            expect(firstFrontend.signals).toEqual(["SIGTERM"]);
            expect(commands).toHaveLength(6);
            expect(commands[3]).toEqual([
                process.execPath,
                "--watch",
                "src/app/developmentWeb.ts",
                sourceCommit,
            ]);
            expect(await Bun.file(config.databasePath).exists()).toBeFalse();
            expect(await Bun.file(`${config.databasePath}-wal`).exists()).toBeFalse();
            const expectedFingerprint =
                await readDevelopmentMigrationIdentity(sourceRoot);
            const marker = JSON.parse(
                await readFile(
                    path.join(
                        config.stateRoot,
                        ".mira-dashboard-development-database.json"
                    ),
                    "utf8"
                )
            ) as { migrationFingerprint?: unknown };
            expect(marker.migrationFingerprint).toBe(expectedFingerprint);
            expect(marker.migrationFingerprint).not.toBe(initialFingerprint);

            secondWeb.exit(7);
            expect(await running).toBe(7);
            expect(secondWorker.signals).toEqual(["SIGTERM"]);
            expect(secondFrontend.signals).toEqual(["SIGTERM"]);
            await expectLeaseReleased(config);
        } finally {
            for (const child of children) child.exit(0);
            await running?.catch(() => {});
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    test("escalates from SIGTERM to SIGKILL after the shutdown deadline", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-runtime-force-")
        );
        const config = await runtimeConfig(temporaryRoot);
        const web = fakeChild();
        const worker = fakeChild({ ignoreSigterm: true });
        const frontend = fakeChild();
        const children = [web, worker, frontend];
        let resolveStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        let spawnCalls = 0;
        let running: Promise<number> | undefined;

        try {
            running = runDevelopmentStack(config, {
                environment: developmentTestEnvironment,
                resolveSourceCommit: () => Promise.resolve(sourceCommit),
                spawn() {
                    const next = children[spawnCalls];
                    spawnCalls += 1;
                    if (spawnCalls === children.length) resolveStarted();
                    if (next === undefined) throw new Error("Unexpected child spawn");
                    return next.child;
                },
            });
            await started;
            jest.useFakeTimers();

            web.exit(7);
            expect(await worker.firstSignal).toBe("SIGTERM");
            jest.advanceTimersByTime(10_000);

            expect(await running).toBe(7);
            expect(worker.signals).toEqual(["SIGTERM", "SIGKILL"]);
            await expectLeaseReleased(config);
        } finally {
            for (const child of children) child.exit(0);
            await running?.catch(() => {});
            jest.useRealTimers();
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });
});
