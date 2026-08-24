import { describe, expect, test } from "bun:test";

import { generateOpaqueToken } from "../shared/opaqueToken.ts";
import { pendingLoginLifetimeMs } from "../shared/pendingLoginPolicy.ts";
import {
    appendClearedPendingLoginCookie,
    appendPendingLoginCookie,
} from "./pendingLoginCookie.ts";

describe("pending-login cookie", () => {
    test("serializes a valid token with the complete browser hardening policy", () => {
        const headers = new Headers();
        const token = generateOpaqueToken("pending-login").token;

        appendPendingLoginCookie(headers, token);

        expect(headers.get("set-cookie")).toBe(
            `__Host-mira_dashboard_pending_login=${token}; Max-Age=${pendingLoginLifetimeMs / 1000}; Path=/; Secure; HttpOnly; SameSite=Strict`
        );
    });

    test("expires the cookie without retaining token material", () => {
        const headers = new Headers();

        appendClearedPendingLoginCookie(headers);

        expect(headers.get("set-cookie")).toBe(
            "__Host-mira_dashboard_pending_login=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=Strict"
        );
    });

    test("rejects malformed token material", () => {
        expect(() => appendPendingLoginCookie(new Headers(), "not-a-token")).toThrow(
            "invalid pending-login token"
        );
    });
});
