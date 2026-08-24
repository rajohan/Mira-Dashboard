import { describe, expect, test } from "bun:test";

import { isAllowedRequestSource, parseBrowserOrigin } from "./requestSecurity.ts";

function request(
    method: string,
    headers: Record<string, string> = {},
    url = "https://dashboard.example/trpc/tasks.create"
): Request {
    return new Request(url, {
        headers,
        method,
    });
}

const rejectedBrowserHeaders: Record<string, string>[] = [
    { origin: "https://attacker.example" },
    { origin: "null" },
    { origin: "https://dashboard.example/path" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "invalid" },
];

describe("raw request source policy", () => {
    test("validates canonical HTTP browser origins", () => {
        expect(parseBrowserOrigin("https://dashboard.example")).toBe(
            "https://dashboard.example"
        );
        expect(() => parseBrowserOrigin("https://dashboard.example/path")).toThrow(
            "Dashboard browser origin is invalid"
        );
        expect(() => parseBrowserOrigin("ftp://dashboard.example")).toThrow(
            "Dashboard browser origin is invalid"
        );
    });

    test("allows direct clients without browser provenance", () => {
        expect(isAllowedRequestSource(request("GET"))).toBe(true);
        expect(isAllowedRequestSource(request("POST"))).toBe(true);
    });

    test.each(["GET", "POST"])(
        "allows exact same-origin browser %s requests",
        (method) => {
            expect(
                isAllowedRequestSource(
                    request(method, {
                        origin: "https://dashboard.example",
                        "sec-fetch-site": "same-origin",
                    })
                )
            ).toBe(true);
        }
    );

    test.each(["GET", "POST"])("rejects cross-site browser %s requests", (method) => {
        expect(
            isAllowedRequestSource(
                request(method, {
                    origin: "https://attacker.example",
                    "sec-fetch-site": "cross-site",
                })
            )
        ).toBe(false);
    });

    test("rejects same-site browser streams", () => {
        expect(
            isAllowedRequestSource(
                request("GET", {
                    origin: "https://dashboard.example",
                    "sec-fetch-site": "same-site",
                })
            )
        ).toBe(false);
    });

    test("rejects unsafe browser requests without an Origin header", () => {
        expect(
            isAllowedRequestSource(request("POST", { "sec-fetch-site": "same-origin" }))
        ).toBe(false);
    });

    test("uses the explicit public origin behind a TLS-terminating proxy", () => {
        const proxiedRequest = request(
            "POST",
            {
                origin: "https://dashboard.example",
                "sec-fetch-site": "same-origin",
            },
            "http://127.0.0.1:3100/trpc/tasks.create"
        );

        expect(isAllowedRequestSource(proxiedRequest, "https://dashboard.example")).toBe(
            true
        );
        expect(isAllowedRequestSource(proxiedRequest, "https://other.example")).toBe(
            false
        );
    });

    test.each(rejectedBrowserHeaders)(
        "rejects untrusted browser request source %#",
        (headers) => {
            expect(isAllowedRequestSource(request("POST", headers))).toBe(false);
        }
    );
});
