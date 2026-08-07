import { describe, expect, test } from "bun:test";

import { generateOpaqueToken } from "../shared/opaqueToken.ts";
import {
    dashboardPendingLoginCookieName,
    dashboardSessionCookieName,
    readAuthenticationHttpCredentials,
} from "./authenticationCredentials.ts";

describe("raw HTTP authentication credentials", () => {
    test("parses session, automation, pending-login, and anonymous requests", () => {
        const session = generateOpaqueToken("session");
        const automation = generateOpaqueToken("automation");
        const pendingLogin = generateOpaqueToken("pending-login");
        const sessionAndPending = readAuthenticationHttpCredentials(
            new Request("https://dashboard.example/trpc/auth.status", {
                headers: {
                    cookie: `${dashboardSessionCookieName}=${session.token}; ${dashboardPendingLoginCookieName}=${pendingLogin.token}`,
                },
            })
        );

        expect(sessionAndPending).toMatchObject({
            authentication: { kind: "session", token: { prefix: session.prefix } },
            isAmbiguous: false,
            pendingLogin: {
                kind: "present",
                token: { prefix: pendingLogin.prefix },
            },
        });
        expect(
            readAuthenticationHttpCredentials(
                new Request("https://dashboard.example/trpc/events.stream", {
                    headers: { authorization: `bEaReR ${automation.token}` },
                })
            )
        ).toMatchObject({
            authentication: {
                kind: "automation",
                token: { prefix: automation.prefix },
            },
            isAmbiguous: false,
            pendingLogin: { kind: "absent" },
        });
        expect(
            readAuthenticationHttpCredentials(
                new Request("https://dashboard.example/trpc/auth.status")
            )
        ).toEqual({
            authentication: { kind: "anonymous" },
            isAmbiguous: false,
            pendingLogin: { kind: "absent" },
        });
    });

    test("rejects malformed and duplicate credential values", () => {
        const session = generateOpaqueToken("session");
        const automation = generateOpaqueToken("automation");
        const duplicateAuthorization = new Headers();
        duplicateAuthorization.append("authorization", `Bearer ${automation.token}`);
        duplicateAuthorization.append("authorization", `Bearer ${automation.token}`);
        const requests = [
            new Request("https://dashboard.example/trpc", {
                headers: { cookie: `${dashboardSessionCookieName}=malformed` },
            }),
            new Request("https://dashboard.example/trpc", {
                headers: {
                    cookie: `${dashboardSessionCookieName}=${session.token}; ${dashboardSessionCookieName}=${session.token}`,
                },
            }),
            new Request("https://dashboard.example/trpc", {
                headers: { cookie: dashboardSessionCookieName },
            }),
            new Request("https://dashboard.example/trpc", {
                headers: { authorization: "Basic malformed" },
            }),
            new Request("https://dashboard.example/trpc", {
                headers: duplicateAuthorization,
            }),
        ];

        for (const request of requests) {
            expect(readAuthenticationHttpCredentials(request).authentication).toEqual({
                kind: "invalid",
            });
        }
    });

    test("marks every automation and Dashboard-cookie combination ambiguous", () => {
        const automation = generateOpaqueToken("automation");
        for (const cookie of [
            dashboardSessionCookieName,
            `${dashboardPendingLoginCookieName}=malformed`,
            `${dashboardSessionCookieName}=one; ${dashboardSessionCookieName}=two`,
        ]) {
            const credentials = readAuthenticationHttpCredentials(
                new Request("https://dashboard.example/trpc", {
                    headers: {
                        authorization: `Bearer ${automation.token}`,
                        cookie,
                    },
                })
            );
            expect(credentials.isAmbiguous).toBeTrue();
            expect(credentials.authentication).toEqual({ kind: "invalid" });
        }
    });
});
