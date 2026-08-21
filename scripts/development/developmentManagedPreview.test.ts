import { describe, expect, test } from "bun:test";
import path from "node:path";

import { managedPreviewProcessEnvironments } from "./developmentEnvironment.ts";
import {
    type DevelopmentChildProcess,
    runManagedPreviewStackWithPreparedState,
} from "./developmentRuntime.ts";
import { resolveManagedPreviewStackConfig } from "./developmentStackConfig.ts";
import type { PreparedDevelopmentStateSession } from "./developmentState.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const sourceCommit = "b".repeat(40);
const gatewaySocket = "/run/mira-preview/gateway/gateway.sock";

function config() {
    return resolveManagedPreviewStackConfig(
        {
            MIRA_DASHBOARD_DEV_GATEWAY_SOCKET: gatewaySocket,
            MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "https://preview.example.test",
            MIRA_DASHBOARD_DEV_STATE_ROOT: "/state",
        },
        repositoryRoot
    );
}

function child() {
    let code: number | null = null;
    let settle!: (exitCode: number) => void;
    const exited = new Promise<number>((resolve) => {
        settle = resolve;
    });
    const signals: Array<number | NodeJS.Signals | undefined> = [];
    const process: DevelopmentChildProcess = {
        exited,
        get exitCode() {
            return code;
        },
        kill(signal) {
            signals.push(signal);
            finish(0);
        },
    };
    const finish = (exitCode: number) => {
        if (code !== null) return;
        code = exitCode;
        settle(exitCode);
    };
    return { finish, process, signals };
}

describe("managed preview development profile", () => {
    test("derives fixed ports and credential-free child environments", () => {
        const resolved = config();
        const environments = managedPreviewProcessEnvironments(
            resolved,
            "isolated-preview-keyring"
        );

        expect(resolved).toMatchObject({
            backendPort: 3206,
            frontendPort: 3205,
            gatewaySocket,
            hotReload: false,
            publicOrigin: "https://preview.example.test",
            remoteProxyPort: 3207,
            stateRoot: "/state",
            tailscalePort: 3445,
        });
        expect(environments.web.OPENCLAW_GATEWAY_TOKEN).toBe(
            "managed-preview-no-bearer-credential"
        );
        expect(environments.worker.MOLTBOOK_API_KEY).toBe(
            "managed-preview-no-moltbook-credential"
        );
        const names = Object.keys({ ...environments.web, ...environments.worker });
        expect(
            names.some((name) => /(?:DATABASE|DOCKER|DOPPLER|GITHUB|RAJOHAN)/u.test(name))
        ).toBeFalse();
        expect(() =>
            resolveManagedPreviewStackConfig(
                {
                    MIRA_DASHBOARD_DEV_GATEWAY_SOCKET:
                        "/run/mira-preview/gateway/nested/gateway.sock",
                    MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: "https://preview.example.test",
                    MIRA_DASHBOARD_DEV_STATE_ROOT: "/state",
                },
                repositoryRoot
            )
        ).toThrow("Managed preview configuration is invalid");
    });

    test("starts exact no-watch children and couples their shutdown", async () => {
        const resolved = config();
        const web = child();
        const worker = child();
        const frontend = child();
        const children = [web, worker, frontend];
        const commands: Array<readonly string[]> = [];
        const environments: Array<Readonly<Record<string, string>>> = [];
        let spawnIndex = 0;
        const session: PreparedDevelopmentStateSession = {
            migrationFingerprint: "a".repeat(64),
            refresh: () => Promise.reject(new Error("Unexpected state refresh")),
            release: () => Promise.resolve(),
            state: {
                database: "reused",
                keyring: "isolated-preview-keyring",
                stateDirectory: "/state/production/state",
            },
        };

        const running = runManagedPreviewStackWithPreparedState(
            resolved,
            session,
            sourceCommit,
            gatewaySocket,
            {
                observeMigrationIdentity: () => ({
                    changed: new Promise(() => {}),
                    close() {},
                    ready: Promise.resolve(undefined),
                }),
                readMigrationIdentity: () => Promise.resolve("a".repeat(64)),
                resolveSourceCommit: () => Promise.resolve(sourceCommit),
                spawn(command, options) {
                    commands.push(command);
                    environments.push(options.env);
                    const next = children[spawnIndex];
                    spawnIndex += 1;
                    if (next === undefined) throw new Error("Unexpected child spawn");
                    if (spawnIndex === children.length) web.finish(7);
                    return next.process;
                },
            }
        );

        expect(await running).toBe(7);
        expect(commands).toEqual([
            [
                process.execPath,
                "src/app/developmentWeb.ts",
                sourceCommit,
                "--managed-preview",
                gatewaySocket,
            ],
            [
                process.execPath,
                "src/app/developmentWorker.ts",
                sourceCommit,
                "--managed-preview",
                gatewaySocket,
            ],
            [process.execPath, "scripts/developmentFrontend.ts"],
        ]);
        expect(commands.flat()).not.toContain("--watch");
        expect(worker.signals).toEqual(["SIGTERM"]);
        expect(frontend.signals).toEqual(["SIGTERM"]);
        expect(JSON.stringify(environments)).not.toContain("GITHUB_TOKEN");
        expect(JSON.stringify(environments)).not.toContain("DOPPLER");
    });
});
