import * as v from "valibot";

import {
    activeAutomationPrincipalMaximum,
    createAutomationPrincipalResultSchema,
    disableAutomationPrincipalResultSchema,
    listAutomationPrincipalsResultSchema,
    replaceAutomationCapabilitiesResultSchema,
} from "../../../../contracts/automationSecurity.ts";
import { administrationActor } from "./lifecycleContext.ts";
import type { AutomationSecurityLifecycleContext } from "./lifecycleContext.ts";
import {
    buildCredentialCandidates,
    credentialExpiry,
    generateCredentialMaterials,
} from "./lifecycleCredentials.ts";
import {
    capabilityChanges,
    currentPrincipal,
    validatedCapabilities,
} from "./lifecyclePolicy.ts";
import {
    AutomationLifecycleStateChangedError,
    assertNoFutureCredentialHistory,
    assertNoFuturePrincipalHistory,
    principalSummary,
} from "./lifecycleSummaries.ts";
import type { AutomationSecurityLifecycleService } from "./lifecycleTypes.ts";

class AutomationCredentialCandidatesUnavailableError extends Error {}

function stateConflict(error: unknown): { readonly status: "conflict" } {
    if (error instanceof AutomationLifecycleStateChangedError) {
        return { status: "conflict" as const };
    }
    throw error;
}

function sessionChangedFromStateChange(error: unknown): {
    readonly status: "session-changed";
} {
    if (error instanceof AutomationLifecycleStateChangedError) {
        return { status: "session-changed" };
    }
    throw error;
}

function creationFailure(error: unknown) {
    if (error instanceof AutomationLifecycleStateChangedError) {
        return { status: "conflict" as const };
    }
    if (error instanceof AutomationCredentialCandidatesUnavailableError) {
        return { status: "unavailable" as const };
    }
    throw error;
}

/**
 * Creates principal inventory, creation, authorization, and disable operations.
 * @param context Validated policy, repository, clock, generation, and audit context.
 * @returns Principal-focused slice of the automation lifecycle service.
 */
export function createAutomationPrincipalOperations(
    context: AutomationSecurityLifecycleContext
): Pick<
    AutomationSecurityLifecycleService,
    "createPrincipal" | "disablePrincipal" | "listPrincipals" | "replaceCapabilities"
