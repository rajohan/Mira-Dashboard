import { describe, expect, jest, test } from "bun:test";

import { startGatewayCredentialVerifierFixture } from "../../test/support/gatewayCredentialVerifier.ts";
import { captureFailure, withTestTimeout } from "../../test/support/promise.ts";
import {
    createGatewayCredentialVerifier,
    GatewayCredentialVerifierConfigurationError,
    GatewayCredentialVerifierUnavailableError,
    parseGatewayCredentialVerifierUrl,
} from "./gatewayCredentialVerifier.ts";

async function waitForNoFixtureConnections(
    fixture: ReturnType<typeof startGatewayCredentialVerifierFixture>
): Promise<void> {
    const deadline = Date.now() + 1000;
    while (fixture.openConnections !== 0 && Date.now() < deadline) {
        await Bun.sleep(5);
    }
    expect(fixture.openConnections).toBe(0);
}

class ControlledCloseWebSocket extends EventTarget {
    closeCalls = 0;
    readyState: number = WebSocket.CONNECTING;
    readonly sent: string[] = [];

    close(): void {
        this.closeCalls += 1;
        this.readyState = WebSocket.CLOSING;
    }

    finishClose(): void {
        this.readyState = WebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
    }

    fail(): void {
        this.dispatchEvent(new Event("error"));
    }

    open(): void {
        this.readyState = WebSocket.OPEN;
    }

    receive(value: unknown): void {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
    }

    send(value: string): void {
        this.sent.push(value);
    }
}

class MessageListenerFailureWebSocket extends ControlledCloseWebSocket {
    override addEventListener(
        ...parameters: Parameters<EventTarget["addEventListener"]>
    ): void {
        const [type] = parameters;
        if (type === "message") {
            throw new Error("listener setup details must not escape");
        }
        super.addEventListener(...parameters);
    }
}

