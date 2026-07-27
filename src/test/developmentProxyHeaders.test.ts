import { describe, expect, it } from "bun:test";

import {
    addForwardedClientHeaders,
    developmentCookieHeader,
    developmentForwardedProtocol,
} from "../lib/developmentProxyHeaders.ts";

describe("development proxy forwarding headers", () => {
    it("preserves the trusted external HTTPS scheme across local proxy transport", () => {
        expect(
            developmentForwardedProtocol(
                "https://dashboard.example:5173",
                "http://127.0.0.1:5173/api/auth/login"
            )
        ).toBe("https");
        expect(
            developmentForwardedProtocol(
                undefined,
                "http://127.0.0.1:5173/api/auth/login"
            )
        ).toBe("http");
        expect(() =>
            developmentForwardedProtocol(
                "file:///tmp/dashboard",
                "http://127.0.0.1:5173/api/auth/login"
            )
        ).toThrow("must use HTTP or HTTPS");
    });

    it("forwards only the isolated dev cookies", () => {
        expect(
            developmentCookieHeader(
                [
                    "mira_dashboard_session=production",
                    "mira_dashboard_dev_5173_session=development",
                    "unrelated=value",
                    "mira_dashboard_dev_5173_pending_login=pending",
                ].join("; "),
                "mira_dashboard_dev_5173"
            )
        ).toBe(
            "mira_dashboard_dev_5173_session=development; mira_dashboard_dev_5173_pending_login=pending"
        );
        expect(
            developmentCookieHeader(
                "mira_dashboard_session=production",
                "mira_dashboard_dev_5173"
            )
        ).toBeUndefined();
    });

    it("overwrites spoofed identity and fails closed when Bun has no client IP", () => {
        const headers = new Headers({
            "x-forwarded-for": "127.0.0.1",
            "x-real-ip": "127.0.0.1",
        });

        addForwardedClientHeaders(headers, undefined, "https");
        expect(headers.get("x-forwarded-for")).toBe("unknown");
        expect(headers.get("x-real-ip")).toBe("unknown");
        expect(headers.get("x-forwarded-proto")).toBe("https");

        addForwardedClientHeaders(headers, "203.0.113.25", "http");
        expect(headers.get("x-forwarded-for")).toBe("203.0.113.25");
        expect(headers.get("x-real-ip")).toBe("203.0.113.25");
        expect(headers.get("x-forwarded-proto")).toBe("http");
    });
});