> {
    return {
        async createPrincipal(identity, input, metadata) {
            const generation = generateCredentialMaterials(context);
            try {
                return await context.repository.withImmediateTransaction((unit) => {
                    const createdAt = context.now();
                    const policy = context.authorizeAdministration(
                        unit,
                        identity,
                        createdAt
                    );
                    if (policy !== undefined) return policy;
                    assertNoFuturePrincipalHistory(unit, createdAt);
                    if (generation.status === "unavailable") {
                        return { status: "unavailable" as const };
                    }
                    const expiresAt = credentialExpiry(
                        input.initialCredential,
                        createdAt
                    );
                    if (expiresAt === undefined) {
                        return { status: "invalid-expiry" as const };
                    }
                    const candidates = buildCredentialCandidates(generation.materials, {
                        createdAt,
                        expiresAt,
                        label: input.initialCredential.label,
                        principalId: input.id,
                        replacesCredentialId: null,
                    }).map((candidate) =>
                        Object.freeze({
                            ...candidate,
                            result: v.parse(createAutomationPrincipalResultSchema, {
                                credential: candidate.summary,
                                principal: {
                                    activeCredentialCount: 1,
                                    authorizationVersion: 1,
                                    capabilities: input.capabilities,
                                    createdAtMs: createdAt.getTime(),
                                    disabled: false,
                                    id: input.id,
                                    label: input.label,
                                    totalCredentialCount: 1,
                                    updatedAtMs: createdAt.getTime(),
                                },
                                token: candidate.token.token,
                            }),
                        })
                    );
                    if (
                        unit.findPrincipal(input.id) !== undefined ||
                        unit.countEnabledPrincipals() >= activeAutomationPrincipalMaximum
                    ) {
                        return { status: "conflict" as const };
                    }
                    const principal = unit.insertPrincipalIfAvailable({
                        createdAt,
                        disabledAt: null,
                        id: input.id,
                        label: input.label,
                        updatedAt: createdAt,
                    });
                    if (principal === undefined) return { status: "conflict" as const };
                    unit.insertCapabilities(
                        input.capabilities.map((capability) => ({
                            capability,
                            grantedAt: createdAt,
                            principalId: principal.id,
                        }))
                    );
                    for (const candidate of candidates) {
                        const credential = unit.insertCredentialIfAvailable(
                            candidate.insert
                        );
                        if (credential === undefined) continue;
                        context.audit(unit, {
                            action: "automation.principal.create",
                            actor: administrationActor(identity),
                            metadata: { addedCapabilities: input.capabilities },
                            occurredAt: createdAt,
                            outcome: "succeeded",
                            requestId: metadata.requestId,
                            targetId: principal.id,
                            targetType: "automation_principal",
                        });
                        return {
                            result: candidate.result,
                            status: "created" as const,
                        };
                    }
                    throw new AutomationCredentialCandidatesUnavailableError();
                });
            } catch (error) {
                return creationFailure(error);
            }
        },

        async disablePrincipal(identity, input, metadata) {
            try {
                return await context.repository.withImmediateTransaction((unit) => {
                    const disabledAt = context.now();
                    const policy = context.authorizeAdministration(
                        unit,
                        identity,
                        disabledAt
                    );
                    if (policy !== undefined) return policy;
                    const existing = unit.findPrincipal(input.principalId);
                    if (existing === undefined) return { status: "not-found" as const };
                    if (existing.disabledAt !== null) {
                        return {
                            result: v.parse(disableAutomationPrincipalResultSchema, {
                                changed: false,
                                principal: principalSummary(unit, existing, disabledAt),
                                revokedCredentials: 0,
                            }),
                            status: "disabled" as const,
                        };
                    }
                    const principal = currentPrincipal(unit, {
                        checkedAt: disabledAt,
                        expectedAuthorizationVersion: input.expectedAuthorizationVersion,
                        principalId: input.principalId,
                    });
                    if (principal === undefined) return { status: "not-found" as const };
                    validatedCapabilities(unit, principal, disabledAt);
                    const disabled = unit.disablePrincipal({
                        disabledAt,
                        expectedAuthorizationVersion: input.expectedAuthorizationVersion,
                        principalId: input.principalId,
                    });
                    if (disabled === undefined) return { status: "conflict" as const };
                    const revokedCredentials = unit.revokeActiveCredentials(
                        disabled.id,
                        disabledAt
                    );
                    context.audit(unit, {
                        action: "automation.principal.disable",
                        actor: administrationActor(identity),
                        metadata: { revokedCredentials },
                        occurredAt: disabledAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: disabled.id,
                        targetType: "automation_principal",
                    });
                    return {
                        result: v.parse(disableAutomationPrincipalResultSchema, {
                            changed: true,
                            principal: principalSummary(unit, disabled, disabledAt),
                            revokedCredentials,
                        }),
                        status: "disabled" as const,
                    };
                });
            } catch (error) {
                return stateConflict(error);
            }
        },

        listPrincipals(identity, input) {
            try {
                return context.repository.withReadTransaction((reader) => {
                    const checkedAt = context.now();
                    const policy = context.authorizeSession(reader, identity, checkedAt);
                    if (policy !== undefined) return policy;
                    assertNoFuturePrincipalHistory(reader, checkedAt);
                    const rows = reader.listPrincipals({
                        ...(input.cursor === undefined
                            ? {}
                            : {
                                  beforeCreatedAt: new Date(input.cursor.createdAtMs),
                                  beforeId: input.cursor.id,
                              }),
                        limit: input.limit + 1,
                    });
                    const page = rows.slice(0, input.limit);
                    const last = page.at(-1);
                    const result = v.parse(listAutomationPrincipalsResultSchema, {
                        activePrincipalCount: reader.countEnabledPrincipals(),
                        ...(rows.length > input.limit && last !== undefined
                            ? {
                                  nextCursor: {
                                      createdAtMs: last.createdAt.getTime(),
                                      id: last.id,
                                  },
                              }
                            : {}),
                        principals: page.map((principal) =>
                            principalSummary(reader, principal, checkedAt)
                        ),
                        totalPrincipalCount: reader.countPrincipals(),
                    });
                    return { result, status: "listed" as const };
                });
            } catch (error) {
                return sessionChangedFromStateChange(error);
            }
        },

        async replaceCapabilities(identity, input, metadata) {
            try {
                return await context.repository.withImmediateTransaction((unit) => {
                    const replacedAt = context.now();
                    const policy = context.authorizeAdministration(
                        unit,
                        identity,
                        replacedAt
                    );
                    if (policy !== undefined) return policy;
                    const principal = currentPrincipal(unit, {
                        checkedAt: replacedAt,
                        expectedAuthorizationVersion: input.expectedAuthorizationVersion,
                        principalId: input.principalId,
                    });
                    if (principal === undefined) return { status: "not-found" as const };
                    const current = validatedCapabilities(unit, principal, replacedAt);
                    assertNoFutureCredentialHistory(unit, principal.id, replacedAt);
                    const changes = capabilityChanges(current, input.capabilities);
                    if (!changes.changed) {
                        return {
                            result: v.parse(replaceAutomationCapabilitiesResultSchema, {
                                changed: false,
                                principal: principalSummary(unit, principal, replacedAt),
                            }),
                            status: "replaced" as const,
                        };
                    }
                    const updated = unit.replaceCapabilities({
                        capabilities: input.capabilities,
                        expectedAuthorizationVersion: input.expectedAuthorizationVersion,
                        grantedAt: replacedAt,
                        principalId: input.principalId,
                    });
                    if (updated === undefined) return { status: "conflict" as const };
                    context.audit(unit, {
                        action: "automation.principal.capabilities.replace",
                        actor: administrationActor(identity),
                        metadata: {
                            addedCapabilities: changes.added,
                            removedCapabilities: changes.removed,
                        },
                        occurredAt: replacedAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: updated.id,
                        targetType: "automation_principal",
                    });
                    return {
                        result: v.parse(replaceAutomationCapabilitiesResultSchema, {
                            changed: true,
                            principal: principalSummary(unit, updated, replacedAt),
                        }),
                        status: "replaced" as const,
                    };
                });
            } catch (error) {
                return stateConflict(error);
            }
        },
    };
}
