import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedControlSafeTextSchema,
    compareStrings,
    hasUniqueArrayItems,
    lowercaseUuidV7Schema,
    noNulStringAction,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import type { ProcedureContract, RawHttpContract } from "./registry.ts";
import { opaqueTokenSchema } from "./security.ts";

/** Exact interactive PTY protocol and process budgets. */
export const terminalRuntimeMode = "pty" as const;
export const terminalWebSocketProtocol = "mira-terminal-v1" as const;
export const terminalPathMaximumLength = 1024;
export const terminalColumnsMinimum = 2;
export const terminalColumnsMaximum = 400;
export const terminalRowsMinimum = 1;
export const terminalRowsMaximum = 200;
export const terminalClientMessageMaximumBytes = 16 * 1024;
export const terminalServerMessageMaximumBytes = 32 * 1024;
export const terminalSocketBufferedMaximumBytes = 1024 * 1024;
export const terminalOutputReplayMaximumBytes = 256 * 1024;
export const terminalConnectionTicketTtlMs = 60 * 1000;
export const terminalReconnectGraceMs = 15 * 1000;
export const terminalIdleTimeoutMs = 10 * 60 * 1000;
export const terminalSessionMaximumDurationMs = 30 * 60 * 1000;
export const terminalConcurrentSessionMaximum = 4;
/** Binary server frames start with one kind byte and one unsigned 64-bit sequence. */
export const terminalBinaryOutputKind = 1;
export const terminalBinaryOutputHeaderBytes = 9;

export const terminalRootIdSchema = v.pipe(
    v.string("Terminal root is invalid"),
    v.minLength(1, "Terminal root is invalid"),
    v.maxLength(48, "Terminal root is invalid"),
    v.regex(/^[a-z0-9][a-z0-9-]*$/u, "Terminal root is invalid")
);

/**
 * Applies runtime-only canonical segment validation to one root-relative initial path.
 * @param value Candidate root-relative terminal path.
 * @returns Whether the path contains no dot or parent segments.
 */
export function terminalPathIsCanonical(value: string): boolean {
    return (
        value === "/" ||
        value
            .slice(1)
            .split("/")
            .every((part) => part !== "." && part !== "..")
    );
}

/** Canonical root-relative initial path; host absolute paths never cross transport. */
export const terminalPathSchema = v.pipe(
    v.string("Terminal path is invalid"),
    v.minLength(1, "Terminal path is invalid"),
    v.maxLength(terminalPathMaximumLength, "Terminal path is outside its budget"),
    noNulStringAction("Terminal path is invalid"),
    v.regex(/^\/(?:[^/\r\n]+(?:\/[^/\r\n]+)*)?$/u, "Terminal path is invalid"),
    v.check(terminalPathIsCanonical, "Terminal path is not canonical")
);

export const terminalLocationSchema = v.strictObject({
    path: terminalPathSchema,
    rootId: terminalRootIdSchema,
});
export type TerminalLocation = v.InferOutput<typeof terminalLocationSchema>;

export const terminalRootSchema = v.strictObject({
    defaultPath: terminalPathSchema,
    id: terminalRootIdSchema,
    label: boundedControlSafeTextSchema(80, "Terminal root label is invalid"),
});
export type TerminalRoot = v.InferOutput<typeof terminalRootSchema>;

/**
 * Applies runtime-only unique canonical ordering to reviewed terminal roots.
 * @param roots Candidate reviewed terminal roots.
 * @returns Whether IDs are unique and strictly sorted.
 */
export function terminalRootsAreCanonical(roots: TerminalRoot[]): boolean {
    return (
        hasUniqueArrayItems(roots.map(({ id }) => id)) &&
        roots.every((root, index) => {
            const previous = roots[index - 1];
            return previous === undefined || compareStrings(previous.id, root.id) < 0;
        })
    );
}

const terminalColumnsSchema = v.pipe(
    positiveSafeIntegerSchema("Terminal columns are invalid"),
    v.minValue(terminalColumnsMinimum, "Terminal columns are invalid"),
    v.maxValue(terminalColumnsMaximum, "Terminal columns are invalid")
);
const terminalRowsSchema = v.pipe(
    positiveSafeIntegerSchema("Terminal rows are invalid"),
    v.minValue(terminalRowsMinimum, "Terminal rows are invalid"),
    v.maxValue(terminalRowsMaximum, "Terminal rows are invalid")
);

export const terminalDimensionsSchema = v.strictObject({
    columns: terminalColumnsSchema,
    rows: terminalRowsSchema,
});
export type TerminalDimensions = v.InferOutput<typeof terminalDimensionsSchema>;

