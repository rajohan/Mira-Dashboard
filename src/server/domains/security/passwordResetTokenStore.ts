import { and, eq, lt } from "drizzle-orm";
import * as v from "valibot";

import { authPasswordResetTokens } from "../../database/schema/authPasswordResetTokens.ts";
import {
    authPasswordResetTokenInsertSchema,
    authPasswordResetTokenSelectSchema,
} from "../../database/validation/authPasswordResetTokens.ts";
import type { SecurityPersistenceDatabase } from "./securityPersistenceTypes.ts";

export type PasswordResetTokenRecord = v.InferOutput<
    typeof authPasswordResetTokenSelectSchema
>;
export type PasswordResetTokenInsert = v.InferOutput<
    typeof authPasswordResetTokenInsertSchema
>;

export class DrizzlePasswordResetTokenStore {
    readonly #database: SecurityPersistenceDatabase;

    constructor(database: SecurityPersistenceDatabase) {
        this.#database = database;
    }

    deleteForUser(userId: string): number {
        return this.#database
            .delete(authPasswordResetTokens)
            .where(eq(authPasswordResetTokens.userId, userId))
            .run().changes;
    }

    deleteForUserPurpose(
        userId: string,
        purpose: PasswordResetTokenRecord["purpose"]
    ): number {
        return this.#database
            .delete(authPasswordResetTokens)
            .where(
                and(
                    eq(authPasswordResetTokens.userId, userId),
                    eq(authPasswordResetTokens.purpose, purpose)
                )
            )
            .run().changes;
    }

    deleteByPrefix(prefix: string): number {
        return this.#database
            .delete(authPasswordResetTokens)
            .where(eq(authPasswordResetTokens.prefix, prefix))
            .run().changes;
    }

    deleteExpired(before: Date): number {
        return this.#database
            .delete(authPasswordResetTokens)
            .where(lt(authPasswordResetTokens.expiresAt, before))
            .run().changes;
    }

    findByPrefix(prefix: string): PasswordResetTokenRecord | undefined {
        const row = this.#database
            .select()
            .from(authPasswordResetTokens)
            .where(eq(authPasswordResetTokens.prefix, prefix))
            .get();
        return row === undefined
            ? undefined
            : v.parse(authPasswordResetTokenSelectSchema, row);
    }

    findByUserPurpose(
        userId: string,
        purpose: PasswordResetTokenRecord["purpose"]
    ): PasswordResetTokenRecord | undefined {
        const row = this.#database
            .select()
            .from(authPasswordResetTokens)
            .where(
                and(
                    eq(authPasswordResetTokens.userId, userId),
                    eq(authPasswordResetTokens.purpose, purpose)
                )
            )
            .get();
        return row === undefined
            ? undefined
            : v.parse(authPasswordResetTokenSelectSchema, row);
    }

    insert(input: PasswordResetTokenInsert): PasswordResetTokenRecord {
        const row = this.#database
            .insert(authPasswordResetTokens)
            .values(v.parse(authPasswordResetTokenInsertSchema, input))
            .returning()
            .get();
        if (row === undefined)
            throw new Error("Password-reset token insert returned no row");
        return v.parse(authPasswordResetTokenSelectSchema, row);
    }
}
