import { eq } from "drizzle-orm";

import { authPendingLogins } from "../../database/schema/authPendingLogins.ts";
import type { SecurityPersistenceDatabase } from "./securityPersistenceTypes.ts";

/** Focused persistence for invalidating password-first MFA handoffs by user. */
export class DrizzlePendingLoginStore {
    readonly #database: SecurityPersistenceDatabase;

    constructor(database: SecurityPersistenceDatabase) {
        this.#database = database;
    }

    deleteAllForUser(userId: string): number {
        return this.#database
            .delete(authPendingLogins)
            .where(eq(authPendingLogins.userId, userId))
            .run().changes;
    }
}