export const terminalRuntimeSchema = v.strictObject({
    clientMessageMaximumBytes: v.literal(terminalClientMessageMaximumBytes),
    defaultLocation: terminalLocationSchema,
    idleTimeoutMs: v.literal(terminalIdleTimeoutMs),
    mode: v.literal(terminalRuntimeMode),
    outputReplayMaximumBytes: v.literal(terminalOutputReplayMaximumBytes),
    reconnectGraceMs: v.literal(terminalReconnectGraceMs),
    roots: v.pipe(
        v.array(terminalRootSchema, "Terminal roots are invalid"),
        v.minLength(1, "Terminal roots are invalid"),
        v.maxLength(8, "Terminal roots are outside their budget"),
        v.check(terminalRootsAreCanonical, "Terminal roots are not canonical")
    ),
    serverMessageMaximumBytes: v.literal(terminalServerMessageMaximumBytes),
    sessionMaximumDurationMs: v.literal(terminalSessionMaximumDurationMs),
    supportsInput: v.literal(true),
    supportsPty: v.literal(true),
    supportsResize: v.literal(true),
    supportsSignals: v.tuple([
        v.literal("SIGINT"),
        v.literal("SIGTERM"),
        v.literal("SIGHUP"),
    ]),
    webSocketProtocol: v.literal(terminalWebSocketProtocol),
});
export type TerminalRuntime = v.InferOutput<typeof terminalRuntimeSchema>;

export const terminalSessionIdSchema = lowercaseUuidV7Schema(
    "Terminal session id is invalid"
);
export const getTerminalRuntimeInputSchema = v.strictObject({});

export const prepareTerminalSessionInputSchema = v.strictObject({
    dimensions: terminalDimensionsSchema,
    location: terminalLocationSchema,
});
export type PrepareTerminalSessionInput = v.InferOutput<
    typeof prepareTerminalSessionInputSchema
>;

export const prepareTerminalResumeInputSchema = v.strictObject({
    afterSequence: v.optional(
        nonnegativeSafeIntegerSchema("Terminal replay sequence is invalid"),
        0
    ),
    sessionId: terminalSessionIdSchema,
});

export const terminateTerminalSessionInputSchema = v.strictObject({
    sessionId: terminalSessionIdSchema,
});

export const terminalConnectionTicketSchema = v.strictObject({
    afterSequence: nonnegativeSafeIntegerSchema("Terminal replay sequence is invalid"),
    connectionToken: opaqueTokenSchema,
    expiresAtMs: timestampMillisecondsSchema(
        "Terminal connection ticket expiry is invalid"
    ),
    sessionId: terminalSessionIdSchema,
    webSocketProtocol: v.literal(terminalWebSocketProtocol),
    webSocketUrl: v.pipe(
        v.string("Terminal WebSocket URL is invalid"),
        v.maxLength(128, "Terminal WebSocket URL is invalid"),
        v.regex(
            /^\/api\/terminal\/sessions\/[0-9a-f-]{36}\/socket$/u,
            "Terminal WebSocket URL is invalid"
        )
    ),
});
export type TerminalConnectionTicket = v.InferOutput<
    typeof terminalConnectionTicketSchema
>;

export const terminalSessionStateSchema = v.picklist(
    ["awaiting-connection", "awaiting-reconnect", "connected", "starting"],
    "Terminal session state is invalid"
);

export const terminalSessionSummarySchema = v.strictObject({
    dimensions: terminalDimensionsSchema,
    expiresAtMs: timestampMillisecondsSchema("Terminal session expiry is invalid"),
    idleExpiresAtMs: timestampMillisecondsSchema(
        "Terminal session idle expiry is invalid"
    ),
    location: terminalLocationSchema,
    nextSequence: positiveSafeIntegerSchema("Terminal output sequence is invalid"),
    sessionId: terminalSessionIdSchema,
    startedAtMs: timestampMillisecondsSchema("Terminal session start is invalid"),
    state: terminalSessionStateSchema,
});
export type TerminalSessionSummary = v.InferOutput<typeof terminalSessionSummarySchema>;

export const getActiveTerminalSessionOutputSchema = v.variant("status", [
    v.strictObject({ status: v.literal("none") }),
    v.strictObject({
        session: terminalSessionSummarySchema,
        status: v.literal("active"),
    }),
]);
export type GetActiveTerminalSessionOutput = v.InferOutput<
    typeof getActiveTerminalSessionOutputSchema
>;

export const terminateTerminalSessionOutputSchema = v.strictObject({
    sessionId: terminalSessionIdSchema,
    terminated: v.literal(true),
});

const terminalPingNonceSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Terminal ping nonce is invalid"),
    v.maxValue(Number.MAX_SAFE_INTEGER, "Terminal ping nonce is invalid")
);

/** Browser-to-server control frames. Binary WebSocket messages are raw PTY input bytes. */
export const terminalClientMessageSchema = v.variant("type", [
    v.strictObject({
        dimensions: terminalDimensionsSchema,
        type: v.literal("resize"),
    }),
    v.strictObject({
        signal: v.picklist(["SIGINT", "SIGTERM", "SIGHUP"], "Terminal signal is invalid"),
        type: v.literal("signal"),
    }),
    v.strictObject({ nonce: terminalPingNonceSchema, type: v.literal("ping") }),
    v.strictObject({ type: v.literal("close") }),
]);
export type TerminalClientMessage = v.InferOutput<typeof terminalClientMessageSchema>;

