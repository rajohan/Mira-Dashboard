import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { authPendingLogins } from "../../../database/schema/authPendingLogins.ts";
import { userRecoveryCodes } from "../../../database/schema/userRecoveryCodes.ts";
import { userTotpFactors } from "../../../database/schema/userTotpFactors.ts";
import { DrizzleAuthenticationRateLimitStore } from "../authenticationRateLimitStore.ts";
import { DrizzleBrowserSessionStore } from "../browserSessionStore.ts";
import type { SecurityPersistenceDatabase } from "../securityPersistenceTypes.ts";
import { DrizzleSecurityUserStore } from "../securityUserStore.ts";
import {
    checkedMfaCount,
    checkedMfaListLimit,
    parsePendingLogin,
    parseRecoveryCode,
    parseTotpFactor,
} from "./lifecycleRepositoryRecords.ts";
import type {
    MfaLifecycleReader,
    MfaPendingLoginRecord,
    MfaRateLimitBucket,
    MfaRecoveryCodeRecord,
    MfaSessionRecord,
    MfaTotpFactorRecord,
    MfaUserRecord,
} from "./lifecycleRepositoryTypes.ts";

export class DrizzleMfaLifecycleReader implements MfaLifecycleReader {
    protected readonly database: SecurityPersistenceDatabase;
    protected readonly rateLimits: DrizzleAuthenticationRateLimitStore;
    protected readonly sessions: DrizzleBrowserSessionStore;
    protected readonly users: DrizzleSecurityUserStore;

    constructor(database: SecurityPersistenceDatabase) {
        this.database = database;
        this.rateLimits = new DrizzleAuthenticationRateLimitStore(database);
        this.sessions = new DrizzleBrowserSessionStore(database);
        this.users = new DrizzleSecurityUserStore(database);
    }

    countConfirmedTotpFactors(userId: string): number {
        const belongsToUser = eq(userTotpFactors.userId, userId);
        const isConfirmed = isNotNull(userTotpFactors.confirmedAt);
        return checkedMfaCount(
            this.database
                .select({ count: sql<number>`count(*)` })
                .from(userTotpFactors)
                .where(and(belongsToUser, isConfirmed))
                .get()
        );
    }

    countTotpFactors(userId: string): number {
        return checkedMfaCount(
            this.database
                .select({ count: sql<number>`count(*)` })
                .from(userTotpFactors)
                .where(eq(userTotpFactors.userId, userId))
                .get()
        );
    }

    countUnusedRecoveryCodes(userId: string): number {
        const belongsToUser = eq(userRecoveryCodes.userId, userId);
        const isUnused = isNull(userRecoveryCodes.usedAt);
        return checkedMfaCount(
            this.database
                .select({ count: sql<number>`count(*)` })
                .from(userRecoveryCodes)
                .where(and(belongsToUser, isUnused))
                .get()
        );
    }

    findConfirmedTotpFactor(
        userId: string,
        factorId: string
    ): MfaTotpFactorRecord | undefined {
        const row = this.database
            .select()
            .from(userTotpFactors)
            .where(
                and(
                    eq(userTotpFactors.id, factorId),
                    eq(userTotpFactors.userId, userId),
                    isNotNull(userTotpFactors.confirmedAt)
                )
            )
            .get();
        return row === undefined ? undefined : parseTotpFactor(row);
    }

    findPendingLogin(id: string): MfaPendingLoginRecord | undefined {
        const row = this.database
            .select()
            .from(authPendingLogins)
            .where(eq(authPendingLogins.id, id))
            .get();
        return row === undefined ? undefined : parsePendingLogin(row);
    }

    findRateLimitBucket(bucketKey: string): MfaRateLimitBucket | undefined {
        return this.rateLimits.findRateLimitBucket(bucketKey);
    }

    findRecoveryCode(
        userId: string,
        selector: string
    ): MfaRecoveryCodeRecord | undefined {
        const row = this.database
            .select()
            .from(userRecoveryCodes)
            .where(
                and(
                    eq(userRecoveryCodes.userId, userId),
                    eq(userRecoveryCodes.selector, selector)
                )
            )
            .get();
        return row === undefined ? undefined : parseRecoveryCode(row);
    }

    findSession(userId: string, sessionId: string): MfaSessionRecord | undefined {
        return this.sessions.findSession(userId, sessionId);
    }

    findTotpFactor(userId: string, factorId: string): MfaTotpFactorRecord | undefined {
        const row = this.database
            .select()
            .from(userTotpFactors)
            .where(
                and(eq(userTotpFactors.id, factorId), eq(userTotpFactors.userId, userId))
            )
            .get();
        return row === undefined ? undefined : parseTotpFactor(row);
    }

    findUserById(userId: string): MfaUserRecord | undefined {
        return this.users.findUserById(userId);
    }

    listConfirmedTotpFactors(userId: string, limit: number): MfaTotpFactorRecord[] {
        return this.database
            .select()
            .from(userTotpFactors)
            .where(
                and(
                    eq(userTotpFactors.userId, userId),
                    isNotNull(userTotpFactors.confirmedAt)
                )
            )
            .orderBy(asc(userTotpFactors.createdAt), asc(userTotpFactors.id))
            .limit(checkedMfaListLimit(limit))
            .all()
            .map((row) => parseTotpFactor(row));
    }

    listRecoveryCodes(userId: string, limit: number): MfaRecoveryCodeRecord[] {
        return this.database
            .select()
            .from(userRecoveryCodes)
            .where(eq(userRecoveryCodes.userId, userId))
            .orderBy(asc(userRecoveryCodes.createdAt), asc(userRecoveryCodes.id))
            .limit(checkedMfaListLimit(limit))
            .all()
            .map((row) => parseRecoveryCode(row));
    }
}
