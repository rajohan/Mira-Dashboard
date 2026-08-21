import * as v from "valibot";

export const openClawGatewayProtocolVersion = 4;
export const gatewayCredentialChallengeMaximumBytes = 4 * 1024;
export const gatewayCredentialMessageMaximumBytes = 25 * 1024 * 1024;

const gatewayCredentialVerificationScope = "operator.admin";

const gatewayChallengeNonceMaximumLength = 256;
const gatewayErrorCodeMaximumLength = 128;
const gatewayCredentialMismatchTopLevelCode = "INVALID_REQUEST";
const gatewayChallengeNonceError = "Gateway challenge nonce is invalid";
const gatewayNegotiatedScopeError = "Gateway negotiated scope is invalid";

const gatewayChallengeNonceSchema = v.pipe(
    v.string(gatewayChallengeNonceError),
    v.minLength(1, gatewayChallengeNonceError),
    v.maxLength(gatewayChallengeNonceMaximumLength, gatewayChallengeNonceError)
);
const gatewayNegotiatedScopeSchema = v.string(gatewayNegotiatedScopeError);
const gatewayNegotiatedScopesSchema = v.pipe(
    v.array(gatewayNegotiatedScopeSchema),
    v.check(
        (scopes) => scopes.includes(gatewayCredentialVerificationScope),
        "Gateway credential verification scope was not negotiated"
    )
);

const gatewayChallengeFrameSchema = v.looseObject({
    event: v.literal("connect.challenge"),
    payload: v.looseObject({
        nonce: gatewayChallengeNonceSchema,
    }),
    type: v.literal("event"),
});

const gatewayErrorDetailsSchema = v.looseObject({
    code: v.pipe(
        v.string("Gateway error detail code is invalid"),
        v.minLength(1, "Gateway error detail code is invalid"),
        v.maxLength(gatewayErrorCodeMaximumLength, "Gateway error detail code is invalid")
    ),
});

const gatewayErrorSchema = v.looseObject({
    code: v.pipe(
        v.string("Gateway error code is invalid"),
        v.minLength(1, "Gateway error code is invalid"),
        v.maxLength(gatewayErrorCodeMaximumLength, "Gateway error code is invalid")
    ),
    details: v.optional(v.unknown()),
});

const gatewayResponseFrameSchema = v.looseObject({
    error: v.optional(gatewayErrorSchema),
    id: v.pipe(
        v.string("Gateway response identifier is invalid"),
        v.minLength(1, "Gateway response identifier is invalid"),
        v.maxLength(128, "Gateway response identifier is invalid")
    ),
    ok: v.boolean("Gateway response outcome is invalid"),
    payload: v.optional(v.unknown()),
    type: v.literal("res"),
});

const gatewayHelloSchema = v.looseObject({
    auth: v.looseObject({
        role: v.literal("operator"),
        scopes: gatewayNegotiatedScopesSchema,
    }),
    protocol: v.literal(openClawGatewayProtocolVersion),
    snapshot: v.looseObject({
        authMode: v.literal("token"),
    }),
    type: v.literal("hello-ok"),
});

const gatewayFrameKindSchema = v.looseObject({
    type: v.string("Gateway frame type is invalid"),
});

const gatewayEventKindSchema = v.looseObject({
    event: v.string("Gateway event name is invalid"),
    type: v.literal("event"),
});

export interface GatewayConnectFrameInput {
    readonly credential: string;
    readonly requestId: string;
}

export type GatewayCredentialProtocolOutcome =
    | { readonly kind: "challenge" }
    | { readonly kind: "invalid-credential" }
    | { readonly kind: "verified" };

/** Structured authentication rejection emitted by the current Gateway protocol. */
export const gatewayCredentialMismatchDetailCode = "AUTH_TOKEN_MISMATCH";

/**
 * Creates the one v4 connect request used by the bootstrap credential probe.
 * The submitted credential is returned only in the outbound wire frame.
 * The temporary admin scope is required because the current protocol exposes
 * `snapshot.authMode` only to admin-scoped handshakes. No RPC is sent before
 * this one-shot socket closes.
 * @param input Request identifier and submitted credential.
 * @returns Current OpenClaw Gateway connect frame.
 */
export function createGatewayCredentialConnectFrame(
    input: GatewayConnectFrameInput
): Readonly<Record<string, unknown>> {
    return Object.freeze({
        id: input.requestId,
        method: "connect",
        params: Object.freeze({
            auth: Object.freeze({ token: input.credential }),
            caps: Object.freeze([]),
            client: Object.freeze({
                deviceFamily: "server",
                displayName: "Mira Dashboard bootstrap verifier",
                id: "gateway-client",
                mode: "backend",
                platform: process.platform,
                version: "0.0.0",
            }),
            maxProtocol: openClawGatewayProtocolVersion,
            minProtocol: openClawGatewayProtocolVersion,
            role: "operator",
            scopes: Object.freeze([gatewayCredentialVerificationScope]),
        }),
        type: "req",
    });
}

function parseGatewayErrorDetailCode(
    error: v.InferOutput<typeof gatewayErrorSchema>
): string | undefined {
    const details = v.safeParse(gatewayErrorDetailsSchema, error.details);
    return details.success ? details.output.code : undefined;
}

/**
 * Classifies one already-decoded current-protocol Gateway frame.
 * Unknown events, unmatched responses, and malformed frames fail closed.
 * @param value Untrusted decoded JSON value.
 * @param requestId Identifier of this verifier's connect request.
 * @returns A protocol outcome, or undefined when the relevant frame is malformed.
 */
export function parseGatewayCredentialProtocolFrame(
    value: unknown,
    requestId: string
): GatewayCredentialProtocolOutcome | undefined {
    const frameKind = v.safeParse(gatewayFrameKindSchema, value);
    if (!frameKind.success) return undefined;

    if (frameKind.output.type === "event") {
        const eventKind = v.safeParse(gatewayEventKindSchema, value);
        if (!eventKind.success) return undefined;
        if (eventKind.output.event !== "connect.challenge") return undefined;
        const challenge = v.safeParse(gatewayChallengeFrameSchema, value);
        return challenge.success ? { kind: "challenge" } : undefined;
    }

    if (frameKind.output.type !== "res") return undefined;
    const response = v.safeParse(gatewayResponseFrameSchema, value);
    if (!response.success) return undefined;
    if (response.output.id !== requestId) return undefined;

    if (!response.output.ok) {
        if (
            response.output.error !== undefined &&
            response.output.payload === undefined &&
            response.output.error.code === gatewayCredentialMismatchTopLevelCode &&
            parseGatewayErrorDetailCode(response.output.error) ===
                gatewayCredentialMismatchDetailCode
        ) {
            return { kind: "invalid-credential" };
        }
        return undefined;
    }

    if (response.output.error !== undefined || response.output.payload === undefined) {
        return undefined;
    }

    const hello = v.safeParse(gatewayHelloSchema, response.output.payload);
    return hello.success ? { kind: "verified" } : undefined;
}