/** Server-to-browser control frames. PTY output uses sequenced binary frames. */
export const terminalServerMessageSchema = v.variant("type", [
    v.strictObject({
        replayAvailableFromSequence: positiveSafeIntegerSchema(
            "Terminal replay sequence is invalid"
        ),
        resumed: v.boolean("Terminal resume state is invalid"),
        session: terminalSessionSummarySchema,
        type: v.literal("ready"),
    }),
    v.strictObject({
        endedAtMs: timestampMillisecondsSchema("Terminal exit time is invalid"),
        exitCode: v.pipe(
            nonnegativeSafeIntegerSchema("Terminal exit code is invalid"),
            v.maxValue(255, "Terminal exit code is invalid")
        ),
        reason: v.picklist(
            ["disconnected", "exited", "idle-timeout", "operator", "runtime-limit"],
            "Terminal exit reason is invalid"
        ),
        sessionId: terminalSessionIdSchema,
        signal: v.optional(
            boundedControlSafeTextSchema(32, "Terminal exit signal is invalid")
        ),
        type: v.literal("exit"),
    }),
    v.strictObject({
        code: v.picklist(
            ["capacity", "invalid-message", "session-ended", "unavailable"],
            "Terminal error code is invalid"
        ),
        message: boundedControlSafeTextSchema(160, "Terminal error message is invalid"),
        type: v.literal("error"),
    }),
    v.strictObject({ nonce: terminalPingNonceSchema, type: v.literal("pong") }),
]);
export type TerminalServerMessage = v.InferOutput<typeof terminalServerMessageSchema>;

const terminalAccess = {
    capabilities: ["terminal:read"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const terminalWriteAccess = {
    capabilities: ["terminal:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const queryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const mutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;
const authenticationReasons = ["mfa_enrollment_required", "step_up_required"] as const;

/** Browser-session-only interactive PTY procedures. */
export const terminalProcedureContracts = [
    {
        access: terminalAccess,
        domain: "terminal",
        errorReasons: authenticationReasons,
        errors: ["BAD_REQUEST", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: getTerminalRuntimeInputSchema,
        inputSchemaId: "terminal.getRuntime.input",
        kind: "query",
        name: "terminal.getRuntime",
        output: terminalRuntimeSchema,
        outputSchemaId: "terminal.getRuntime.output",
        summary:
            "Returns reviewed initial directories and exact interactive PTY budgets.",
        transport: queryTransport,
    },
    {
        access: terminalAccess,
        domain: "terminal",
        errorReasons: authenticationReasons,
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: getTerminalRuntimeInputSchema,
        inputSchemaId: "terminal.getActiveSession.input",
        kind: "query",
        name: "terminal.getActiveSession",
        output: getActiveTerminalSessionOutputSchema,
        outputSchemaId: "terminal.getActiveSession.output",
        summary:
            "Returns the caller's one active PTY session without output or input history.",
        transport: queryTransport,
    },
    {
        access: terminalWriteAccess,
        domain: "terminal",
        errorReasons: authenticationReasons,
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: prepareTerminalSessionInputSchema,
        inputSchemaId: "terminal.prepareSession.input",
        kind: "mutation",
        name: "terminal.prepareSession",
        output: terminalConnectionTicketSchema,
        outputSchemaId: "terminal.prepareSession.output",
        summary: "Audits and reserves one systemd-bounded interactive PTY connection.",
        transport: mutationTransport,
    },
    {
        access: terminalWriteAccess,
        domain: "terminal",
        errorReasons: authenticationReasons,
        errors: [
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: prepareTerminalResumeInputSchema,
        inputSchemaId: "terminal.prepareResume.input",
        kind: "mutation",
        name: "terminal.prepareResume",
        output: terminalConnectionTicketSchema,
        outputSchemaId: "terminal.prepareResume.output",
        summary:
            "Issues one replacement ticket during the bounded reconnect grace period.",
        transport: mutationTransport,
    },
    {
        access: terminalWriteAccess,
        domain: "terminal",
        errorReasons: authenticationReasons,
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: terminateTerminalSessionInputSchema,
        inputSchemaId: "terminal.terminateSession.input",
        kind: "mutation",
        name: "terminal.terminateSession",
        output: terminateTerminalSessionOutputSchema,
        outputSchemaId: "terminal.terminateSession.output",
        summary: "Terminates the caller's PTY scope without recording terminal contents.",
        transport: mutationTransport,
    },
] as const satisfies readonly ProcedureContract[];

/** Same-origin interactive PTY upgrade. The ticket is sent as a WebSocket subprotocol token. */
export const terminalRawHttpContracts = [
    {
        access: terminalWriteAccess,
        method: "GET",
        path: "/api/terminal/sessions/:sessionId/socket",
        rangeRequests: "none",
        requestBody: { kind: "none" },
        response: {
            clientMaximumMessageBytes: terminalClientMessageMaximumBytes,
            kind: "websocket",
            protocol: terminalWebSocketProtocol,
            serverMaximumMessageBytes: terminalServerMessageMaximumBytes,
        },
        statusCodes: [101, 400, 401, 403, 404, 405, 409, 410, 426, 429, 500, 503],
        summary:
            "Upgrades one actor-bound ticket to a full-duplex interactive PTY stream.",
    },
] as const satisfies readonly RawHttpContract[];
