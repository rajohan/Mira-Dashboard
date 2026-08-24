import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Redacted } from "effect";

import { rejectionError } from "../../../scripts/testSupport/rejection.ts";
import { createPreviewHost, type PreviewRuntimePort } from "./previewHost.ts";
import type { PreviewProcessRequest } from "./previewWorktree.ts";

const firstOperation = "018f1f0e-7c52-7d63-8f22-b5f776933127";
const secondOperation = "018f1f0e-7c52-7d63-8f22-b5f776933128";
const head = "b".repeat(40);
const revision = "a".repeat(64);

function request(number = 42, operationId = firstOperation) {
    return {
        expectedHeads: [{ headSha: head, number }],
        number,
        operationId,
        previewRevision: revision,
        title: `PR ${number}`,
    };
}

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "mira-preview-host-"));
    const checkoutRoot = path.join(root, "checkout");
    const previewRoot = path.join(root, "preview");
    await mkdir(path.join(checkoutRoot, ".git", "worktrees"), {
        recursive: true,
    });
    let nowMs = 1000;
    let activeUnit: string | null = null;
    let gatewayBound = false;
    const gatewayBinds: string[] = [];
    const ingressStarts: string[] = [];
    const ingressStops: string[] = [];
    const tailscaleStarts: string[] = [];
    const tailscaleStops: string[] = [];
    const stops: string[] = [];
    let tailscaleEnabled = false;
    let confirmClosed = true;
    let confirmCalls = 0;
    const runtime: PreviewRuntimePort = {
        bindGateway: (unitName) => {
            gatewayBound = true;
            gatewayBinds.push(unitName);
            return Promise.resolve();
        },
        ingress: {
            start: (specification) => {
                ingressStarts.push(specification.socketUnitName);
                return Promise.resolve();
            },
            stop: (specification) => {
                ingressStops.push(specification.socketUnitName);
                return Promise.resolve();
            },
        },
        inspect: (unitName) =>
            Promise.resolve({
                active: activeUnit === unitName,
                ready: activeUnit === unitName && gatewayBound,
            }),
        start: (specification) => {
            activeUnit = specification.unitName;
            gatewayBound = true;
            return Promise.resolve();
        },
        stop: (unitName) => {
            stops.push(unitName);
            if (activeUnit === unitName) activeUnit = null;
            gatewayBound = false;
            return Promise.resolve();
        },
    };
    const processRunner = async (processRequest: PreviewProcessRequest) => {
        if (
            processRequest.arguments.includes("worktree") &&
            processRequest.arguments.includes("add")
        ) {
            const addIndex = processRequest.arguments.indexOf("add");
            const worktreePath = processRequest.arguments[addIndex + 2]!;
            const admin = path.join(
                checkoutRoot,
                ".git",
                "worktrees",
                path.basename(worktreePath)
            );
            await mkdir(admin, { recursive: true });
            await mkdir(worktreePath, { recursive: true });
            await writeFile(path.join(worktreePath, ".git"), `gitdir: ${admin}\n`);
            await writeFile(
                path.join(admin, "gitdir"),
                `${path.join(worktreePath, ".git")}\n`
            );
        }
        if (processRequest.arguments.includes("rev-parse")) {
            return { exitCode: 0, stderr: "", stdout: `${head}\n` };
        }
        if (
            processRequest.arguments.includes("worktree") &&
            processRequest.arguments.includes("remove")
        ) {
            const worktreePath = processRequest.arguments.at(-1)!;
            await rm(worktreePath, { force: true, recursive: true });
            await rm(
                path.join(checkoutRoot, ".git", "worktrees", path.basename(worktreePath)),
                { force: true, recursive: true }
            );
        }
        return { exitCode: 0, stderr: "", stdout: "" };
    };
    const host = createPreviewHost(
        {
            bunExecutable: "/opt/mira/runtime/bun",
            checkoutRoot,
            ingressSocket: path.join(root, "ingress.sock"),
            previewRoot,
        },
        {
            clock: () => nowMs,
            credentials: {
                token: Redacted.make("token", { label: "test-preview-token" }),
            },
            processRunner,
            runtime,
            scope: {
                confirmClosedOrMerged: (_number, expectedHead) => {
                    confirmCalls += 1;
                    return Promise.resolve(confirmClosed && expectedHead === head);
                },
                readScope: (number) =>
                    Promise.resolve({
                        expectedHeads: [{ headSha: head, number }],
                        mainRooted: true,
                        open: true,
                        trustedAuthors: true,
                    }),
            },
            tailscale: {
                inspect: (socketPath) =>
                    Promise.resolve({
                        enabled: tailscaleEnabled,
                        origin: "https://preview.example.test:3445",
                        target: `unix:${socketPath}`,
                    }),
                start: async (socketPath, _origin, beforeMutation) => {
                    await beforeMutation();
                    tailscaleEnabled = true;
                    tailscaleStarts.push(socketPath);
                    return {
                        enabled: true,
                        origin: "https://preview.example.test:3445",
                        target: `unix:${socketPath}`,
                    };
                },
                stopOwned: (socketPath) => {
                    tailscaleEnabled = false;
                    tailscaleStops.push(socketPath);
                    return Promise.resolve({
                        enabled: false,
                        origin: "https://preview.example.test:3445",
                        target: `unix:${socketPath}`,
                    });
                },
            },
        }
    );
    return {
        advance: (milliseconds: number) => {
            nowMs += milliseconds;
        },
        confirmCalls: () => confirmCalls,
        host,
        gatewayBinds,
        ingressStarts,
        ingressStops,
        loseGateway: () => {
            gatewayBound = false;
        },
        previewRoot,
        setConfirmClosed: (value: boolean) => {
            confirmClosed = value;
        },
        remove: () => rm(root, { force: true, recursive: true }),
        stops,
        tailscaleStarts,
        tailscaleStops,
    };
}

