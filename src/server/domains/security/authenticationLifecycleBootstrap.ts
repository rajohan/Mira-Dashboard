import type { AuthenticationLifecycleContext } from "./authenticationLifecycleContext.ts";
import type { AuthenticationLifecycleService } from "./authenticationLifecycleTypes.ts";
import {
    activeRateLimitForTargets,
    recordAuthenticationFailures,
    saturatedAuthenticationRetryAfterSeconds,
    type AuthenticationRateLimitTarget,
} from "./authenticationRateLimit.ts";
import {
    authSession,
    authUser,
    type AuthenticationRequestMetadata,
} from "./authenticationSession.ts";
import {
    AuthenticationUpstreamUnavailableError,
    AuthenticationWorkCapacityError,
    AuthenticationWorkTimeoutError,
} from "./authenticationWorkGate.ts";

type BootstrapContext = Pick<
    AuthenticationLifecycleContext,
    | "anonymousActor"
    | "audit"
    | "bootstrapRateLimitTargets"
    | "generateId"
    | "hashPassword"
    | "newSession"
    | "now"
    | "passwordWorkBudget"
    | "passwordWorkGate"
    | "pruneUserSessions"
    | "repository"
    | "verifyGatewayCredential"
>;

function recordBootstrapFailure(
    context: BootstrapContext,
    rateLimitTargets: readonly AuthenticationRateLimitTarget[],
    failedAt: Date,
    metadata: AuthenticationRequestMetadata,
    reason: "gateway_unavailable" | "invalid_gateway"
) {
    return context.repository.withImmediateTransaction((unit) => {
        if (unit.countUsers() !== 0) {
            return { status: "closed" } as const;
        }
        const activeRateLimit = activeRateLimitForTargets(
            unit,
            rateLimitTargets,
            failedAt
        );
        if (activeRateLimit !== undefined) {
            return { ...activeRateLimit, status: "rate-limited" } as const;
        }
        const recorded = recordAuthenticationFailures(unit, rateLimitTargets, failedAt);
        context.audit(unit, {
            action: "auth.bootstrap",
            actor: context.anonymousActor,
            metadata: { reason },
            occurredAt: failedAt,
            outcome: reason === "invalid_gateway" ? "denied" : "failed",
            requestId: metadata.requestId,
            targetId: "bootstrap",
            targetType: "user",
        });
        return { ...recorded, status: "recorded" } as const;
    });
}

function mapBootstrapFailure(
    failure: Awaited<ReturnType<typeof recordBootstrapFailure>>,
    fallbackStatus: "gateway-unavailable" | "invalid-gateway"
) {
    if (failure.status === "closed" || failure.status === "rate-limited") {
        return failure;
    }
    return failure.retryAfterSeconds === undefined
        ? ({ status: fallbackStatus } as const)
        : ({
              retryAfterSeconds: failure.retryAfterSeconds,
              status: "rate-limited" as const,
          } as const);
}

/**
 * Creates the first-user bootstrap operation.
 * @returns Bootstrap operation backed by the shared lifecycle context.
 */
