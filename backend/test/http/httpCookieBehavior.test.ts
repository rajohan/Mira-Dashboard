import { describe, expect, it } from "bun:test";

import type { Server } from "bun";

import {
    clearPendingLoginCookie,
    clearSessionCookie,
    pendingLoginCookie,
    sessionCookie,
} from "../../src/http/core.ts";

function serverWithAddress(address: string): Server<unknown> {
    return {
        requestIP: () => ({ address, family: "IPv4", port: 12_345 }),
    } as unknown as Server<unknown>;
}

describe("HTTP cookies", () => {
    it("does not mark direct HTTP sessions as Secure", () => {
        const request = new Request("http://100.68.236.26:3100/api/auth/login");
        const cookie = sessionCookie(request, serverWithAddress("100.68.236.26"), "abc");

        expect(cookie).not.toContain("Secure");
    });

    it("marks forwarded HTTPS sessions as Secure", () => {
        const request = new Request("http://127.0.0.1:3100/api/auth/login", {
            headers: { "x-forwarded-proto": "https" },
        });
        const server = serverWithAddress("127.0.0.1");

        expect(sessionCookie(request, server, "abc")).toContain("Secure");
        expect(clearSessionCookie(request, server)).toContain("Secure");
    });

    it("always marks production session cookies as Secure", () => {
        const request = new Request("http://100.68.236.26:3100/api/auth/login");
        const server = serverWithAddress("100.68.236.26");

        expect(sessionCookie(request, server, "abc", "production")).toContain("Secure");
        expect(clearSessionCookie(request, server, "production")).toContain("Secure");
        expect(pendingLoginCookie(request, server, "pending", "production")).toContain(
            "Secure"
        );
        expect(clearPendingLoginCookie(request, server, "production")).toContain(
            "Secure"
        );
    });
});
