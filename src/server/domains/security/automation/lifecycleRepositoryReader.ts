import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { applicationCapabilities } from "../../../../contracts/security.ts";
import { automationCredentials } from "../../../database/schema/automationCredentials.ts";
import { automationPrincipalCapabilities } from "../../../database/schema/automationPrincipalCapabilities.ts";
import { automationPrincipals } from "../../../database/schema/automationPrincipals.ts";
import { DrizzleBrowserSessionStore } from "../browserSessionStore.ts";
import type { SecurityPersistenceDatabase } from "../securityPersistenceTypes.ts";
import { DrizzleSecurityUserStore } from "../securityUserStore.ts";
import {
    parseAutomationCapability,
    parseAutomationCredential,
    parseAutomationPrincipal,
} from "./lifecycleRepositoryRecords.ts";
import type {
    AutomationCredentialListInput,
    AutomationCredentialRecord,
    AutomationLifecycleReader,
    AutomationPrincipalListInput,
} from "./lifecycleRepositoryTypes.ts";

function assertListLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
        throw new RangeError("Automation administration list limit is invalid");
    }
}

function paginationBoundary(
    createdAt: AnySQLiteColumn,
    id: AnySQLiteColumn,
    beforeCreatedAt: Date | undefined,
    beforeId: string | undefined
) {
    if ((beforeCreatedAt === undefined) !== (beforeId === undefined)) {
        throw new TypeError("Automation administration cursor is incomplete");
    }
    return beforeCreatedAt === undefined || beforeId === undefined
        ? undefined
        : or(
              lt(createdAt, beforeCreatedAt),
              and(eq(createdAt, beforeCreatedAt), lt(id, beforeId))
          );
}

/** Validated automation-security reads shared by direct and transactional callers. */
export class DrizzleAutomationLifecycleReader implements AutomationLifecycleReader {
    protected readonly database: SecurityPersistenceDatabase;
    readonly #sessions: DrizzleBrowserSessionStore;
    readonly #users: DrizzleSecurityUserStore;

    constructor(database: SecurityPersistenceDatabase) {
        this.database = database;
        this.#sessions = new DrizzleBrowserSessionStore(database);
        this.#users = new DrizzleSecurityUserStore(database);
    }