describe("native Gateway credential verifier", () => {
    test("accepts only explicit credential-free direct-loopback endpoints", () => {
        expect(parseGatewayCredentialVerifierUrl("ws://127.0.0.1:18789")).toBe(
            "ws://127.0.0.1:18789/"
        );
        expect(parseGatewayCredentialVerifierUrl("ws://[::1]:18789")).toBe(
            "ws://[::1]:18789/"
        );
        for (const invalid of [
            " http://gateway.example",
            "http://gateway.example",
            "ws://127.0.0.1",
            "ws://127.0.0.1:0",
            "ws://127.0.0.1:18789/foo/..",
            "ws://127.0.0.1:18789/gateway",
            "ws://127.0.0.1:18789/?",
            "ws://127.0.0.1:18789/#",
            "ws://127.0.0.1:18789?token=secret",
            "ws://127.1:18789",
            "ws://user:secret@gateway.example",
            "ws://localhost:18789",
            "wss://gateway.example:443/",
            "ws://gateway.example/#fragment",
            "ws://127.0.0.1:\n18789",
            "",
        ]) {
            expect(() => parseGatewayCredentialVerifierUrl(invalid)).toThrow(
                GatewayCredentialVerifierConfigurationError
            );
        }
    });

    test("verifies and rejects credentials through a real Bun WebSocket fixture", async () => {
        const fixture = startGatewayCredentialVerifierFixture({
            validCredential: "valid-token",
        });
        const verify = createGatewayCredentialVerifier({ url: fixture.url });

        try {
            expect(await verify("valid-token")).toBe(true);
            expect(await verify("invalid-token")).toBe(false);
            expect(fixture.observedCredentials).toEqual(["valid-token", "invalid-token"]);
            expect(fixture.observedUpgradeRequests).toEqual([
                {
                    authorization: null,
                    forwarded: null,
                    origin: null,
                    secWebSocketProtocol: null,
                    url: `${fixture.httpUrl}/`,
                    xForwardedFor: null,
                },
                {
                    authorization: null,
                    forwarded: null,
                    origin: null,
                    secWebSocketProtocol: null,
                    url: `${fixture.httpUrl}/`,
                    xForwardedFor: null,
                },
            ]);
            expect(fixture.observedUpgradeRequests[0]?.url).not.toContain("valid-token");
        } finally {
            await fixture.stop();
        }
    });

    test("rejects binary Gateway responses required to be text by protocol v4", async () => {
        const fixture = startGatewayCredentialVerifierFixture({
            behavior: "binary-response",
            validCredential: "valid-token",
        });
        try {
            expect(
                await captureFailure(() =>
                    createGatewayCredentialVerifier({ url: fixture.url })("valid-token")
                )
            ).toBeInstanceOf(GatewayCredentialVerifierUnavailableError);
        } finally {
            await fixture.stop();
        }
    });

    test("fails closed on every unavailable authentication and protocol flow", async () => {
        for (const behavior of [
            "auth-none",
            "close-before-challenge",
            "duplicate-challenge",
            "malformed-response",
            "oversized-challenge",
            "oversized-response",
            "read-only-scope",
            "response-before-challenge",
            "unknown-event",
            "wrong-response-id",
        ] as const) {
            const fixture = startGatewayCredentialVerifierFixture({
                behavior,
                validCredential: "valid-token",
            });
            try {
                expect(
                    await captureFailure(() =>
                        createGatewayCredentialVerifier({ url: fixture.url })(
                            "valid-token"
                        )
                    )
                ).toBeInstanceOf(GatewayCredentialVerifierUnavailableError);
            } finally {
                await fixture.stop();
            }
        }
    });

    test("cooperatively closes the socket when Effect-owned work aborts", async () => {
        const fixture = startGatewayCredentialVerifierFixture({
            behavior: "silent",
            validCredential: "valid-token",
        });
        const controller = new AbortController();
        const verify = createGatewayCredentialVerifier({ url: fixture.url });
        const verification = verify("valid-token", controller.signal);

        try {
            controller.abort(new DOMException("test abort", "AbortError"));
            expect(await captureFailure(() => verification)).toMatchObject({
                name: "AbortError",
            });
            await waitForNoFixtureConnections(fixture);
        } finally {
            await fixture.stop();
        }
    });

    test("keeps the first terminal error through abort and late-message races", async () => {
        const socket = new ControlledCloseWebSocket();
        const controller = new AbortController();
        const verification = createGatewayCredentialVerifier({
            url: "ws://127.0.0.1:18789",
            webSocketFactory: () => socket as unknown as WebSocket,
        })("valid-token", controller.signal);
        let settlement = "pending";
        void verification.then(
            () => {
                settlement = "settled";
                return null;
            },
            () => {
                settlement = "settled";
                return null;
            }
        );

        socket.open();
        socket.fail();
        controller.abort();
        socket.receive({
            event: "connect.challenge",
            payload: { nonce: "late-nonce" },
            type: "event",
        });
        await Promise.resolve();

        expect(socket.closeCalls).toBe(1);
        expect(socket.sent).toHaveLength(0);
        expect(String(settlement)).toBe("pending");
        socket.finishClose();
        expect(await captureFailure(() => verification)).toBeInstanceOf(
            GatewayCredentialVerifierUnavailableError
        );
        expect(String(settlement)).toBe("settled");
    });

    test("redacts listener setup failure and waits for the observed close", async () => {
        const socket = new MessageListenerFailureWebSocket();
        const verification = createGatewayCredentialVerifier({
            url: "ws://127.0.0.1:18789",
            webSocketFactory: () => socket as unknown as WebSocket,
        })("valid-token");
        let settlement = "pending";
        void verification.then(
            () => {
                settlement = "settled";
                return null;
            },
            () => {
                settlement = "settled";
                return null;
            }
        );

        await Promise.resolve();
        expect(socket.closeCalls).toBe(1);
        expect(String(settlement)).toBe("pending");
        socket.finishClose();
        expect(await captureFailure(() => verification)).toEqual(
            new GatewayCredentialVerifierUnavailableError(
                "Gateway credential verification is unavailable"
            )
        );
        expect(String(settlement)).toBe("settled");
    });

    test("settles only after the native socket close is actually observed", async () => {
        const socket = new ControlledCloseWebSocket();
        const verification = createGatewayCredentialVerifier({
            url: "ws://127.0.0.1:18789",
            webSocketFactory: () => socket as unknown as WebSocket,
        })("valid-token");
        let settlement = "pending";
        void verification.finally(() => {
            settlement = "settled";
        });

        socket.open();
        socket.receive({
            event: "connect.challenge",
            payload: { nonce: "fixture-nonce" },
            type: "event",
        });
        expect(socket.sent).toHaveLength(1);
        socket.receive({
            id: "gateway-credential-verification",
            ok: true,
            payload: {
                auth: { role: "operator", scopes: ["operator.admin"] },
                protocol: 4,
                snapshot: { authMode: "token" },
                type: "hello-ok",
            },
            type: "res",
        });

        await Promise.resolve();
        expect(socket.closeCalls).toBe(1);
        expect(String(settlement)).toBe("pending");
        socket.finishClose();
        expect(await verification).toBe(true);
        expect(String(settlement)).toBe("settled");
    });

    test("never schedules a reconnect after startup-sidecars", async () => {
        const fixture = startGatewayCredentialVerifierFixture({
            behavior: "startup-sidecars",
            validCredential: "valid-token",
        });

        jest.useFakeTimers();
        try {
            expect(
                await withTestTimeout(
                    captureFailure(() =>
                        createGatewayCredentialVerifier({ url: fixture.url })(
                            "valid-token"
                        )
                    ),
                    1000,
                    "Gateway verifier did not settle startup-sidecars"
                )
            ).toBeInstanceOf(GatewayCredentialVerifierUnavailableError);
            expect(fixture.acceptedConnections).toBe(1);
            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(60_000);
            await Promise.resolve();
            expect(fixture.acceptedConnections).toBe(1);
        } finally {
            jest.useRealTimers();
            await fixture.stop();
        }
    });

    test("redacts a real native connection refusal", async () => {
        const fixture = startGatewayCredentialVerifierFixture({
            validCredential: "valid-token",
        });
        const stoppedUrl = fixture.url;
        await fixture.stop();

        expect(
            await withTestTimeout(
                captureFailure(() =>
                    createGatewayCredentialVerifier({ url: stoppedUrl })("valid-token")
                ),
                2000,
                "Native connection refusal did not settle"
            )
        ).toBeInstanceOf(GatewayCredentialVerifierUnavailableError);
    });

    test("redacts synchronous socket-construction failures", async () => {
        const verify = createGatewayCredentialVerifier({
            url: "ws://127.0.0.1:18789",
            webSocketFactory: () => {
                throw new Error("upstream details must not escape");
            },
        });

        expect(await captureFailure(() => verify("secret-token"))).toEqual(
            new GatewayCredentialVerifierUnavailableError(
                "Gateway credential verification is unavailable"
            )
        );
    });
});
