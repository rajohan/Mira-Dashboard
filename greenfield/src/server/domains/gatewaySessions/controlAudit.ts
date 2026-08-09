import type { GatewaySessionAction } from "../../../contracts/gatewaySessions.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    createSecurityAuditEvent,
    type SecurityAuditActor,
    type SecurityAuditEvent,
} from "../security/audit.ts";

const gatewaySessionControlTargetFingerprintDomain =
    "mira-dashboard:gateway-session-control-target:v1\0";

export interface GatewaySessionControlAuditStore {
    readonly append: (event: SecurityAuditEvent) => Promise<void>;
}

export interface GatewaySessionControlRequestContext {
    readonly actor: SecurityAuditActor;
    readonly requestId: string;
}

export interface GatewaySessionControlAuditAttempt {
    readonly action: GatewaySessionAction;
    readonly actor: SecurityAuditActor;
    readonly requestId: string;
    readonly targetFingerprint: string;
}

export interface GatewaySessionControlAuditSettlementFailure {
    readonly action: GatewaySessionAction;
    readonly cause: unknown;
    readonly outcome: "failed" | "partial" | "succeeded";
    readonly requestId: string;
    readonly targetFingerprint: string;
}

export interface GatewaySessionControlAuditPort {
    readonly begin: (input: {
        readonly action: GatewaySessionAction;
        readonly context: GatewaySessionControlRequestContext;
        readonly key: string;
    }) => Promise<GatewaySessionControlAuditAttempt>;
    readonly settle: (
        attempt: GatewaySessionControlAuditAttempt,
        outcome: "failed" | "partial" | "succeeded"
    ) => Promise<"partial" | "settled">;
}

export interface GatewaySessionControlAuditOptions {
    readonly generateId?: () => string;
    readonly now?: () => Date;
    readonly onSettlementFailure?: (
        failure: GatewaySessionControlAuditSettlementFailure
    ) => void;
    readonly store: GatewaySessionControlAuditStore;
}

/**
 * Returns a domain-separated, bounded identifier that never persists a session key.
 * @param key Validated Gateway session key used only as hash input.
 * @returns Stable lowercase SHA-256 fingerprint with an explicit algorithm prefix.
 */
export function fingerprintGatewaySessionControlTarget(key: string): string {
    return `sha256:${sha256Hex(`${gatewaySessionControlTargetFingerprintDomain}${key}`)}`;
}

function actionName(action: GatewaySessionAction): string {
    return `gateway.sessions.${action}`;
}

/**
 * Creates the fail-closed two-stage audit boundary for external session controls.
 * The attempted row is durable before dispatch; terminal-row failures are reported but
 * never alter the already-known upstream result.
 * @param options Append-only persistence, clock, identifiers, and failure reporter.
 * @returns Frozen audit port used by the session control service.
 */
export function createGatewaySessionControlAudit(
    options: GatewaySessionControlAuditOptions
): GatewaySessionControlAuditPort {
    const generateId = options.generateId ?? (() => Bun.randomUUIDv7());
    const now = options.now ?? (() => new Date());

    const append = (
        attempt: GatewaySessionControlAuditAttempt,
        settlement: "attempted" | "failed" | "partial" | "succeeded"
    ): Promise<void> =>
        options.store.append(
            createSecurityAuditEvent({
                action: actionName(attempt.action),
                actor: attempt.actor,
                id: generateId(),
                ...(settlement === "partial"
                    ? { metadata: { settlement: "partial" } }
                    : {}),
                occurredAt: now(),
                outcome: settlement === "partial" ? "failed" : settlement,
                requestId: attempt.requestId,
                targetId: attempt.targetFingerprint,
                targetType: "gateway-session",
            })
        );

    const audit: GatewaySessionControlAuditPort = {
        async begin({ action, context, key }) {
            const attempt = Object.freeze({
                action,
                actor: Object.freeze({ ...context.actor }),
                requestId: context.requestId,
                targetFingerprint: fingerprintGatewaySessionControlTarget(key),
            });
            await append(attempt, "attempted");
            return attempt;
        },
        async settle(attempt, outcome) {
            try {
                await append(attempt, outcome);
                return "settled";
            } catch (error) {
                try {
                    options.onSettlementFailure?.(
                        Object.freeze({
                            action: attempt.action,
                            cause: error,
                            outcome,
                            requestId: attempt.requestId,
                            targetFingerprint: attempt.targetFingerprint,
                        })
                    );
                } catch {
                    // Operational reporting cannot rewrite an already-known result.
                }
                return "partial";
            }
        },
    };
    return Object.freeze(audit);
}

/** Missing audit persistence is a hard control boundary while reads remain available. */
export const unavailableGatewaySessionControlAudit: GatewaySessionControlAuditPort =
    Object.freeze({
        begin: () => Promise.reject(new Error("Gateway session audit is unavailable")),
        settle: () => Promise.resolve<"partial">("partial"),
    });
