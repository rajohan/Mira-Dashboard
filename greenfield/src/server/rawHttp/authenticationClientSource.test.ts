import { describe, expect, test } from "bun:test";

import { createAuthenticationClientSourceResolver } from "./authenticationClientSource.ts";

function request(headers: Headers | Record<string, string> = {}): Request {
    return new Request("https://dashboard.example/trpc/auth.login", { headers });
}

const ambiguousForwardingHeaders: Record<string, string>[] = [
    { "x-forwarded-for": "198.51.100.8, 198.51.100.9" },
    { "x-real-ip": "not-an-ip" },
    { "x-forwarded-for": "198.51.100.8", "x-real-ip": "198.51.100.9" },
];

describe("authentication client source", () => {
    test("ignores spoofed forwarding headers from an untrusted direct peer", () => {
        const resolver = createAuthenticationClientSourceResolver();

        expect(
            resolver.resolve(request({ "x-real-ip": "198.51.100.8" }), "127.0.0.1")
        ).toBe(resolver.resolve(request(), "127.0.0.1"));
    });

    test("uses one canonical address from an explicitly trusted proxy", () => {
        const resolver = createAuthenticationClientSourceResolver({
            trustedProxyAddresses: ["127.0.0.1"],
        });

        expect(
            resolver.resolve(
                request({
                    "x-forwarded-for": "2001:0db8:0:0:0:0:0:1",
                    "x-real-ip": "2001:db8::1",
                }),
                "::ffff:127.0.0.1"
            )
        ).toBe(resolver.resolve(request({ "x-real-ip": "2001:db8::1" }), "127.0.0.1"));
    });

    test.each(ambiguousForwardingHeaders)(
        "collapses malformed or ambiguous proxy identity %#",
        (headers) => {
            const resolver = createAuthenticationClientSourceResolver({
                trustedProxyAddresses: ["127.0.0.1"],
            });

            expect(resolver.resolve(request(headers), "127.0.0.1")).toBe(
                resolver.resolve(request(), "127.0.0.1")
            );
        }
    );

    test("fails startup for invalid trusted proxy configuration", () => {
        expect(() =>
            createAuthenticationClientSourceResolver({
                trustedProxyAddresses: ["not-an-ip"],
            })
        ).toThrow("Trusted proxy address is invalid");
    });
});
