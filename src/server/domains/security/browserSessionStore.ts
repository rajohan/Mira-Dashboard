import { and, desc, eq, gt, inArray, lte, ne, or } from "drizzle-orm";
import * as v from "valibot";

import { authSessions } from "../../database/schema/authSessions.ts";
import {
    authSessionInsertSchema,
    authSessionSelectSchema,
} from "../../database/validation/authSessions.ts";
import type {
    AuthenticationSessionListInput,
    BrowserSessionInsert,
    BrowserSessionRecord,
    DeleteBrowserSessionForRotationInput,
    PruneBrowserSessionsInput,
    SecurityPersistenceDatabase,
} from "./securityPersistenceTypes.ts";

function parseBrowserSession(row: unknown): BrowserSessionRecord {
    return v.parse(authSessionSelectSchema, row);
}

/** Focused validated persistence for browser authentication sessions. */
export class DrizzleBrowserSessionStore {
    readonly #database: SecurityPersistenceDatabase;

    constructor(database: SecurityPersistenceDatabase) {
        this.#database = database;
    }

    deleteOtherSessions(userId: string, retainedSessionId: string): number {
        return this.#database
            .delete(authSessions)
            .where(
                and(
                    eq(authSessions.userId, userId),
                    ne(authSessions.id, retainedSessionId)
                )
            )
            .run().changes;
    }

    deleteSession(userId: string, sessionId: string): BrowserSessionRecord | undefined {
        const row = this.#database
            .delete(authSessions)
            .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
            .returning()
            .get();
        return row === undefined ? undefined : parseBrowserSession(row);
    }

    deleteSessionForRotation(
        input: DeleteBrowserSessionForRotationInput
    ): BrowserSessionRecord | undefined {
        const row = this.#database
            .delete(authSessions)
            .where(
                and(
                    eq(authSessions.id, input.sessionId),
                    eq(authSessions.userId, input.userId),
                    eq(
                        authSessions.authenticationVersion,
                        input.expectedAuthenticationVersion
                    ),
                    eq(authSessions.validatorHash, input.expectedValidatorHash)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseBrowserSession(row);
    }

    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined {
        const row = this.#database
            .select()
            .from(authSessions)
            .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
            .get();
        return row === undefined ? undefined : parseBrowserSession(row);
    }

    insertSession(input: BrowserSessionInsert): BrowserSessionRecord {
        const row = this.#database
            .insert(authSessions)
            .values(v.parse(authSessionInsertSchema, input))
            .returning()
            .get();
        if (row === undefined) {
            throw new Error("Browser session insert returned no row");
        }
        return parseBrowserSession(row);
    }

    listSessions(input: AuthenticationSessionListInput): BrowserSessionRecord[] {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
            throw new RangeError("Browser session list limit is invalid");
        }
        return this.#database
            .select()
            .from(authSessions)
            .where(
                and(
                    eq(authSessions.userId, input.userId),
                    eq(authSessions.authenticationVersion, input.authenticationVersion),
                    gt(authSessions.expiresAt, input.checkedAt),
                    gt(authSessions.lastSeenAt, input.idleAfter)
                )
            )
            .orderBy(
                desc(authSessions.lastSeenAt),
                desc(authSessions.createdAt),
                desc(authSessions.id)
            )
            .limit(input.limit)
            .all()
            .map((row) => parseBrowserSession(row));
    }

    pruneSessions(input: PruneBrowserSessionsInput): number {
        if (!Number.isSafeInteger(input.maximumSessions) || input.maximumSessions < 1) {
            throw new RangeError("Maximum browser session count is invalid");
        }
        const belongsToUser = eq(authSessions.userId, input.userId);
        const isExpired = lte(authSessions.expiresAt, input.checkedAt);
        const isIdle = lte(authSessions.lastSeenAt, input.idleBefore);
        const hasStaleAuthenticationVersion = ne(
            authSessions.authenticationVersion,
            input.expectedAuthenticationVersion
        );
        const isInactive = or(isExpired, isIdle, hasStaleAuthenticationVersion);
        const inactiveChanges = this.#database
            .delete(authSessions)
            .where(and(belongsToUser, isInactive))
            .run().changes;
        const excessSessionIds = this.#database
            .select({ id: authSessions.id })
            .from(authSessions)
            .where(
                and(
                    eq(authSessions.userId, input.userId),
                    ne(authSessions.id, input.retainedSessionId)
                )
            )
            .orderBy(
                desc(authSessions.lastSeenAt),
                desc(authSessions.createdAt),
                desc(authSessions.id)
            )
            .limit(2_147_483_647)
            .offset(input.maximumSessions - 1);
        const overflowChanges = this.#database
            .delete(authSessions)
            .where(inArray(authSessions.id, excessSessionIds))
            .run().changes;
        return inactiveChanges + overflowChanges;
    }

    touchSession(
        userId: string,
        sessionId: string,
        touchedAt: Date,
        writeBefore: Date
    ): BrowserSessionRecord | undefined {
        const row = this.#database
            .update(authSessions)
            .set({ lastSeenAt: touchedAt })
            .where(
                and(
                    eq(authSessions.id, sessionId),
                    eq(authSessions.userId, userId),
                    lte(authSessions.lastSeenAt, writeBefore),
                    gt(authSessions.expiresAt, touchedAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseBrowserSession(row);
    }
}
