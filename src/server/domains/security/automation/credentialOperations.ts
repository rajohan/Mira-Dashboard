import { compareAsc } from "date-fns";
import * as v from "valibot";

import {
    activeAutomationCredentialMaximumPerPrincipal,
    createAutomationCredentialResultSchema,
    listAutomationCredentialsResultSchema,
    revokeAutomationCredentialResultSchema,
    rotateAutomationCredentialResultSchema,
} from "../../../../contracts/automationSecurity.ts";
import { administrationActor } from "./lifecycleContext.ts";
import type { AutomationSecurityLifecycleContext } from "./lifecycleContext.ts";
import {
    buildCredentialCandidates,
    credentialExpiry,
    generateCredentialMaterials,
} from "./lifecycleCredentials.ts";
import { currentPrincipal, validatedCapabilities } from "./lifecyclePolicy.ts";
import {
    AutomationLifecycleStateChangedError,
    assertNoFutureCredentialHistory,
    credentialSummary,
    principalSummary,
} from "./lifecycleSummaries.ts";
import type { AutomationSecurityLifecycleService } from "./lifecycleTypes.ts";

function conflictFromStateChange(error: unknown): { readonly status: "conflict" } {
    if (error instanceof AutomationLifecycleStateChangedError) {
        return { status: "conflict" };
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

/**
 * Creates paginated credential reads plus create/rotate/revoke operations.
 * @param context Validated policy, repository, clock, generation, and audit context.
 * @returns Credential-focused slice of the automation lifecycle service.
 */
export function createAutomationCredentialOperations(
    context: AutomationSecurityLifecycleContext
): Pick<
    AutomationSecurityLifecycleService,
    "createCredential" | "listCredentials" | "revokeCredential" | "rotateCredential"
> {
    return {
        createCredential(identity, input, metadata) {
            const generation = generateCredentialMaterials(context);
            try {
                return context.repository.withImmediateTransaction((unit) => {
                    const createdAt = context.now();
                    const policy = context.authorizeAdministration(
                        unit,
                        identity,
                        createdAt
                    );
                    if (policy !== undefined) return policy;
                    if (generation.status === "unavailable") {
                        return { status: "unavailable" as const };
                    }
                    const expiresAt = credentialExpiry(input.credential, createdAt);
                    if (expiresAt === undefined) {
                        return { status: "invalid-expiry" as const };
                    }
                    const principal = currentPrincipal(unit, {
                        checkedAt: createdAt,
                        expectedAuthorizationVersion: input.expectedAuthorizationVersion,
                        principalId: input.principalId,
                    });
                    if (principal === undefined) return { status: "not-found" as const };
                    validatedCapabilities(unit, principal, createdAt);
                    assertNoFutureCredentialHistory(unit, principal.id, createdAt);
                    if (
                        unit.countActiveCredentials(principal.id, createdAt) >=
                        activeAutomationCredentialMaximumPerPrincipal
                    ) {
                        return { status: "conflict" as const };
                    }
                    const candidates = buildCredentialCandidates(generation.materials, {
                        createdAt,
                        expiresAt,
                        label: input.credential.label,
                        principalId: input.principalId,
                        replacesCredentialId: null,
                    }).map((candidate) =>
                        Object.freeze({
                            ...candidate,
                            result: v.parse(createAutomationCredentialResultSchema, {
                                credential: candidate.summary,
                                token: candidate.token.token,
                            }),
                        })
                    );
                    for (const candidate of candidates) {
                        const inserted = unit.insertCredentialIfAvailable(
                            candidate.insert
                        );
                        if (inserted === undefined) continue;
                        context.audit(unit, {
                            action: "automation.credential.create",
                            actor: administrationActor(identity),
                            occurredAt: createdAt,
                            outcome: "succeeded",
                            requestId: metadata.requestId,
                            targetId: inserted.id,
                            targetType: "automation_credential",
                        });
                        return {
                            result: candidate.result,
                            status: "created" as const,
                        };
                    }
                    return { status: "unavailable" as const };
                });
            } catch (error) {
                return conflictFromStateChange(error);
            }
        },

        listCredentials(identity, input) {
            try {
                return context.repository.withReadTransaction((reader) => {
                    const checkedAt = context.now();
                    const policy = context.authorizeSession(reader, identity, checkedAt);
                    if (policy !== undefined) return policy;
                    const principal = reader.findPrincipal(input.principalId);
                    if (principal === undefined) {
                        return { status: "not-found" as const };
                    }
                    // Guard-only: validates principal, grants, and history against the
                    // transaction clock before exposing credential inventory.
                    principalSummary(reader, principal, checkedAt);
                    const rows = reader.listCredentials({
                        ...(input.cursor === undefined
                            ? {}
                            : {
                                  beforeCreatedAt: new Date(input.cursor.createdAtMs),
                                  beforeId: input.cursor.id,
                              }),
                        limit: input.limit + 1,
                        principalId: input.principalId,
                    });
                    const page = rows.slice(0, input.limit);
                    const last = page.at(-1);
                    const result = v.parse(listAutomationCredentialsResultSchema, {
                        credentials: page.map((credential) =>
                            credentialSummary(credential, checkedAt)
                        ),
                        ...(rows.length > input.limit && last !== undefined
                            ? {
                                  nextCursor: {
                                      createdAtMs: last.createdAt.getTime(),
                                      id: last.id,
                                  },
                              }
                            : {}),
                        principalId: input.principalId,
                        totalCredentialCount: reader.countCredentials(input.principalId),
                    });
                    return { result, status: "listed" as const };
                });
            } catch (error) {
                return sessionChangedFromStateChange(error);
            }
        },

        revokeCredential(identity, input, metadata) {
            try {
                return context.repository.withImmediateTransaction((unit) => {
                    const revokedAt = context.now();
                    const policy = context.authorizeAdministration(
                        unit,
                        identity,
                        revokedAt
                    );
                    if (policy !== undefined) return policy;
                    const principal = currentPrincipal(unit, {
                        checkedAt: revokedAt,
                        expectedAuthorizationVersion: input.expectedAuthorizationVersion,
                        principalId: input.principalId,
                    });
                    if (principal === undefined) return { status: "not-found" as const };
                    validatedCapabilities(unit, principal, revokedAt);
                    assertNoFutureCredentialHistory(unit, principal.id, revokedAt);
                    const current = unit.findCredential(
                        input.principalId,
                        input.credentialId
                    );
                    if (current === undefined) return { status: "not-found" as const };
                    if (
                        compareAsc(current.createdAt, revokedAt) > 0 ||
                        (current.revokedAt !== null &&
                            compareAsc(current.revokedAt, revokedAt) > 0)
                    ) {
                        return { status: "conflict" as const };
                    }
                    const revoked =
                        current.revokedAt === null
                            ? unit.revokeCredential({
                                  credentialId: current.id,
                                  principalId: current.principalId,
                                  revokedAt,
                              })
                            : current;
                    if (revoked === undefined) return { status: "conflict" as const };
                    const changed = current.revokedAt === null;
                    if (changed) {
                        context.audit(unit, {
                            action: "automation.credential.revoke",
                            actor: administrationActor(identity),
                            metadata: { revoked: true },
                            occurredAt: revokedAt,
                            outcome: "succeeded",
                            requestId: metadata.requestId,
                            targetId: current.id,
                            targetType: "automation_credential",
                        });
                    }
                    return {
                        result: v.parse(revokeAutomationCredentialResultSchema, {
                            credential: credentialSummary(revoked, revokedAt),
                            revoked: changed,
                        }),
                        status: "revoked" as const,
                    };
                });
            } catch (error) {
                return conflictFromStateChange(error);
            }
        },

        rotateCredential(identity, input, metadata) {
            const generation = generateCredentialMaterials(context);
            try {
                return context.repository.withImmediateTransaction((unit) => {
                    const createdAt = context.now();
                    const policy = context.authorizeAdministration(
                        unit,
                        identity,
                        createdAt
                    );
                    if (policy !== undefined) return policy;
                    if (generation.status === "unavailable") {
                        return { status: "unavailable" as const };
                    }
                    const expiresAt = credentialExpiry(input.replacement, createdAt);
                    if (expiresAt === undefined) {
                        return { status: "invalid-expiry" as const };
                    }
                    const principal = currentPrincipal(unit, {
                        checkedAt: createdAt,
                        expectedAuthorizationVersion: input.expectedAuthorizationVersion,
                        principalId: input.principalId,
                    });
                    if (principal === undefined) return { status: "not-found" as const };
                    validatedCapabilities(unit, principal, createdAt);
                    assertNoFutureCredentialHistory(unit, principal.id, createdAt);
                    const predecessor = unit.findCredential(
                        input.principalId,
                        input.credentialId
                    );
                    if (predecessor === undefined) {
                        return { status: "not-found" as const };
                    }
                    if (
                        predecessor.revokedAt !== null ||
                        compareAsc(predecessor.createdAt, createdAt) > 0 ||
                        (predecessor.expiresAt !== null &&
                            compareAsc(predecessor.expiresAt, createdAt) <= 0) ||
                        unit.findReplacement(principal.id, predecessor.id) !==
                            undefined ||
                        unit.countActiveCredentials(principal.id, createdAt) >=
                            activeAutomationCredentialMaximumPerPrincipal
                    ) {
                        return { status: "conflict" as const };
                    }
                    const candidates = buildCredentialCandidates(
                        generation.materials.filter(
                            ({ id }) => id !== input.credentialId
                        ),
                        {
                            createdAt,
                            expiresAt,
                            label: input.replacement.label,
                            principalId: input.principalId,
                            replacesCredentialId: input.credentialId,
                        }
                    ).map((candidate) =>
                        Object.freeze({
                            ...candidate,
                            result: v.parse(rotateAutomationCredentialResultSchema, {
                                credential: candidate.summary,
                                token: candidate.token.token,
                            }),
                        })
                    );
                    for (const candidate of candidates) {
                        const replacement = unit.insertCredentialIfAvailable(
                            candidate.insert
                        );
                        if (replacement === undefined) continue;
                        context.audit(unit, {
                            action: "automation.credential.rotate",
                            actor: administrationActor(identity),
                            metadata: {
                                predecessorCredentialId: predecessor.id,
                                replacementCredentialId: replacement.id,
                            },
                            occurredAt: createdAt,
                            outcome: "succeeded",
                            requestId: metadata.requestId,
                            targetId: replacement.id,
                            targetType: "automation_credential",
                        });
                        return {
                            result: candidate.result,
                            status: "rotated" as const,
                        };
                    }
                    return { status: "unavailable" as const };
                });
            } catch (error) {
                return conflictFromStateChange(error);
            }
        },
    };
}
