import { and, eq, isNull, sql } from "drizzle-orm";
import * as v from "valibot";

import { users } from "../../database/schema/users.ts";
import { userInsertSchema, userSelectSchema } from "../../database/validation/users.ts";
import type {
    SecurityPersistenceDatabase,
    SecurityUserInsert,
    SecurityUserMfaStateUpdateInput,
    SecurityUserPasswordResetInput,
    SecurityUserPasswordUpdateInput,
    SecurityUserRecord,
} from "./securityPersistenceTypes.ts";

function parseSecurityUser(row: unknown): SecurityUserRecord {
    return v.parse(userSelectSchema, row);
}

/** Focused validated persistence for security user identity state. */
export class DrizzleSecurityUserStore {
    readonly #database: SecurityPersistenceDatabase;

    constructor(database: SecurityPersistenceDatabase) {
        this.#database = database;
    }

    countUsers(): number {
        const row = this.#database
            .select({ count: sql<number>`count(*)` })
            .from(users)
            .get();
        const count = row?.count;
        if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
            throw new Error("Security user store returned an invalid user count");
        }
        return count;
    }

    findUserById(userId: string): SecurityUserRecord | undefined {
        const row = this.#database.select().from(users).where(eq(users.id, userId)).get();
        return row === undefined ? undefined : parseSecurityUser(row);
    }

    findUserByUsername(username: string): SecurityUserRecord | undefined {
        const row = this.#database
            .select()
            .from(users)
            .where(eq(users.username, username))
            .get();
        return row === undefined ? undefined : parseSecurityUser(row);
    }

    insertUser(input: SecurityUserInsert): SecurityUserRecord {
        const row = this.#database
            .insert(users)
            .values(v.parse(userInsertSchema, input))
            .returning()
            .get();
        if (row === undefined) {
            throw new Error("Security user insert returned no row");
        }
        return parseSecurityUser(row);
    }

    updateMfaState(
        input: SecurityUserMfaStateUpdateInput
    ): SecurityUserRecord | undefined {
        const expectedMfaState =
            input.expectedMfaEnabledAt === null
                ? isNull(users.mfaEnabledAt)
                : eq(users.mfaEnabledAt, input.expectedMfaEnabledAt);
        const row = this.#database
            .update(users)
            .set({
                authenticationVersion: sql`${users.authenticationVersion} + 1`,
                mfaEnabledAt: input.mfaEnabledAt,
                updatedAt: input.updatedAt,
            })
            .where(
                and(
                    eq(users.id, input.userId),
                    eq(users.authenticationVersion, input.expectedAuthenticationVersion),
                    expectedMfaState,
                    isNull(users.disabledAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseSecurityUser(row);
    }

    updatePassword(
        input: SecurityUserPasswordUpdateInput
    ): SecurityUserRecord | undefined {
        const row = this.#database
            .update(users)
            .set({
                authenticationVersion: sql`${users.authenticationVersion} + 1`,
                passwordHash: input.passwordHash,
                updatedAt: input.updatedAt,
            })
            .where(
                and(
                    eq(users.id, input.userId),
                    eq(users.authenticationVersion, input.expectedAuthenticationVersion),
                    eq(users.passwordHash, input.expectedPasswordHash),
                    isNull(users.disabledAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseSecurityUser(row);
    }

    resetPassword(input: SecurityUserPasswordResetInput): SecurityUserRecord | undefined {
        const expectedMfaState =
            input.expectedMfaEnabledAt === null
                ? isNull(users.mfaEnabledAt)
                : eq(users.mfaEnabledAt, input.expectedMfaEnabledAt);
        const row = this.#database
            .update(users)
            .set({
                authenticationVersion: sql`${users.authenticationVersion} + 1`,
                ...(input.resetMfa ? { mfaEnabledAt: null } : {}),
                passwordHash: input.passwordHash,
                updatedAt: input.updatedAt,
            })
            .where(
                and(
                    eq(users.id, input.userId),
                    eq(users.authenticationVersion, input.expectedAuthenticationVersion),
                    eq(users.passwordHash, input.expectedPasswordHash),
                    expectedMfaState,
                    isNull(users.disabledAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseSecurityUser(row);
    }
}
