import { describe, expect, it, jest } from "bun:test";

import {
    developmentServeStatus,
    type DevelopmentTailscaleCommandAdapter,
    enableDevelopmentServe,
    tailscaleDnsName,
} from "../../scripts/developmentTailscale.ts";

function serveStatus(isEnabled: boolean) {
    return {
        enabled: isEnabled,
        origin: "https://dashboard.example:5173",
        proxyTarget: "http://127.0.0.1:5173",
    };
}

describe("development Tailscale helper", () => {
    it("normalizes MagicDNS names and recognizes only the exact HTTPS proxy", () => {
        const dnsName = tailscaleDnsName({
            Self: { DNSName: "Dashboard.Example.TS.NET." },
        });
        expect(dnsName).toBe("dashboard.example.ts.net");
        expect(
            developmentServeStatus(
                {
                    TCP: { "5173": { HTTPS: true } },
                    Web: {
                        "dashboard.example.ts.net:5173": {
                            Handlers: {
                                "/": { Proxy: "http://127.0.0.1:5173" },
                            },
                        },
                    },
                },
                dnsName,
                5173
            )
        ).toEqual({
            enabled: true,
            origin: "https://dashboard.example.ts.net:5173",
            proxyTarget: "http://127.0.0.1:5173",
        });
    });

    it("fails closed for missing DNS identity and conflicting Serve routes", () => {
        expect(() => tailscaleDnsName({})).toThrow(
            "Tailscale did not report a stable MagicDNS hostname"
        );
        expect(() =>
            developmentServeStatus(
                {
                    TCP: { "5173": { HTTPS: true } },
                    Web: {
                        "dashboard.example.ts.net:5173": {
                            Handlers: {
                                "/": { Proxy: "http://127.0.0.1:9999" },
                            },
                        },
                    },
                },
                "dashboard.example.ts.net",
                5173
            )
        ).toThrow("already configured for another target");
        expect(developmentServeStatus({}, "dashboard.example.ts.net", 5173).enabled).toBe(
            false
        );
    });
});

describe("development Tailscale activation", () => {
    it("reuses an existing owned route without mutating Serve", async () => {
        const run = jest.fn(async () => "");
        const commands: DevelopmentTailscaleCommandAdapter = {
            currentStatus: async () => serveStatus(true),
            run,
        };

        await expect(enableDevelopmentServe(5173, commands)).resolves.toEqual({
            didCreate: false,
            status: serveStatus(true),
        });
        expect(run).not.toHaveBeenCalled();
    });

    it("returns ownership only after the new route verifies", async () => {
        let statusCalls = 0;
        const run = jest.fn(async () => "");
        const commands: DevelopmentTailscaleCommandAdapter = {
            currentStatus: async () => serveStatus(statusCalls++ > 0),
            run,
        };

        await expect(enableDevelopmentServe(5173, commands)).resolves.toEqual({
            didCreate: true,
            status: serveStatus(true),
        });
        expect(run).toHaveBeenCalledWith([
            "sudo",
            "-n",
            "tailscale",
            "serve",
            "--bg",
            "--https=5173",
            "http://127.0.0.1:5173",
        ]);
    });

    it("removes a newly created route when activation verification fails", async () => {
        let statusCalls = 0;
        const commandsSeen: string[][] = [];
        const commands: DevelopmentTailscaleCommandAdapter = {
            currentStatus: async () => {
                if (statusCalls++ === 0) return serveStatus(false);
                throw new Error("serve status unavailable");
            },
            run: async (command) => {
                commandsSeen.push(command);
                return "";
            },
        };

        await expect(enableDevelopmentServe(5173, commands)).rejects.toThrow(
            "serve status unavailable"
        );
        expect(commandsSeen.at(-1)).toEqual([
            "sudo",
            "-n",
            "tailscale",
            "serve",
            "--https=5173",
            "off",
        ]);
    });

    it("reports both activation and cleanup failures", async () => {
        let runCalls = 0;
        let statusCalls = 0;
        const commands: DevelopmentTailscaleCommandAdapter = {
            currentStatus: async () => {
                if (statusCalls++ === 0) return serveStatus(false);
                throw new Error("verification failed");
            },
            run: async () => {
                if (runCalls++ > 0) throw new Error("cleanup failed");
                return "";
            },
        };

        await expect(enableDevelopmentServe(5173, commands)).rejects.toThrow(
            "activation failed and port 5173 cleanup also failed"
        );
    });
});
