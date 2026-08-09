import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    prepareTerminalResumeInputSchema,
    terminalBinaryOutputHeaderBytes,
    terminalClientMessageMaximumBytes,
    terminalClientMessageSchema,
    terminalProcedureContracts,
    terminalRawHttpContracts,
    terminalRuntimeMode,
    terminalWebSocketProtocol,
} from "./terminal.ts";

describe("interactive terminal contracts", () => {
    test("publishes a session-only recent-MFA PTY surface", () => {
        expect(terminalProcedureContracts.map(({ name }) => name)).toEqual([
            "terminal.getRuntime",
            "terminal.getActiveSession",
            "terminal.prepareSession",
            "terminal.prepareResume",
            "terminal.terminateSession",
        ]);
        for (const contract of terminalProcedureContracts) {
            expect(contract.access).toMatchObject({
                kind: "recent-auth",
                principalKinds: ["session"],
                whenMfaDisabled: "deny",
                whenMfaEnabled: "mfa",
            });
        }
        expect(terminalRuntimeMode).toBe("pty");
    });

    test("documents the exact same-origin WebSocket upgrade and byte budgets", () => {
        expect(terminalRawHttpContracts).toEqual([
            expect.objectContaining({
                method: "GET",
                path: "/api/terminal/sessions/:sessionId/socket",
                requestBody: { kind: "none" },
                response: {
                    clientMaximumMessageBytes: terminalClientMessageMaximumBytes,
                    kind: "websocket",
                    protocol: terminalWebSocketProtocol,
                    serverMaximumMessageBytes: 32 * 1024,
                },
            }),
        ]);
        expect(terminalBinaryOutputHeaderBytes).toBe(9);
    });

    test("keeps raw input binary and bounds only explicit JSON control frames", () => {
        expect(
            v.parse(terminalClientMessageSchema, {
                dimensions: { columns: 120, rows: 40 },
                type: "resize",
            })
        ).toEqual({ dimensions: { columns: 120, rows: 40 }, type: "resize" });
        expect(
            v.safeParse(terminalClientMessageSchema, {
                data: "echo this must not be logged",
                type: "input",
            }).success
        ).toBe(false);
    });

    test("carries an explicit replay cursor into replacement tickets", () => {
        expect(
            v.parse(prepareTerminalResumeInputSchema, {
                sessionId: "019fc968-1a9b-7760-bf1b-d5b863b0e7b4",
            })
        ).toEqual({
            afterSequence: 0,
            sessionId: "019fc968-1a9b-7760-bf1b-d5b863b0e7b4",
        });
    });
});