    countCredentials(principalId: string): number {
        const row = this.database
            .select({ count: sql<number>`count(*)` })
            .from(automationCredentials)
            .where(eq(automationCredentials.principalId, principalId))
            .get();
        const count = row?.count;
        if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
            throw new Error("Automation credential total is invalid");
        }
        return count;
    }

    countEnabledPrincipals(): number {
        const row = this.database
            .select({ count: sql<number>`count(*)` })
            .from(automationPrincipals)
            .where(isNull(automationPrincipals.disabledAt))
            .get();
        const count = row?.count;
        if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
            throw new Error("Automation principal count is invalid");
        }
        return count;
    }

    countPrincipals(): number {
        const row = this.database
            .select({ count: sql<number>`count(*)` })
            .from(automationPrincipals)
            .get();
        const count = row?.count;
        if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
            throw new Error("Automation principal total is invalid");
        }
        return count;
    }

    countActiveCredentials(principalId: string, checkedAt: Date): number {
        const credentialHasNoExpiry = isNull(automationCredentials.expiresAt);
        const credentialExpiresLater = gt(automationCredentials.expiresAt, checkedAt);
        const row = this.database
            .select({ count: sql<number>`count(*)` })
            .from(automationCredentials)
            .where(
                and(
                    eq(automationCredentials.principalId, principalId),
                    isNull(automationCredentials.revokedAt),
                    lte(automationCredentials.createdAt, checkedAt),
                    or(credentialHasNoExpiry, credentialExpiresLater)
                )
            )
            .get();
        const count = row?.count;
        if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
            throw new Error("Automation credential count is invalid");
        }
        return count;
    }

    findCredential(
        principalId: string,
        credentialId: string
    ): AutomationCredentialRecord | undefined {
        const row = this.database
            .select()
            .from(automationCredentials)
            .where(
                and(
                    eq(automationCredentials.principalId, principalId),
                    eq(automationCredentials.id, credentialId)
                )
            )
            .get();
        return row === undefined ? undefined : parseAutomationCredential(row);
    }

    findPrincipal(principalId: string) {
        const row = this.database
            .select()
            .from(automationPrincipals)
            .where(eq(automationPrincipals.id, principalId))
            .get();
        return row === undefined ? undefined : parseAutomationPrincipal(row);
    }

    findReplacement(
        principalId: string,
        predecessorCredentialId: string
    ): AutomationCredentialRecord | undefined {
        const row = this.database
            .select()
            .from(automationCredentials)
            .where(
                and(
                    eq(automationCredentials.principalId, principalId),
                    eq(
                        automationCredentials.replacesCredentialId,
                        predecessorCredentialId
                    ),
                    isNull(automationCredentials.revokedAt)
                )
            )
            .get();
        return row === undefined ? undefined : parseAutomationCredential(row);
    }

    findSession(userId: string, sessionId: string) {
        return this.#sessions.findSession(userId, sessionId);
    }

    findUserById(userId: string) {
        return this.#users.findUserById(userId);
    }

    hasFutureCredentialHistory(principalId: string, checkedAt: Date): boolean {
        const futureTimestamp = or(
            gt(automationCredentials.createdAt, checkedAt),
            gt(automationCredentials.revokedAt, checkedAt)
        );
        return (
            this.database
                .select({ id: automationCredentials.id })
                .from(automationCredentials)
                .where(
                    and(
                        eq(automationCredentials.principalId, principalId),
                        futureTimestamp
                    )
                )
                .limit(1)
                .get() !== undefined
        );
    }

    hasFuturePrincipalHistory(checkedAt: Date): boolean {
        return (
            this.database
                .select({ id: automationPrincipals.id })
                .from(automationPrincipals)
                .where(
                    or(
                        gt(automationPrincipals.createdAt, checkedAt),
                        gt(automationPrincipals.updatedAt, checkedAt),
                        gt(automationPrincipals.disabledAt, checkedAt)
                    )
                )
                .limit(1)
                .get() !== undefined
        );
    }

    listCapabilities(principalId: string) {
        return this.database
            .select()
            .from(automationPrincipalCapabilities)
            .where(eq(automationPrincipalCapabilities.principalId, principalId))
            .orderBy(asc(automationPrincipalCapabilities.capability))
            .limit(applicationCapabilities.length + 1)
            .all()
            .map((row) => parseAutomationCapability(row));
    }

    listCredentials(input: AutomationCredentialListInput) {
        assertListLimit(input.limit);
        const boundary = paginationBoundary(
            automationCredentials.createdAt,
            automationCredentials.id,
            input.beforeCreatedAt,
            input.beforeId
        );
        return this.database
            .select()
            .from(automationCredentials)
            .where(
                and(eq(automationCredentials.principalId, input.principalId), boundary)
            )
            .orderBy(
                desc(automationCredentials.createdAt),
                desc(automationCredentials.id)
            )
            .limit(input.limit)
            .all()
            .map((row) => parseAutomationCredential(row));
    }

    listPrincipals(input: AutomationPrincipalListInput) {
        assertListLimit(input.limit);
        const boundary = paginationBoundary(
            automationPrincipals.createdAt,
            automationPrincipals.id,
            input.beforeCreatedAt,
            input.beforeId
        );
        return this.database
            .select()
            .from(automationPrincipals)
            .where(boundary)
            .orderBy(desc(automationPrincipals.createdAt), desc(automationPrincipals.id))
            .limit(input.limit)
            .all()
            .map((row) => parseAutomationPrincipal(row));
    }
}
