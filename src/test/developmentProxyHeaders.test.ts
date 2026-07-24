import { describe, expect, it } from "bun:test";

import { addForwardedClientHeaders } from "../lib/developmentProxyHeaders.ts";

describe("development proxy forwarding headers", () => {
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
