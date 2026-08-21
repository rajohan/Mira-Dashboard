import * as v from "valibot";

import {
    type GetActiveTerminalSessionOutput,
    getActiveTerminalSessionOutputSchema,
    type PrepareTerminalSessionInput,
    terminalConnectionTicketSchema,
    terminalConnectionTicketTtlMs,
    terminalSessionSummarySchema,
    terminalWebSocketProtocol,
    type TerminalConnectionTicket,
} from "../../../contracts/terminal.ts";
import type { TerminalRootRegistry } from "../../platform/terminal/rootRegistry.ts";
import { TerminalRootAccessError } from "../../platform/terminal/rootRegistry.ts";
import {
    generateOpaqueToken,
    type GeneratedOpaqueToken,
} from "../../shared/opaqueToken.ts";
import {
    TerminalSessionBrokerError,
    type TerminalSessionBroker,
    type TerminalSessionOwner,
    type TerminalTicketRegistration,
} from "./brokerPort.ts";
import { TerminalServiceError } from "./errors.ts";
import type {
    TerminalOperationAuditContext,
    TerminalOperationAuditWriter,
} from "./operationAudit.ts";

export interface TerminalServiceDependencies {
    readonly auditWriter: TerminalOperationAuditWriter;
    readonly broker: TerminalSessionBroker;
    readonly generateId?: () => string;
    readonly generateToken?: () => GeneratedOpaqueToken;
    readonly nowMs?: () => number;
    readonly roots: TerminalRootRegistry;
}

export interface TerminalService {
    readonly getActiveSession: (
        actor: TerminalSessionOwner,
        signal?: AbortSignal
    ) => Promise<GetActiveTerminalSessionOutput>;
    readonly getRuntime: TerminalRootRegistry["runtime"];
    readonly prepareResume: (
        actor: TerminalSessionOwner,
        input: { readonly afterSequence: number; readonly sessionId: string },
        audit: TerminalOperationAuditContext,
        signal?: AbortSignal
    ) => Promise<TerminalConnectionTicket>;
    readonly prepareSession: (
        actor: TerminalSessionOwner,
        input: PrepareTerminalSessionInput,
        audit: TerminalOperationAuditContext,
        signal?: AbortSignal
    ) => Promise<TerminalConnectionTicket>;
    readonly terminateSession: (
        actor: TerminalSessionOwner,
        sessionId: string,
        audit: TerminalOperationAuditContext,
        signal?: AbortSignal
    ) => Promise<{ readonly sessionId: string; readonly terminated: true }>;
}

function serviceFailure(error: unknown): TerminalServiceError {
    if (error instanceof TerminalServiceError) return error;
    if (error instanceof TerminalSessionBrokerError) {
        return new TerminalServiceError(error.reason, error);
    }
    if (error instanceof TerminalRootAccessError) {
        return new TerminalServiceError(
            error.reason === "root-unavailable" ? "unavailable" : "invalid-input",
            error
        );
    }
    return new TerminalServiceError("unavailable", error);
}

function ticketRegistration(
    generated: GeneratedOpaqueToken,
    afterSequence: number,
    expiresAtMs: number
): TerminalTicketRegistration {
    return Object.freeze({
        afterSequence,
        expiresAtMs,
        prefix: generated.prefix,
        validatorHash: generated.validatorHash,
    });
}

function connectionTicket(
    generated: GeneratedOpaqueToken,
    sessionId: string,
    afterSequence: number,
    expiresAtMs: number
): TerminalConnectionTicket {
    return v.parse(terminalConnectionTicketSchema, {
        afterSequence,
        connectionToken: generated.token,
        expiresAtMs,
        sessionId,
        webSocketProtocol: terminalWebSocketProtocol,
        webSocketUrl: `/api/terminal/sessions/${sessionId}/socket`,
    });
}

function checkedNow(nowMs: () => number): number {
    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
        throw new TerminalServiceError("unavailable");
    }
    return now;
}

/**
 * Creates the session-only control plane for worker-owned interactive PTYs.
 * @returns The terminal lifecycle service.
 */