export function createAuthenticationBootstrapOperation(
    context: BootstrapContext
): Pick<AuthenticationLifecycleService, "bootstrap"> {
    return {
        async bootstrap(input, metadata) {
            if (context.repository.countUsers() !== 0) {
                return { status: "closed" };
            }
            const rateLimitTargets = context.bootstrapRateLimitTargets(
                metadata.clientSourceId
            );
            if (context.repository.countUsers() !== 0) {
                return { status: "closed" };
            }
            const checkedAt = context.now();
            const rateLimit = activeRateLimitForTargets(
                context.repository,
                rateLimitTargets,
                checkedAt
            );
            if (rateLimit !== undefined) {
                return { ...rateLimit, status: "rate-limited" };
            }

            let settledGatewayFailure: ReturnType<typeof mapBootstrapFailure> | undefined;
            let gatewayFailureSettlement:
                | Promise<ReturnType<typeof mapBootstrapFailure>>
                | undefined;
            const settleGatewayFailure = async (
                reason: "gateway_unavailable" | "invalid_gateway",
                fallbackStatus: "gateway-unavailable" | "invalid-gateway"
            ): Promise<ReturnType<typeof mapBootstrapFailure>> => {
                if (settledGatewayFailure !== undefined) {
                    return settledGatewayFailure;
                }
                gatewayFailureSettlement ??= recordBootstrapFailure(
                    context,
                    rateLimitTargets,
                    context.now(),
                    metadata,
                    reason
                ).then((failure) => mapBootstrapFailure(failure, fallbackStatus));
                settledGatewayFailure = await gatewayFailureSettlement;
                return settledGatewayFailure;
            };

            let gatewayCredentialIsValid: boolean;
            try {
                gatewayCredentialIsValid = await context.verifyGatewayCredential(
                    input.gatewayCredential,
                    metadata,
                    {
                        shouldVerify: () => {
                            if (context.repository.countUsers() !== 0) {
                                settledGatewayFailure = { status: "closed" };
                                return false;
                            }
                            const admittedAt = context.now();
                            const admittedLimit = activeRateLimitForTargets(
                                context.repository,
                                rateLimitTargets,
                                admittedAt
                            );
                            if (admittedLimit === undefined) return true;
                            settledGatewayFailure = {
                                ...admittedLimit,
                                status: "rate-limited",
                            };
                            return false;
                        },
                        onInvalid: async () => {
                            await settleGatewayFailure(
                                "invalid_gateway",
                                "invalid-gateway"
                            );
                        },
                        onUnavailable: async () => {
                            await settleGatewayFailure(
                                "gateway_unavailable",
                                "gateway-unavailable"
                            );
                        },
                    }
                );
            } catch (error) {
                metadata.signal?.throwIfAborted();
                if (error instanceof AuthenticationWorkCapacityError) {
                    return {
                        retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                        status: "rate-limited",
                    };
                }
                if (
                    !(
                        error instanceof AuthenticationWorkTimeoutError ||
                        error instanceof AuthenticationUpstreamUnavailableError
                    )
                ) {
                    throw error;
                }
                return await settleGatewayFailure(
                    "gateway_unavailable",
                    "gateway-unavailable"
                );
            }

            metadata.signal?.throwIfAborted();
            if (settledGatewayFailure !== undefined) {
                return settledGatewayFailure;
            }
            if (!gatewayCredentialIsValid) {
                return await settleGatewayFailure("invalid_gateway", "invalid-gateway");
            }

            if (context.repository.countUsers() !== 0) {
                return { status: "closed" };
            }
            const passwordAdmission = await context.passwordWorkGate.run(async () => {
                if (context.repository.countUsers() !== 0) {
                    return { status: "closed" } as const;
                }
                const workBudget = context.passwordWorkBudget.consume();
                if (!workBudget.accepted) {
                    return {
                        retryAfterSeconds: workBudget.retryAfterSeconds,
                        status: "rate-limited",
                    } as const;
                }
                const passwordHash = await context.hashPassword(input.password);
                metadata.signal?.throwIfAborted();
                const createdAt = context.now();
                return await context.repository.withImmediateTransaction((unit) => {
                    if (unit.countUsers() !== 0) {
                        return { status: "closed" } as const;
                    }
                    const user = unit.insertUser({
                        createdAt,
                        disabledAt: null,
                        id: context.generateId(),
                        mfaEnabledAt: null,
                        passwordHash,
                        updatedAt: createdAt,
                        username: input.username,
                    });
                    const issued = context.newSession(
                        unit,
                        user,
                        createdAt,
                        metadata.userAgent
                    );
                    context.pruneUserSessions(unit, user, issued.record.id, createdAt);
                    unit.deleteRateLimitBuckets("bootstrap-gateway-source");
                    unit.deleteRateLimitBuckets("bootstrap-gateway-global");
                    context.audit(unit, {
                        action: "auth.bootstrap",
                        actor: {
                            authenticatorId: issued.record.id,
                            id: user.id,
                            kind: "user",
                        },
                        occurredAt: createdAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: user.id,
                        targetType: "user",
                    });
                    return {
                        session: authSession(issued.record, issued.record.id),
                        status: "created" as const,
                        token: issued.token,
                        user: authUser(user),
                    };
                });
            }, metadata.signal);
            if (!passwordAdmission.accepted) {
                return {
                    retryAfterSeconds: saturatedAuthenticationRetryAfterSeconds,
                    status: "rate-limited",
                };
            }
            return passwordAdmission.value;
        },
    };
}
