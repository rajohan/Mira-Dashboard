import { describe, expect, it } from "bun:test";

import {
    developmentServeStatus,
    tailscaleDnsName,
} from "../../scripts/developmentTailscale.ts";

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