describe("preview host", () => {
    test("serializes one global slot and keeps exact idempotent start", async () => {
        const context = await fixture();
        try {
            const [first, second] = await Promise.all([
                context.host.start(request()),
                context.host.start(request()),
            ]);
            expect(first.status.status).toBe("running");
            expect(first.status.url).toBe("https://preview.example.test:3445");
            expect(second.status.status).toBe("running");
            expect(context.ingressStarts).toEqual([
                `mira-dashboard-preview-ingress-${firstOperation}.socket`,
            ]);
            expect(context.tailscaleStarts).toHaveLength(1);

            expect(
                await rejectionError(context.host.start(request(43, secondOperation)))
            ).toMatchObject({
                reason: "slot-conflict",
            });
        } finally {
            await context.remove();
        }
    });

    test("stop retains checkout/state and confirmed close removes them", async () => {
        const context = await fixture();
        try {
            await context.host.start(request());
            const stopped = await context.host.stop({
                number: 42,
                operationId: secondOperation,
                previewRevision: revision,
            });
            expect(stopped.status).toBe("stopped");
            expect(context.ingressStops).toContain(
                `mira-dashboard-preview-ingress-${firstOperation}.socket`
            );
            expect(context.tailscaleStops).toHaveLength(1);
            expect(
                await Bun.file(
                    path.join(context.previewRoot, "worktrees", "pr-42", ".git")
                ).exists()
            ).toBeTrue();
            expect(
                await Bun.file(
                    path.join(context.previewRoot, "active-preview.json")
                ).exists()
            ).toBeTrue();

            await context.host.cleanupConfirmed({
                expectedHeadSha: head,
                number: 42,
                operationId: firstOperation,
            });
            expect(
                await Bun.file(
                    path.join(context.previewRoot, "active-preview.json")
                ).exists()
            ).toBeFalse();
            expect(
                await Bun.file(
                    path.join(context.previewRoot, "worktrees", "pr-42", ".git")
                ).exists()
            ).toBeFalse();
        } finally {
            await context.remove();
        }
    });

    test("keeps stopped per-PR checkout when another PR takes the runtime slot", async () => {
        const context = await fixture();
        try {
            await context.host.start(request());
            await context.host.stop({
                number: 42,
                operationId: secondOperation,
                previewRevision: revision,
            });
            await context.host.start(request(43, secondOperation));

            const firstWorktree = path.join(
                context.previewRoot,
                "worktrees",
                "pr-42",
                ".git"
            );
            const secondWorktree = path.join(
                context.previewRoot,
                "worktrees",
                "pr-43",
                ".git"
            );
            expect(await Bun.file(firstWorktree).exists()).toBeTrue();
            expect(await Bun.file(secondWorktree).exists()).toBeTrue();

            await context.host.cleanupConfirmed({
                expectedHeadSha: head,
                number: 42,
                operationId: firstOperation,
            });
            expect(await Bun.file(firstWorktree).exists()).toBeFalse();
            expect(await Bun.file(secondWorktree).exists()).toBeTrue();
            const active = await context.host.status();
            expect(active.number).toBe(43);
            expect(active.status).toBe("running");
        } finally {
            await context.remove();
        }
    });

    test("reconciliation stops an expired runtime but retains rebuild data", async () => {
        const context = await fixture();
        try {
            await context.host.start(request());
            context.advance(4 * 60 * 60 * 1000 + 1);
            const status = await context.host.reconcile();
            expect(status.status).toBe("stopped");
            expect(context.stops).toContain(
                `mira-dashboard-preview-${firstOperation}.service`
            );
            expect(
                await Bun.file(
                    path.join(context.previewRoot, "worktrees", "pr-42", ".git")
                ).exists()
            ).toBeTrue();
        } finally {
            await context.remove();
        }
    });

    test("reconciliation rebinds the capability after a worker restart", async () => {
        const context = await fixture();
        try {
            await context.host.start(request());
            context.loseGateway();

            const status = await context.host.reconcile();
            expect(status.status).toBe("running");
            expect(context.gatewayBinds).toEqual([
                `mira-dashboard-preview-${firstOperation}.service`,
            ]);
        } finally {
            await context.remove();
        }
    });

    test("reconciliation removes at most one confirmed closed retained PR", async () => {
        const context = await fixture();
        try {
            await context.host.start(request());
            await context.host.stop({
                number: 42,
                operationId: secondOperation,
                previewRevision: revision,
            });
            context.advance(6 * 60 * 60 * 1000 + 1);

            const status = await context.host.reconcile();
            expect(status.status).toBe("stopped");
            expect(
                await Bun.file(
                    path.join(
                        context.previewRoot,
                        "states",
                        "pr-42",
                        ".mira-dashboard-development-state.json"
                    )
                ).exists()
            ).toBeFalse();
            expect(
                await Bun.file(
                    path.join(context.previewRoot, "owners", "pr-42.json")
                ).exists()
            ).toBeFalse();
        } finally {
            await context.remove();
        }
    });

    test("provider non-confirmation retains state and delays its next bounded check", async () => {
        const context = await fixture();
        try {
            context.setConfirmClosed(false);
            await context.host.start(request());
            await context.host.stop({
                number: 42,
                operationId: secondOperation,
                previewRevision: revision,
            });
            context.advance(6 * 60 * 60 * 1000 + 1);
            const status = await context.host.reconcile();
            expect(status.status).toBe("stopped");
            expect(context.confirmCalls()).toBe(1);
            context.advance(60_000);
            await context.host.reconcile();
            expect(context.confirmCalls()).toBe(1);
            expect(
                await Bun.file(
                    path.join(
                        context.previewRoot,
                        "states",
                        "pr-42",
                        ".mira-dashboard-development-state.json"
                    )
                ).exists()
            ).toBeTrue();
        } finally {
            await context.remove();
        }
    });

    test("fails closed when exact ordered stack membership drifts", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mira-preview-scope-"));
        const checkoutRoot = path.join(root, "checkout");
        await mkdir(checkoutRoot);
        const host = createPreviewHost(
            {
                bunExecutable: "/opt/mira/runtime/bun",
                checkoutRoot,
                ingressSocket: path.join(root, "ingress.sock"),
                previewRoot: path.join(root, "preview"),
            },
            {
                credentials: {
                    token: Redacted.make("token", {
                        label: "test-preview-token",
                    }),
                },
                runtime: {
                    bindGateway: () => Promise.resolve(),
                    ingress: {
                        start: () => Promise.resolve(),
                        stop: () => Promise.resolve(),
                    },
                    inspect: () => Promise.resolve({ active: false, ready: false }),
                    start: () => Promise.resolve(),
                    stop: () => Promise.resolve(),
                },
                scope: {
                    confirmClosedOrMerged: () => Promise.resolve(false),
                    readScope: () =>
                        Promise.resolve({
                            expectedHeads: [{ headSha: "c".repeat(40), number: 42 }],
                            mainRooted: true,
                            open: true,
                            trustedAuthors: true,
                        }),
                },
                tailscale: {
                    inspect: (socketPath) =>
                        Promise.resolve({
                            enabled: false,
                            origin: "https://preview.example.test:3445",
                            target: `unix:${socketPath}`,
                        }),
                    start: () => Promise.reject(new Error("unused")),
                    stopOwned: (socketPath) =>
                        Promise.resolve({
                            enabled: false,
                            origin: "https://preview.example.test:3445",
                            target: `unix:${socketPath}`,
                        }),
                },
            }
        );
        try {
            expect(await rejectionError(host.start(request()))).toMatchObject({
                reason: "scope-changed",
            });
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});
