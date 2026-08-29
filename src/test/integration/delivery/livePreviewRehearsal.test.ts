import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import { Redacted } from "effect";

import {
    startPreviewGatewayBroker,
    type PreviewGatewayBroker,
} from "../../../worker/delivery/previewGatewayBroker.ts";
import { createPreviewHost } from "../../../worker/delivery/previewHost.ts";
import { createPreviewSystemdRuntime } from "../../../worker/delivery/previewSystemdRuntime.ts";
import type { PreviewProcessRequest } from "../../../worker/delivery/previewWorktree.ts";

const sourceRoot = path.resolve(import.meta.dir, "../../../..");
const operationId = "019fd974-54a2-74dd-a64b-d4186f8d8801";
const roots: string[] = [];
const livePreviewAvailable =
    typeof process.getuid === "function" &&
    existsSync("/usr/bin/bwrap") &&
    existsSync("/usr/bin/systemctl") &&
    existsSync(`/run/user/${String(process.getuid())}/bus`);

async function run(
    executable: string,
    arguments_: readonly string[],
    options: {
        readonly cwd?: string;
        readonly env?: Readonly<Record<string, string>>;
    } = {}
) {
    const child = Bun.spawn([executable, ...arguments_], {
        cwd: options.cwd,
        env: options.env,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr, stdout };
}

afterAll(async () => {
    await run("/usr/bin/systemctl", [
        "--user",
        "stop",
        `mira-dashboard-preview-ingress-${operationId}.socket`,
        `mira-dashboard-preview-ingress-${operationId}.service`,
        `mira-dashboard-preview-${operationId}.service`,
    ]).catch(() => {});
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

describe("live managed Preview rehearsal", () => {
    test.skipIf(!livePreviewAvailable)(
        "creates a real worktree, installs, starts, reaches readiness, rebuilds, stops, and cleans up",
        async () => {
            // Unix domain sockets have a short kernel path limit. Keep the live
            // systemd/Bubblewrap fixture independent of nested coverage TMPDIRs.
            const root = await mkdtemp("/tmp/mp-e2e-");
            roots.push(root);
            const checkoutRoot = path.join(root, "checkout");
            const clone = await run("/usr/bin/git", [
                "clone",
                "--local",
                "--no-hardlinks",
                sourceRoot,
                checkoutRoot,
            ]);
            expect(clone.exitCode, clone.stderr).toBe(0);
            const headResult = await run("/usr/bin/git", [
                "-C",
                checkoutRoot,
                "rev-parse",
                "HEAD",
            ]);
            expect(headResult.exitCode, headResult.stderr).toBe(0);
            const head = headResult.stdout.trim();
            const processRunner = async (request: PreviewProcessRequest) => {
                if (request.arguments.includes("fetch")) {
                    const destination = request.arguments.at(-1)?.split(":").at(-1);
                    if (destination === undefined) throw new Error("Missing preview ref");
                    return run("/usr/bin/git", [
                        "-C",
                        checkoutRoot,
                        "update-ref",
                        destination,
                        head,
                    ]);
                }
                return run(request.executable, request.arguments, {
                    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                    env: request.environment,
                });
            };
            const ingressSocket = path.join(root, "preview", "ingress", "preview.sock");
            let published = false;
            const origin = "https://preview.example.test:3445";
            const hostConfiguration = {
                bunExecutable: process.execPath,
                checkoutRoot,
                ingressSocket,
                previewRoot: path.join(root, "preview"),
            } as const;
            let activeGatewayBroker: PreviewGatewayBroker | undefined;
            const createHost = () =>
                createPreviewHost(hostConfiguration, {
                    credentials: {
                        token: Redacted.make("fixture-token", {
                            label: "preview-rehearsal",
                        }),
                    },
                    processRunner,
                    runtime: createPreviewSystemdRuntime({
                        gatewayPort: {
                            invoke: () => Promise.resolve({ body: new Uint8Array() }),
                        },
                        startGatewayBroker: async (options) => {
                            const broker = await startPreviewGatewayBroker(options);
                            activeGatewayBroker = broker;
                            return broker;
                        },
                    }),
                    scope: {
                        confirmClosedOrMerged: () => Promise.resolve(true),
                        readScope: () =>
                            Promise.resolve({
                                expectedHeads: [{ headSha: head, number: 42 }],
                                mainRooted: true,
                                open: true,
                                trustedAuthors: true,
                            }),
                    },
                    tailscale: {
                        inspect: () =>
                            Promise.resolve({
                                enabled: published,
                                origin,
                                target: `unix:${ingressSocket}`,
                            }),
                        start: async (_socket, _origin, beforeMutation) => {
                            await beforeMutation();
                            published = true;
                            return {
                                enabled: true,
                                origin,
                                target: `unix:${ingressSocket}`,
                            };
                        },
                        stopOwned: () => {
                            published = false;
                            return Promise.resolve({
                                enabled: false,
                                origin,
                                target: `unix:${ingressSocket}`,
                            });
                        },
                    },
                });
            let host = createHost();
            const request = {
                expectedHeads: [{ headSha: head, number: 42 }],
                number: 42,
                operationId,
                previewRevision: "a".repeat(64),
                title: "Live Preview rehearsal",
            };

            const first = await host.start(request);
            expect(first.status).toMatchObject({ number: 42, status: "running" });
            await activeGatewayBroker?.stop();
            host = createHost();
            expect(await host.reconcile()).toMatchObject({
                number: 42,
                status: "running",
            });
            const dashboard = await run("/usr/bin/curl", [
                "--fail",
                "--silent",
                "--show-error",
                "--noproxy",
                "*",
                "--unix-socket",
                ingressSocket,
                "--header",
                "Host: preview.example.test:3445",
                "http://127.0.0.1/",
            ]);
            expect(dashboard.exitCode, dashboard.stderr).toBe(0);
            expect(dashboard.stdout).toContain("<html");
            const readiness = await run("/usr/bin/curl", [
                "--fail",
                "--silent",
                "--show-error",
                "--noproxy",
                "*",
                "--unix-socket",
                ingressSocket,
                "--header",
                "Host: preview.example.test:3445",
                "http://127.0.0.1/api/health/ready",
            ]);
            expect(readiness.exitCode, readiness.stderr).toBe(0);
            await host.stop({
                number: 42,
                operationId: Bun.randomUUIDv7(),
                previewRevision: request.previewRevision,
            });
            const rebuilt = await host.start({
                ...request,
                operationId: Bun.randomUUIDv7(),
                previewRevision: "b".repeat(64),
            });
            expect(rebuilt.status.status).toBe("running");
            await host.stop({
                number: 42,
                operationId: Bun.randomUUIDv7(),
                previewRevision: "b".repeat(64),
            });
            expect(
                await host.cleanupConfirmed({
                    expectedHeadSha: head,
                    number: 42,
                    operationId: Bun.randomUUIDv7(),
                })
            ).toBeTrue();
        },
        10 * 60_000
    );
});
