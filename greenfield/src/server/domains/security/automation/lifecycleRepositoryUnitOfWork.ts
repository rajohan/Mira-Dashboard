import { and, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import * as v from "valibot";

import { automationCredentials } from "../../../database/schema/automationCredentials.ts";
import { automationPrincipalCapabilities } from "../../../database/schema/automationPrincipalCapabilities.ts";
import { automationPrincipals } from "../../../database/schema/automationPrincipals.ts";
import { automationCredentialInsertSchema } from "../../../database/validation/automationCredentials.ts";
import { automationPrincipalCapabilityInsertSchema } from "../../../database/validation/automationPrincipalCapabilities.ts";
import { automationPrincipalInsertSchema } from "../../../database/validation/automationPrincipals.ts";
import { DrizzleSecurityAuditStore } from "../securityAuditStore.ts";
import type { SecurityTransaction } from "../securityPersistenceTypes.ts";
import { DrizzleAutomationLifecycleReader } from "./lifecycleRepositoryReader.ts";
import {
    parseAutomationCredential,
    parseAutomationPrincipal,
} from "./lifecycleRepositoryRecords.ts";
import type {
    AutomationCapabilityInsert,
    AutomationCredentialInsert,
    AutomationLifecycleUnitOfWork,
    AutomationPrincipalInsert,
    DisableAutomationPrincipalInput,
    ReplaceAutomationCapabilitiesInput,
    RevokeAutomationCredentialInput,
} from "./lifecycleRepositoryTypes.ts";

const maximumAuthorizationVersion = Number.MAX_SAFE_INTEGER;

export class DrizzleAutomationLifecycleUnitOfWork
    extends DrizzleAutomationLifecycleReader
    implements AutomationLifecycleUnitOfWork
{
    readonly #audit: DrizzleSecurityAuditStore;
    readonly #transaction: SecurityTransaction;

    constructor(transaction: SecurityTransaction) {
        super(transaction);
        this.#audit = new DrizzleSecurityAuditStore(transaction);
        this.#transaction = transaction;
    }

    disablePrincipal(input: DisableAutomationPrincipalInput) {
        const row = this.#transaction
            .update(automationPrincipals)
            .set({
                authorizationVersion: sql`${automationPrincipals.authorizationVersion} + 1`,
                disabledAt: input.disabledAt,
                updatedAt: input.disabledAt,
            })
            .where(
                and(
                    eq(automationPrincipals.id, input.principalId),
                    eq(
                        automationPrincipals.authorizationVersion,
                        input.expectedAuthorizationVersion
                    ),
                    isNull(automationPrincipals.disabledAt),
                    lte(automationPrincipals.createdAt, input.disabledAt),
                    lte(automationPrincipals.updatedAt, input.disabledAt),
                    lt(
                        automationPrincipals.authorizationVersion,
                        maximumAuthorizationVersion
                    )
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseAutomationPrincipal(row);
    }

    insertAuditEvent(
        event: Parameters<DrizzleSecurityAuditStore["insertAuditEvent"]>[0]
    ): void {
        this.#audit.insertAuditEvent(event);
    }

    insertCredentialIfAvailable(input: AutomationCredentialInsert) {
        const row = this.#transaction
            .insert(automationCredentials)
            .values(v.parse(automationCredentialInsertSchema, input))
            .onConflictDoNothing()
            .returning()
            .get();
        return row === undefined ? undefined : parseAutomationCredential(row);
    }

    insertCapabilities(inputs: readonly AutomationCapabilityInsert[]): void {
        if (inputs.length === 0) return;
        this.#transaction
            .insert(automationPrincipalCapabilities)
            .values(
                inputs.map((input) =>
                    v.parse(automationPrincipalCapabilityInsertSchema, input)
                )
            )
            .run();
    }

    insertPrincipalIfAvailable(input: AutomationPrincipalInsert) {
        const row = this.#transaction
            .insert(automationPrincipals)
            .values(v.parse(automationPrincipalInsertSchema, input))
            .onConflictDoNothing()
            .returning()
            .get();
        return row === undefined ? undefined : parseAutomationPrincipal(row);
    }

    replaceCapabilities(input: ReplaceAutomationCapabilitiesInput) {
        const currentCapabilities = new Map(
            this.listCapabilities(input.principalId).map((grant) => [
                grant.capability,
                grant,
            ])
        );
        const row = this.#transaction
            .update(automationPrincipals)
            .set({
                authorizationVersion: sql`${automationPrincipals.authorizationVersion} + 1`,
                updatedAt: input.grantedAt,
            })
            .where(
                and(
                    eq(automationPrincipals.id, input.principalId),
                    eq(
                        automationPrincipals.authorizationVersion,
                        input.expectedAuthorizationVersion
                    ),
                    isNull(automationPrincipals.disabledAt),
                    lte(automationPrincipals.createdAt, input.grantedAt),
                    lte(automationPrincipals.updatedAt, input.grantedAt),
                    lt(
                        automationPrincipals.authorizationVersion,
                        maximumAuthorizationVersion
                    )
                )
            )
            .returning()
            .get();
        if (row === undefined) return;

        this.#transaction
            .delete(automationPrincipalCapabilities)
            .where(eq(automationPrincipalCapabilities.principalId, input.principalId))
            .run();
        if (input.capabilities.length > 0) {
            this.#transaction
                .insert(automationPrincipalCapabilities)
                .values(
                    input.capabilities.map((capability) =>
                        v.parse(automationPrincipalCapabilityInsertSchema, {
                            capability,
                            grantedAt:
                                currentCapabilities.get(capability)?.grantedAt ??
                                input.grantedAt,
                            principalId: input.principalId,
                        })
                    )
                )
                .run();
        }
        return parseAutomationPrincipal(row);
    }

    revokeCredential(input: RevokeAutomationCredentialInput) {
        const row = this.#transaction
            .update(automationCredentials)
            .set({ revokedAt: input.revokedAt })
            .where(
                and(
                    eq(automationCredentials.id, input.credentialId),
                    eq(automationCredentials.principalId, input.principalId),
                    isNull(automationCredentials.revokedAt),
                    lte(automationCredentials.createdAt, input.revokedAt)
                )
            )
            .returning()
            .get();
        if (row !== undefined) return parseAutomationCredential(row);

        const existing = this.findCredential(input.principalId, input.credentialId);
        return existing?.revokedAt == null ? undefined : existing;
    }

    revokeActiveCredentials(principalId: string, revokedAt: Date): number {
        const credentialHasNoExpiry = isNull(automationCredentials.expiresAt);
        const credentialExpiresLater = gt(automationCredentials.expiresAt, revokedAt);
        return this.#transaction
            .update(automationCredentials)
            .set({ revokedAt })
            .where(
                and(
                    eq(automationCredentials.principalId, principalId),
                    isNull(automationCredentials.revokedAt),
                    lte(automationCredentials.createdAt, revokedAt),
                    or(credentialHasNoExpiry, credentialExpiresLater)
                )
            )
            .run().changes;
    }
}
