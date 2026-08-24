import { describe, expect, test } from "bun:test";

import { rejectionError } from "../../../scripts/testSupport/rejection.ts";
import type { PreviewGatewayBrokerOptions } from "./previewGatewayBroker.ts";
import {
    buildPreviewIngressSpecification,
    buildPreviewLaunchSpecification,
} from "./previewSandbox.ts";
import {
    createPreviewSystemdRuntime,
    type PreviewSystemdProcessRequest,
    type PreviewSystemdProcessResult,
} from "./previewSystemdRuntime.ts";

const operationId = "019fd974-54a2-74dd-a64b-d4186f8d8801";
const runtimeUserId = 1234;
const emptyResult: PreviewSystemdProcessResult = Object.freeze({
    exitCode: 0,
    stderr: new Uint8Array(),
    stdout: new Uint8Array(),
});

function unitResult(
    activeState: string,
    subState: string,
    result = "success"
): PreviewSystemdProcessResult {
    return Object.freeze({
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode(
            `ActiveState=${activeState}\nSubState=${subState}\nResult=${result}\n`
        ),
    });
}

function launchSpecification() {
    return buildPreviewLaunchSpecification(
        {
            bunExecutable: "/opt/mira/runtime/bun",
            capabilitySocket: "/srv/mira-preview/gateways/pr-42/gateway.sock",
            expectedHeadSha: "b".repeat(40),
            operationId,
            publicOrigin: "https://preview.example.test",
            stateRoot: "/srv/mira-preview/states/pr-42",
            worktreePath: "/srv/mira-preview/worktrees/pr-42",
        },
        runtimeUserId
    );
}

function ingressSpecification() {
    return buildPreviewIngressSpecification({
        listenUnixSocket: "/run/user/1234/mira-preview.sock",
        operationId,
        previewPort: 5173,
    });
}

function gatewaySpecification() {
    return {
        allowedOperations: ["chat-history", "chat-send", "session-status"] as const,
        bodyMaximumBytes: 64 * 1024,
        capability: "a".repeat(43),
        requestDeadlineMs: 10_000,
        socketMode: 0o600 as const,
        socketPath: "/srv/mira-preview/gateways/pr-42/gateway.sock",
    };
}

function gatewayDependencies() {
    return {
        gatewayPort: {
            invoke: () => Promise.resolve({ body: new Uint8Array() }),
        },
        startGatewayBroker(options: PreviewGatewayBrokerOptions) {
            return Promise.resolve({
                operationId: options.operationId,
                socketPath: options.specification.socketPath,
                stop: () => Promise.resolve(),
            });
        },
        ingressReadinessProbe: () => Promise.resolve(true),
    };
}

describe("preview systemd runtime", () => {
    test("starts, inspects, and idempotently stops one exact preview unit", async () => {
        const requests: PreviewSystemdProcessRequest[] = [];
        let active = false;
        const runtime = createPreviewSystemdRuntime({
            ...gatewayDependencies(),
            processRunner(request) {
                requests.push(request);
                if (request.command[0] === "/usr/bin/systemd-run") {
                    active = true;
                    return Promise.resolve(emptyResult);
                }
                if (request.command.includes("show")) {
                    return Promise.resolve(
                        active
                            ? unitResult("active", "running")
                            : unitResult("inactive", "dead")
                    );
                }
                if (request.command.includes("stop")) {
                    active = false;
                    return Promise.resolve(emptyResult);
                }
                throw new Error("unexpected command");
            },
            runtimeUserId,
        });
        const specification = launchSpecification();

        await runtime.start(specification, gatewaySpecification());
        expect(await runtime.inspect(specification.unitName)).toEqual({
            active: true,
            ready: true,
            result: undefined,
        });
        await runtime.stop(specification.unitName);
        await runtime.stop(specification.unitName);

        expect(requests.filter(({ command }) => command.includes("stop"))).toHaveLength(
            1
        );
        expect(requests[0]?.command).toEqual(specification.argv);
        expect(requests[0]?.environment).toEqual({
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1234/bus",
            HOME: "/nonexistent",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            PATH: "/usr/bin:/bin",
            XDG_RUNTIME_DIR: "/run/user/1234",
        });
        expect(JSON.stringify(requests)).not.toContain("TOKEN");
    });

    test("starts the socket-activated ingress joined to the exact preview namespace", async () => {
        const requests: PreviewSystemdProcessRequest[] = [];
        const readinessSockets: string[] = [];
        const runtime = createPreviewSystemdRuntime({
            ...gatewayDependencies(),
            ingressReadinessProbe(socketPath) {
                readinessSockets.push(socketPath);
                return Promise.resolve(true);
            },
            processRunner(request) {
                requests.push(request);
                if (request.command.includes("show")) {
                    return Promise.resolve(
                        request.command.some((argument) => argument.endsWith(".socket"))
                            ? unitResult("active", "listening")
                            : unitResult("active", "running")
                    );
                }
                return Promise.resolve(emptyResult);
            },
            runtimeUserId,
        });
        const specification = ingressSpecification();

        await runtime.ingress.start(specification);
        await runtime.ingress.stop(specification);

        const launch = requests[0]?.command ?? [];
        expect(launch).toContain(
            `--property=JoinsNamespaceOf=mira-dashboard-preview-${operationId}.service`
        );
        expect(launch).toContain(
            "--socket-property=ListenStream=/run/user/1234/mira-preview.sock"
        );
        expect(launch).toContain("--socket-property=SocketMode=0600");
        expect(launch).toContain("/usr/lib/systemd/systemd-socket-proxyd");
        expect(launch).toContain("--connections-max=16");
        expect(readinessSockets).toEqual([specification.listenUnixSocket]);
        expect(requests.some(({ command }) => command.includes("/bin/sh"))).toBe(false);
    });

    test("fails closed before execution for a forged unit or ambient environment", async () => {
        let calls = 0;
        const runtime = createPreviewSystemdRuntime({
            ...gatewayDependencies(),
            processRunner() {
                calls += 1;
                return Promise.resolve(emptyResult);
            },
            runtimeUserId,
        });
        const specification = launchSpecification();
        const forged = {
            ...specification,
            environment: { ...specification.environment, GITHUB_TOKEN: "secret" },
        };

        const error = await rejectionError(runtime.start(forged, gatewaySpecification()));
        expect(error).toMatchObject({ reason: "operation-failed" });
        expect(calls).toBe(0);

        expect(await rejectionError(runtime.inspect("other.service"))).toMatchObject({
            reason: "operation-failed",
        });
        expect(calls).toBe(0);
    });

    test("does not expose bounded systemd diagnostics", async () => {
        const runtime = createPreviewSystemdRuntime({
            ...gatewayDependencies(),
            processRunner() {
                return Promise.resolve({
                    exitCode: 1,
                    stderr: new TextEncoder().encode("secret upstream diagnostic"),
                    stdout: new Uint8Array(),
                });
            },
            runtimeUserId,
        });

        const error = await rejectionError(
            runtime.start(launchSpecification(), gatewaySpecification())
        );
        expect(error).toMatchObject({ reason: "operation-failed" });
        expect(JSON.stringify(error)).not.toContain("secret upstream diagnostic");
    });
});
