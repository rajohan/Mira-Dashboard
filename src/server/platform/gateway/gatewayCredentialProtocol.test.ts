import { describe, expect, test } from "bun:test";

import {
    createGatewayCredentialConnectFrame,
    parseGatewayCredentialProtocolFrame,
} from "./gatewayCredentialProtocol.ts";

describe("Gateway credential protocol", () => {
    test("builds the current device-less local-backend v4 probe", () => {
        const frame = createGatewayCredentialConnectFrame({
            credential: "submitted-token",
            requestId: "request-1",
        });

        expect(frame).toEqual({
            id: "request-1",
            method: "connect",
            params: {
                auth: { token: "submitted-token" },
                caps: [],
                client: {
                    deviceFamily: "server",
                    displayName: "Mira Dashboard bootstrap verifier",
                    id: "gateway-client",
                    mode: "backend",
                    platform: process.platform,
                    version: "0.0.0",
                },
                maxProtocol: 4,
                minProtocol: 4,
                role: "operator",
                scopes: ["operator.admin"],
            },
            type: "req",
        });
        expect((frame.params as Record<string, unknown>).device).toBeUndefined();
    });

    test("accepts only a bounded current challenge", () => {
        expect(
            parseGatewayCredentialProtocolFrame(
                {
                    event: "connect.challenge",
                    ignored: true,
                    payload: { nonce: "nonce-1", ts: 1 },
                    type: "event",
                },
                "request-1"
            )
        ).toEqual({ kind: "challenge" });
        expect(
            parseGatewayCredentialProtocolFrame(
                {
                    event: "connect.challenge",
                    payload: { nonce: "" },
                    type: "event",
                },
                "request-1"
            )
        ).toBeUndefined();
    });

    test("classifies only structured token mismatch as an invalid credential", () => {
        expect(
            parseGatewayCredentialProtocolFrame(
                {
                    error: {
                        code: "INVALID_REQUEST",
                        details: { code: "AUTH_TOKEN_MISMATCH" },
                    },
                    id: "request-1",
                    ok: false,
                    type: "res",
                },
                "request-1"
            )
        ).toEqual({ kind: "invalid-credential" });
        expect(
            parseGatewayCredentialProtocolFrame(
                {
                    error: {
                        code: "INVALID_REQUEST",
                        details: { code: "AUTH_RATE_LIMITED" },
                    },
                    id: "request-1",
                    ok: false,
                    type: "res",
                },
                "request-1"
            )
        ).toBeUndefined();
        expect(
            parseGatewayCredentialProtocolFrame(
                {
                    error: { code: "AUTH_TOKEN_MISMATCH" },
                    id: "request-1",
                    ok: false,
                    type: "res",
                },
                "request-1"
            )
        ).toBeUndefined();
        expect(
            parseGatewayCredentialProtocolFrame(
                {
                    error: {
                        code: "UNAVAILABLE",
                        details: { code: "AUTH_TOKEN_MISMATCH" },
                    },
                    id: "request-1",
                    ok: false,
                    type: "res",
                },
                "request-1"
            )
        ).toBeUndefined();
    });

    test("requires the current hello protocol on the matching response", () => {
        expect(
            parseGatewayCredentialProtocolFrame(
                {
                    id: "request-1",
                    ok: true,
                    payload: {
                        auth: { role: "operator", scopes: ["operator.admin"] },
                        protocol: 4,
                        snapshot: { authMode: "token" },
                        type: "hello-ok",
                    },
                    type: "res",
                },
                "request-1"
            )
        ).toEqual({ kind: "verified" });
        expect(
            parseGatewayCredentialProtocolFrame(
                {
                    id: "request-1",
                    ok: true,
                    payload: {
                        auth: { role: "operator", scopes: ["operator.admin"] },
                        protocol: 3,
                        snapshot: { authMode: "token" },
                        type: "hello-ok",
                    },
                    type: "res",
                },
                "request-1"
            )
        ).toBeUndefined();
        expect(
            parseGatewayCredentialProtocolFrame(
                {
                    id: "another-request",
                    ok: true,
                    payload: {
                        auth: { role: "operator", scopes: ["operator.admin"] },
                        protocol: 4,
                        snapshot: { authMode: "token" },
                        type: "hello-ok",
                    },
                    type: "res",
                },
                "request-1"
            )
        ).toBeUndefined();
    });

    test("rejects contradictory success and failure response shapes", () => {
        const hello = {
            auth: { role: "operator", scopes: ["operator.admin"] },
            protocol: 4,
            snapshot: { authMode: "token" },
            type: "hello-ok",
        };
        for (const response of [
            {
                error: { code: "INVALID_REQUEST" },
                id: "request-1",
                ok: true,
                payload: hello,
                type: "res",
            },
            {
                error: {
                    code: "INVALID_REQUEST",
                    details: { code: "AUTH_TOKEN_MISMATCH" },
                },
                id: "request-1",
                ok: false,
                payload: hello,
                type: "res",
            },
            {
                id: "request-1",
                ok: false,
                type: "res",
            },
        ]) {
            expect(
                parseGatewayCredentialProtocolFrame(response, "request-1")
            ).toBeUndefined();
        }
    });

    test("rejects hello responses that do not prove token mode and negotiated admin scope", () => {
        for (const payload of [
            {
                auth: { role: "operator", scopes: ["operator.admin"] },
                protocol: 4,
                snapshot: { authMode: "none" },
                type: "hello-ok",
            },
            {
                auth: { role: "operator", scopes: ["operator.read"] },
                protocol: 4,
                snapshot: { authMode: "token" },
                type: "hello-ok",
            },
            {
                auth: { role: "node", scopes: ["operator.admin"] },
                protocol: 4,
                snapshot: { authMode: "token" },
                type: "hello-ok",
            },
        ]) {
            expect(
                parseGatewayCredentialProtocolFrame(
                    {
                        id: "request-1",
                        ok: true,
                        payload,
                        type: "res",
                    },
                    "request-1"
                )
            ).toBeUndefined();
        }
    });
});
