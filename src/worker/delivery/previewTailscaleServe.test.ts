import { describe, expect, test } from "bun:test";

import { rejectionError } from "../../../scripts/testSupport/rejection.ts";
import {
    createPreviewTailscaleServe,
    previewTailscaleHttpsPort,
    projectPreviewTailscaleRoute,
    type PreviewTailscaleProcessRequest,
    type PreviewTailscaleProcessResult,
} from "./previewTailscaleServe.ts";

const ingressSocket = "/run/user/1234/mira-dashboard-preview.sock";
const origin = `https://preview-node.example.ts.net:${previewTailscaleHttpsPort}`;
const target = `unix:${ingressSocket}`;
const encoder = new TextEncoder();

function result(
    value: unknown,
    exitCode = 0,
    stderr = ""
): PreviewTailscaleProcessResult {
    return Object.freeze({
        exitCode,
        stderr: encoder.encode(stderr),
        stdout:
            value === undefined
                ? new Uint8Array()
                : encoder.encode(JSON.stringify(value)),
    });
}

function nodeStatus() {
    return { Self: { DNSName: "Preview-Node.Example.TS.Net." } };
}

function serveStatus(enabled: boolean, proxy = target) {
    return enabled
        ? {
              TCP: { [String(previewTailscaleHttpsPort)]: { HTTPS: true } },
              Web: {
                  [`preview-node.example.ts.net:${previewTailscaleHttpsPort}`]: {
                      Handlers: { "/": { Proxy: proxy } },
                  },
              },
          }
        : {};
}

function fixture(options: { readonly mutationExitCode?: number } = {}) {
    let enabled = false;
    let releases = 0;
    let acquisitions = 0;
    const requests: PreviewTailscaleProcessRequest[] = [];
    const adapter = createPreviewTailscaleServe({
        acquireLock: () => {
            acquisitions += 1;
            return Promise.resolve({
                release: () => {
                    releases += 1;
                    return Promise.resolve();
                },
            });
        },
        processRunner(request) {
            requests.push(request);
            if (request.command.join(" ") === "/usr/bin/tailscale status --json") {
                return Promise.resolve(result(nodeStatus()));
            }
            if (request.command.join(" ") === "/usr/bin/tailscale serve status --json") {
                return Promise.resolve(result(serveStatus(enabled)));
            }
            if (request.command.includes("--bg")) {
                enabled = true;
                return Promise.resolve(
                    result(undefined, options.mutationExitCode ?? 0, "private diagnostic")
                );
            }
            if (request.command.at(-1) === "off") {
                enabled = false;
                return Promise.resolve(result(undefined));
            }
            throw new Error("unexpected command");
        },
        runtimeUserId: 1234,
    });
    return {
        adapter,
        counts: () => ({ acquisitions, releases }),
        requests,
        setEnabled: (value: boolean) => {
            enabled = value;
        },
    };
}

describe("preview Tailscale Serve", () => {
    test("projects only the exact dedicated HTTPS-to-Unix route", () => {
        expect(
            projectPreviewTailscaleRoute(nodeStatus(), serveStatus(true), ingressSocket)
        ).toEqual({ enabled: true, origin, target });
        expect(projectPreviewTailscaleRoute(nodeStatus(), {}, ingressSocket)).toEqual({
            enabled: false,
            origin,
            target,
        });

        expect(() =>
            projectPreviewTailscaleRoute(
                nodeStatus(),
                serveStatus(true, "http://127.0.0.1:9999"),
                ingressSocket
            )
        ).toThrow();
        expect(() =>
            projectPreviewTailscaleRoute(
                nodeStatus(),
                {
                    ...serveStatus(true),
                    AllowFunnel: {
                        [`preview-node.example.ts.net:${previewTailscaleHttpsPort}`]: true,
                    },
                },
                ingressSocket
            )
        ).toThrow();
    });

    test("discovers MagicDNS read-only and publishes then removes only its exact route", async () => {
        const context = fixture();
        let intentWrites = 0;
        expect(await context.adapter.inspect(ingressSocket)).toEqual({
            enabled: false,
            origin,
            target,
        });
        expect(
            await context.adapter.start(ingressSocket, origin, () => {
                intentWrites += 1;
                return Promise.resolve();
            })
        ).toEqual({ enabled: true, origin, target });
        expect(await context.adapter.stopOwned(ingressSocket, origin)).toEqual({
            enabled: false,
            origin,
            target,
        });
        expect(intentWrites).toBe(1);
        expect(context.counts()).toEqual({ acquisitions: 2, releases: 2 });

        const mutationCommands = context.requests
            .map(({ command }) => command)
            .filter(
                (command) => command[0] === "/usr/bin/tailscale" && command[1] === "serve"
            )
            .filter((command) => command[2] !== "status");
        expect(mutationCommands).toEqual([
            [
                "/usr/bin/tailscale",
                "serve",
                "--bg",
                `--https=${previewTailscaleHttpsPort}`,
                target,
            ],
            [
                "/usr/bin/tailscale",
                "serve",
                `--https=${previewTailscaleHttpsPort}`,
                "off",
            ],
        ]);
        expect(
            context.requests.every(
                ({ environment }) =>
                    environment.HOME === "/nonexistent" &&
                    environment.PATH === "/usr/bin:/bin" &&
                    Object.keys(environment).length === 6
            )
        ).toBeTrue();
    });

    test("records ownership before dispatch and attributes an exact post-state after lost settlement", async () => {
        const context = fixture({ mutationExitCode: 1 });
        const sequence: string[] = [];
        const status = await context.adapter.start(ingressSocket, origin, () => {
            sequence.push("intent");
            return Promise.resolve();
        });
        expect(status.enabled).toBeTrue();
        expect(sequence).toEqual(["intent"]);
    });

    test("never claims or removes a pre-existing route", async () => {
        const context = fixture();
        context.setEnabled(true);
        let intentWrites = 0;
        expect(
            await rejectionError(
                context.adapter.start(ingressSocket, origin, () => {
                    intentWrites += 1;
                    return Promise.resolve();
                })
            )
        ).toMatchObject({ reason: "operation-failed" });
        expect(intentWrites).toBe(0);
        expect(
            context.requests.some(({ command }) => command.includes("--bg"))
        ).toBeFalse();
        expect(
            context.requests.some(({ command }) => command.at(-1) === "off")
        ).toBeFalse();
    });

    test("bounds and sanitizes provider failures", async () => {
        const adapter = createPreviewTailscaleServe({
            acquireLock: () => Promise.reject(new Error("unused secret")),
            processRunner: () =>
                Promise.resolve({
                    exitCode: 1,
                    stderr: encoder.encode("secret upstream output"),
                    stdout: new Uint8Array(),
                }),
            runtimeUserId: 1234,
        });
        const error = await rejectionError(adapter.inspect(ingressSocket));
        expect(error).toMatchObject({ reason: "operation-failed" });
        expect(JSON.stringify(error)).not.toContain("secret");
    });
});
