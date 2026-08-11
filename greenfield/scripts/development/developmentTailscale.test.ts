import { describe, expect, jest, test } from "bun:test";

import {
    developmentServeStatus,
    type DevelopmentTailscaleCommandAdapter,
    enableDevelopmentServe,
    tailscaleDnsName,
} from "./developmentTailscale.ts";

const remoteProxyPort = 3207;
const httpsPort = 3445;

function serveStatus(enabled: boolean) {
    return Object.freeze({
        enabled,
        origin: "https://dashboard.example.ts.net:3445",
        proxyTarget: "http://127.0.0.1:3207",
    });
}

describe("development Tailscale route", () => {
    test("normalizes MagicDNS and recognizes only the exact dedicated route", () => {
        const dnsName = tailscaleDnsName({
            Self: { DNSName: "Dashboard.Example.TS.NET." },
        });
        expect(dnsName).toBe("dashboard.example.ts.net");
        expect(
            developmentServeStatus(
                {
                    TCP: { "3445": { HTTPS: true } },
                    Web: {
                        "dashboard.example.ts.net:3445": {
                            Handlers: {
                                "/": { Proxy: "http://127.0.0.1:3207" },
                            },
                        },
                    },
                },
                dnsName,
                httpsPort,
                remoteProxyPort
            )
        ).toEqual(serveStatus(true));
    });

    test("fails closed for a missing identity or conflicting port owner", () => {
        expect(() => tailscaleDnsName({})).toThrow(
            "Tailscale did not report a stable MagicDNS hostname"
        );
        expect(() =>
            developmentServeStatus(
                {
                    TCP: { "3445": { HTTPS: true } },
                    Web: {
                        "dashboard.example.ts.net:3445": {
                            Handlers: {
                                "/": { Proxy: "http://127.0.0.1:9999" },
                            },
                        },
                    },
                },
                "dashboard.example.ts.net",
                httpsPort,
                remoteProxyPort
            )
        ).toThrow("already configured for another target");
        expect(() =>
            developmentServeStatus(
                {
                    TCP: { "3445": { TCPForward: "127.0.0.1:9999" } },
                },
                "dashboard.example.ts.net",
                httpsPort,
                remoteProxyPort
            )
        ).toThrow("already configured for another target");
        expect(() =>
            developmentServeStatus(
                {
                    TCP: { "3445": { HTTPS: true } },
                    Web: {
                        "dashboard.example.ts.net:3445": {
                            Handlers: {
                                "/": { Proxy: "http://127.0.0.1:3207" },
                                "/api": { Proxy: "http://127.0.0.1:9999" },
                            },
                        },
                    },
                },
                "dashboard.example.ts.net",
                httpsPort,
                remoteProxyPort
            )
        ).toThrow("already configured for another target");
        expect(() =>
            developmentServeStatus(
                {
                    AllowFunnel: {
                        "dashboard.example.ts.net:3445": true,
                    },
                    TCP: { "3445": { HTTPS: true } },
                    Web: {
                        "dashboard.example.ts.net:3445": {
                            Handlers: {
                                "/": { Proxy: "http://127.0.0.1:3207" },
                            },
                        },
                    },
                },
                "dashboard.example.ts.net",
                httpsPort,
                remoteProxyPort
            )
        ).toThrow("already configured for another target");
    });

    test("reuses an existing exact route without claiming cleanup ownership", async () => {
        const run = jest.fn(() => Promise.resolve(""));
        const commands: DevelopmentTailscaleCommandAdapter = {
            currentStatus: () => Promise.resolve(serveStatus(true)),
            run,
        };

        const result = await enableDevelopmentServe(httpsPort, remoteProxyPort, commands);
        expect(result).toEqual({ didCreate: false, status: serveStatus(true) });
        expect(run).not.toHaveBeenCalled();
    });

    test("claims a new route only after exact verification", async () => {
        let statusCalls = 0;
        const run = jest.fn(() => Promise.resolve(""));
        const commands: DevelopmentTailscaleCommandAdapter = {
            currentStatus: () => Promise.resolve(serveStatus((statusCalls += 1) > 1)),
            run,
        };

        const result = await enableDevelopmentServe(httpsPort, remoteProxyPort, commands);
        expect(result).toEqual({ didCreate: true, status: serveStatus(true) });
        expect(run).toHaveBeenCalledWith([
            "sudo",
            "-n",
            "tailscale",
            "serve",
            "--bg",
            "--https=3445",
            "http://127.0.0.1:3207",
        ]);
    });

    test("admits only one route owner across concurrent activations", async () => {
        const lockPort = 40_000 + (process.pid % 20_000);
        let enabled = false;
        const commands: DevelopmentTailscaleCommandAdapter = {
            async currentStatus() {
                const snapshot = enabled;
                await Bun.sleep(20);
                return serveStatus(snapshot);
            },
            run: () => {
                enabled = true;
                return Promise.resolve("");
            },
        };

        const results = await Promise.allSettled([
            enableDevelopmentServe(lockPort, remoteProxyPort, commands),
            enableDevelopmentServe(lockPort, remoteProxyPort, commands),
        ]);

        const fulfilled = results.filter(
            (
                result
            ): result is PromiseFulfilledResult<
                Awaited<ReturnType<typeof enableDevelopmentServe>>
            > => result.status === "fulfilled"
        );
        const rejected = results.filter(
            (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        expect(fulfilled.map(({ value }) => value.didCreate)).toEqual([true]);
        expect(rejected).toHaveLength(1);
        const rejection = rejected[0];
        if (rejection === undefined) throw new Error("Expected one route lock rejection");
        expect(rejection.reason).toBeInstanceOf(Error);
        if (!(rejection.reason instanceof Error)) {
            throw new Error("Expected route lock failure");
        }
        expect(rejection.reason.message).toContain("already in use");
    });

    test("removes only its attempted route when activation verification fails", async () => {
        let statusCalls = 0;
        const commandsSeen: string[][] = [];
        const commands: DevelopmentTailscaleCommandAdapter = {
            currentStatus: () => {
                if ((statusCalls += 1) === 1) return Promise.resolve(serveStatus(false));
                return Promise.reject(new Error("serve status unavailable"));
            },
            run: (command) => {
                commandsSeen.push([...command]);
                return Promise.resolve("");
            },
        };

        const failure = await enableDevelopmentServe(
            httpsPort,
            remoteProxyPort,
            commands
        ).then(
            () => null,
            (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error))
            throw new Error("Expected route activation failure");
        expect(failure.message).toContain("serve status unavailable");
        expect(commandsSeen.at(-1)).toEqual([
            "sudo",
            "-n",
            "tailscale",
            "serve",
            "--https=3445",
            "off",
        ]);
    });
});
