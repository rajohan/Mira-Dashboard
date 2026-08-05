import { describe, expect, test } from "bun:test";

import { generateOpaqueToken } from "../shared/opaqueToken.ts";
import {
    appendClearedDashboardSessionCookie,
    appendDashboardSessionCookie,
} from "./sessionCookie.ts";

describe("Dashboard session cookie", () => {
    test("serializes a valid token with the complete browser hardening policy", () => {
        const headers = new Headers();
        const token = generateOpaqueToken("session").token;

        appendDashboardSessionCookie(headers, token);

        expect(headers.get("set-cookie")).toBe(
            `mira_dashboard_session=${token}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Strict`
        );
    });

    test("expires the cookie without retaining token material", () => {
        const headers = new Headers();

        appendClearedDashboardSessionCookie(headers);

        expect(headers.get("set-cookie")).toBe(
            "mira_dashboard_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=Strict"
        );
    });

    test("rejects malformed token material", () => {
        expect(() => appendDashboardSessionCookie(new Headers(), "not-a-token")).toThrow(
            "invalid Dashboard session token"
        );
    });

    test("preserves multiple Set-Cookie values without comma folding", () => {
        const headers = new Headers();

        appendDashboardSessionCookie(headers, generateOpaqueToken("session").token);
        appendClearedDashboardSessionCookie(headers);

        expect(headers.getSetCookie()).toHaveLength(2);
    });
});
