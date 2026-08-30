import { describe, expect, spyOn, test } from "bun:test";

import {
    buildPreviewIngressSpecification,
    buildPreviewLaunchSpecification,
} from "./previewSandbox.ts";

const operationId = "018f1f0e-7c52-7d63-8f22-b5f776933127";

describe("preview sandbox specifications", () => {
    test("derives the exact non-default runtime user for the user manager", () => {
        const getuid = spyOn(process, "getuid").mockReturnValue(4242);
        try {
            const specification = buildPreviewLaunchSpecification({
                bunExecutable: "/opt/mira/runtime/bun",
                capabilitySocket: "/srv/mira-preview/gateways/pr-42/gateway.sock",
                expectedHeadSha: "b".repeat(40),
                ingressSocket: "/srv/mira-preview/ingress/preview.sock",
                operationId,
                publicOrigin: "https://preview.example.test",
                stateRoot: "/srv/mira-preview/states/pr-42",
                worktreePath: "/srv/mira-preview/worktrees/pr-42",
            });

            expect(specification.environment).toMatchObject({
                DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/4242/bus",
                XDG_RUNTIME_DIR: "/run/user/4242",
            });
        } finally {
            getuid.mockRestore();
        }
    });

    test("clears the environment and keeps PR code in a private network", () => {
        const specification = buildPreviewLaunchSpecification(
            {
                bunExecutable: "/opt/mira/runtime/bun",
                capabilitySocket: "/srv/mira-preview/gateways/pr-42/gateway.sock",
                expectedHeadSha: "b".repeat(40),
                ingressSocket: "/srv/mira-preview/ingress/preview.sock",
                operationId,
                publicOrigin: "https://preview.example.test",
                stateRoot: "/srv/mira-preview/states/pr-42",
                worktreePath: "/srv/mira-preview/worktrees/pr-42",
            },
            1234
        );

        expect(specification.argv).toContain("--unshare-all");
        expect(specification.argv).toContain("--property=RuntimeMaxSec=4h");
        expect(specification.argv).toContain("--property=UMask=0077");
        expect(specification.argv).toContain("--clearenv");
        expect(specification.argv).toContain("--ro-bind");
        expect(specification.argv).toContain("/workspace/.git");
        expect(specification.argv).toContain("/bun");
        expect(specification.argv).toContain("/workspace/scripts/developmentStack.ts");
        expect(specification.argv).toContain("--managed-preview");
        expect(specification.argv).toContain("b".repeat(40));
        expect(specification.argv).toContain("/run/mira-preview/gateway/gateway.sock");
        const gatewayRootIndex = specification.argv.indexOf(
            "/srv/mira-preview/gateways/pr-42"
        );
        expect(specification.argv[gatewayRootIndex - 1]).toBe("--ro-bind");
        expect(specification.argv).not.toContain("--share-net");
        expect(specification.argv).toContain("/run/mira-preview/ingress/preview.sock");
        expect(specification.argv.join(" ")).not.toContain("DOPPLER");
        expect(specification.argv.join(" ")).not.toContain("GITHUB_TOKEN");
        expect(specification.argv.join(" ")).not.toContain("/opt/docker");
        expect(specification.argv.join(" ")).not.toContain("DATABASE_URL");
        expect(specification.environment).toEqual({
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1234/bus",
            HOME: "/nonexistent",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            PATH: "/usr/bin:/bin",
            XDG_RUNTIME_DIR: "/run/user/1234",
        });
    });

    test("builds a fixed socket-proxyd bridge joined to the preview namespace", () => {
        const specification = buildPreviewIngressSpecification({
            listenUnixSocket: "/run/user/1000/mira-preview.sock",
            operationId,
            previewPort: 5173,
            publicOrigin: "https://preview.example.test:3445",
        });

        expect(specification.argv).toContain(
            `--property=JoinsNamespaceOf=mira-dashboard-preview-${operationId}.service`
        );
        expect(specification.argv).toContain("/usr/lib/systemd/systemd-socket-proxyd");
        expect(specification.argv.at(-1)).toBe("127.0.0.1:5173");
        expect(specification.argv).toContain(
            "--socket-property=ListenStream=/run/user/1000/mira-preview.sock"
        );
        expect(specification.argv).toContain("--socket-property=SocketMode=0600");
        expect(specification.listenUnixSocket).toBe("/run/user/1000/mira-preview.sock");
        expect(specification.publicOrigin).toBe("https://preview.example.test:3445");
        expect(specification.serviceUnitName).toBe(
            `mira-dashboard-preview-ingress-${operationId}.service`
        );
        expect(specification.socketUnitName).toBe(
            `mira-dashboard-preview-ingress-${operationId}.socket`
        );
    });
});