export function createTerminalService(
    dependencies: TerminalServiceDependencies
): TerminalService {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const generateToken =
        dependencies.generateToken ?? (() => generateOpaqueToken("terminal"));
    const nowMs = dependencies.nowMs ?? Date.now;

    async function audit(
        context: TerminalOperationAuditContext,
        event: Omit<
            Parameters<TerminalOperationAuditWriter["record"]>[0],
            keyof TerminalOperationAuditContext
        >
    ): Promise<void> {
        try {
            await dependencies.auditWriter.record({ ...context, ...event });
        } catch (error) {
            throw new TerminalServiceError("audit-unavailable", error);
        }
    }

    return Object.freeze<TerminalService>({
        async getActiveSession(actor, signal) {
            try {
                const session = await dependencies.broker.getActive(actor, signal);
                return v.parse(
                    getActiveTerminalSessionOutputSchema,
                    session === undefined
                        ? { status: "none" }
                        : {
                              session: v.parse(terminalSessionSummarySchema, session),
                              status: "active",
                          }
                );
            } catch (error) {
                throw serviceFailure(error);
            }
        },
        getRuntime: dependencies.roots.runtime,
        async prepareResume(actor, input, auditContext, signal) {
            const token = generateToken();
            const expiresAtMs = checkedNow(nowMs) + terminalConnectionTicketTtlMs;
            await audit(auditContext, {
                operation: "resume",
                sessionId: input.sessionId,
                settlement: "attempted",
            });
            try {
                await dependencies.broker.prepareResume(
                    {
                        owner: actor,
                        sessionId: input.sessionId,
                        ticket: ticketRegistration(
                            token,
                            input.afterSequence,
                            expiresAtMs
                        ),
                    },
                    signal
                );
                await audit(auditContext, {
                    operation: "resume",
                    sessionId: input.sessionId,
                    settlement: "succeeded",
                });
                return connectionTicket(
                    token,
                    input.sessionId,
                    input.afterSequence,
                    expiresAtMs
                );
            } catch (error) {
                try {
                    await audit(auditContext, {
                        operation: "resume",
                        sessionId: input.sessionId,
                        settlement: "failed",
                    });
                } catch {
                    // The primary broker failure remains actionable.
                }
                throw serviceFailure(error);
            }
        },
        async prepareSession(actor, input, auditContext, signal) {
            const sessionId = generateId();
            const token = generateToken();
            const expiresAtMs = checkedNow(nowMs) + terminalConnectionTicketTtlMs;
            let reserved = false;
            let absoluteStartingDirectory: string;
            try {
                absoluteStartingDirectory = await dependencies.roots.resolveDirectory(
                    input.location,
                    signal
                );
            } catch (error) {
                throw serviceFailure(error);
            }
            await audit(auditContext, {
                operation: "prepare",
                rootId: input.location.rootId,
                sessionId,
                settlement: "attempted",
            });
            try {
                await dependencies.broker.reserve(
                    {
                        absoluteStartingDirectory,
                        dimensions: input.dimensions,
                        location: input.location,
                        owner: actor,
                        sessionId,
                        ticket: ticketRegistration(token, 0, expiresAtMs),
                    },
                    signal
                );
                reserved = true;
                await audit(auditContext, {
                    operation: "prepare",
                    rootId: input.location.rootId,
                    sessionId,
                    settlement: "succeeded",
                });
                return connectionTicket(token, sessionId, 0, expiresAtMs);
            } catch (error) {
                if (reserved) {
                    await dependencies.broker
                        .terminate({ owner: actor, sessionId })
                        .catch(() => {});
                }
                try {
                    await audit(auditContext, {
                        operation: "prepare",
                        rootId: input.location.rootId,
                        sessionId,
                        settlement: "failed",
                    });
                } catch {
                    // Preserve the initiating failure.
                }
                throw serviceFailure(error);
            }
        },
        async terminateSession(actor, sessionId, auditContext, signal) {
            await audit(auditContext, {
                operation: "terminate",
                sessionId,
                settlement: "attempted",
            });
            try {
                await dependencies.broker.terminate({ owner: actor, sessionId }, signal);
                await audit(auditContext, {
                    operation: "terminate",
                    sessionId,
                    settlement: "succeeded",
                });
                return Object.freeze({ sessionId, terminated: true });
            } catch (error) {
                try {
                    await audit(auditContext, {
                        operation: "terminate",
                        sessionId,
                        settlement: "failed",
                    });
                } catch {
                    // Preserve the initiating broker failure.
                }
                throw serviceFailure(error);
            }
        },
    });
}
