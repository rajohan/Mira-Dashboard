import path from "node:path";

import { PreviewHostError } from "./previewTypes.ts";

const bwrapExecutable = "/usr/bin/bwrap";
const systemdRunExecutable = "/usr/bin/systemd-run";
const systemdSocketProxydExecutable = "/usr/lib/systemd/systemd-socket-proxyd";
const previewMemoryMaximumBytes = 2 * 1024 * 1024 * 1024;
const previewTasksMaximum = 256;

export interface PreviewSandboxInput {
    readonly bunExecutable: string;
    readonly capabilitySocket: string;
    readonly operationId: string;
    readonly publicOrigin: string;
    readonly stateRoot: string;
    readonly expectedHeadSha: string;
    readonly worktreePath: string;
}

export interface PreviewLaunchSpecification {
    readonly argv: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly unitName: string;
}

export interface PreviewIngressSpecification {
    readonly argv: readonly string[];
    readonly listenUnixSocket: string;
    readonly serviceUnitName: string;
    readonly socketUnitName: string;
}

function fail(): never {
    throw new PreviewHostError({ reason: "invalid-request" });
}

function assertAbsoluteNormalized(value: string): void {
    if (
        !path.isAbsolute(value) ||
        path.normalize(value) !== value ||
        value.includes("\0")
    ) {
        fail();
    }
}

function unitSuffix(operationId: string): string {
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            operationId
        )
    ) {
        fail();
    }
    return operationId;
}

function sandboxCommand(input: PreviewSandboxInput): readonly string[] {
    assertAbsoluteNormalized(input.worktreePath);
    assertAbsoluteNormalized(input.stateRoot);
    assertAbsoluteNormalized(input.capabilitySocket);
    assertAbsoluteNormalized(input.bunExecutable);
    let origin: URL;
    try {
        origin = new URL(input.publicOrigin);
    } catch {
        return fail();
    }
    if (
        origin.protocol !== "https:" ||
        origin.origin !== input.publicOrigin ||
        origin.username !== "" ||
        origin.password !== "" ||
        origin.pathname !== "/" ||
        origin.search !== "" ||
        origin.hash !== "" ||
        !/^[0-9a-f]{40}$/u.test(input.expectedHeadSha)
    ) {
        fail();
    }
    return Object.freeze([
        bwrapExecutable,
        "--unshare-all",
        // Share only systemd's outer PrivateNetwork namespace so the fixed
        // socket-proxyd ingress can reach the preview loopback listener.
        "--share-net",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--ro-bind",
        input.bunExecutable,
        "/bun",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/home",
        "--dir",
        "/home/preview",
        "--dir",
        "/run",
        "--dir",
        "/run/mira-preview",
        "--ro-bind",
        input.worktreePath,
        "/workspace",
        "--ro-bind",
        "/dev/null",
        "/workspace/.git",
        "--bind",
        input.stateRoot,
        "/state",
        "--ro-bind",
        path.dirname(input.capabilitySocket),
        "/run/mira-preview/gateway",
        "--clearenv",
        "--setenv",
        "HOME",
        "/home/preview",
        "--setenv",
        "LANG",
        "C.UTF-8",
        "--setenv",
        "LC_ALL",
        "C.UTF-8",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "MIRA_DASHBOARD_DEV_GATEWAY_SOCKET",
        "/run/mira-preview/gateway/gateway.sock",
        "--setenv",
        "MIRA_DASHBOARD_DEV_HOT_RELOAD",
        "0",
        "--setenv",
        "MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN",
        input.publicOrigin,
        "--setenv",
        "MIRA_DASHBOARD_DEV_STATE_ROOT",
        "/state",
        "--chdir",
        "/workspace",
        "--",
        "/bun",
        "/workspace/scripts/developmentStack.ts",
        "--managed-preview",
        input.expectedHeadSha,
    ]);
}

/**
 * Builds the fixed outer private-network unit and inner Bubblewrap sandbox.
 * @param input Trusted, path-fenced preview launch inputs.
 * @param runtimeUserId Owner of the user-systemd manager.
 * @returns Exact transient-service command and scrubbed manager environment.
 */
export function buildPreviewLaunchSpecification(
    input: PreviewSandboxInput,
    runtimeUserId = 1000
): PreviewLaunchSpecification {
    const suffix = unitSuffix(input.operationId);
    if (!Number.isSafeInteger(runtimeUserId) || runtimeUserId < 0) fail();
    const unitName = `mira-dashboard-preview-${suffix}.service`;
    return Object.freeze({
        argv: Object.freeze([
            systemdRunExecutable,
            "--user",
            "--collect",
            "--quiet",
            `--unit=${unitName}`,
            "--property=CPUWeight=25",
            "--property=IOWeight=25",
            `--property=MemoryMax=${previewMemoryMaximumBytes}`,
            `--property=TasksMax=${previewTasksMaximum}`,
            "--property=KillMode=control-group",
            "--property=NoNewPrivileges=yes",
            "--property=PrivateNetwork=yes",
            "--property=ProtectControlGroups=yes",
            "--property=ProtectKernelLogs=yes",
            "--property=ProtectKernelModules=yes",
            "--property=ProtectKernelTunables=yes",
            "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
            "--property=RuntimeMaxSec=4h",
            "--property=TimeoutStopSec=20s",
            "--property=UMask=0077",
            "--",
            ...sandboxCommand(input),
        ]),
        environment: Object.freeze({
            DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${runtimeUserId}/bus`,
            HOME: "/nonexistent",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            PATH: "/usr/bin:/bin",
            XDG_RUNTIME_DIR: `/run/user/${runtimeUserId}`,
        }),
        unitName,
    });
}

/**
 * Provides a fixed host ingress bridge into the preview's private namespace.
 * The socket address is operator-owned configuration; PR code supplies no argv.
 * @param input Fixed socket, operation identity, and private preview port.
 * @returns Exact socket-activated systemd-proxyd specification.
 */
export function buildPreviewIngressSpecification(input: {
    readonly listenUnixSocket: string;
    readonly operationId: string;
    readonly previewPort: number;
}): PreviewIngressSpecification {
    assertAbsoluteNormalized(input.listenUnixSocket);
    if (
        !Number.isSafeInteger(input.previewPort) ||
        input.previewPort < 1024 ||
        input.previewPort > 65_535
    ) {
        fail();
    }
    const suffix = unitSuffix(input.operationId);
    const previewUnit = `mira-dashboard-preview-${suffix}.service`;
    const unitBaseName = `mira-dashboard-preview-ingress-${suffix}`;
    const serviceUnitName = `${unitBaseName}.service`;
    const socketUnitName = `${unitBaseName}.socket`;
    return Object.freeze({
        argv: Object.freeze([
            systemdRunExecutable,
            "--user",
            "--collect",
            "--quiet",
            `--unit=${unitBaseName}`,
            `--property=JoinsNamespaceOf=${previewUnit}`,
            "--property=NoNewPrivileges=yes",
            "--property=PrivateNetwork=yes",
            "--property=RuntimeMaxSec=4h",
            "--socket-property=ListenStream=" + input.listenUnixSocket,
            "--socket-property=SocketMode=0600",
            "--socket-property=RemoveOnStop=yes",
            "--",
            systemdSocketProxydExecutable,
            "--connections-max=16",
            "--exit-idle-time=4h",
            `127.0.0.1:${input.previewPort}`,
        ]),
        listenUnixSocket: input.listenUnixSocket,
        serviceUnitName,
        socketUnitName,
    });
}
