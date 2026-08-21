import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import { DrizzleBrowserSessionStore } from "./browserSessionStore.ts";
import {
    DrizzleSecurityAuditStore,
    type SecurityAuditEventListInput,
    type SecurityAuditEventRecord,
} from "./securityAuditStore.ts";
import type {
    BrowserSessionRecord,
    SecurityTransaction,
    SecurityUserRecord,
    SynchronousResult,
} from "./securityPersistenceTypes.ts";
import { DrizzleSecurityUserStore } from "./securityUserStore.ts";

export interface SecurityAuditLifecycleReader {
    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined;
    findUserById(userId: string): SecurityUserRecord | undefined;
    hasFutureEvents(checkedAt: Date): boolean;
    listEvents(input: SecurityAuditEventListInput): SecurityAuditEventRecord[];
}

export interface SecurityAuditLifecycleRepository {
    withReadTransaction<T>(
        callback: (reader: SecurityAuditLifecycleReader) => SynchronousResult<T>
    ): T;
}

class DrizzleSecurityAuditLifecycleReader implements SecurityAuditLifecycleReader {
    readonly #audit: DrizzleSecurityAuditStore;
    readonly #sessions: DrizzleBrowserSessionStore;
    readonly #users: DrizzleSecurityUserStore;

    public constructor(transaction: SecurityTransaction) {
        this.#audit = new DrizzleSecurityAuditStore(transaction);
        this.#sessions = new DrizzleBrowserSessionStore(transaction);
        this.#users = new DrizzleSecurityUserStore(transaction);
    }

    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined {
        return this.#sessions.findSession(userId, sessionId);
    }

    findUserById(userId: string): SecurityUserRecord | undefined {
        return this.#users.findUserById(userId);
    }

    hasFutureEvents(checkedAt: Date): boolean {
        return this.#audit.hasFutureEvents(checkedAt);
    }

    listEvents(input: SecurityAuditEventListInput): SecurityAuditEventRecord[] {
        return this.#audit.listEvents(input);
    }
}

/**
 * Creates the read-only transaction boundary for immutable security audit history.
 * @returns A repository whose synchronous callbacks run in deferred transactions.
 */
export function createSecurityAuditLifecycleRepository(
    database: SQLiteBunDatabase
): SecurityAuditLifecycleRepository {
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: SecurityTransaction) => T,
        config: { behavior: "deferred" }
    ) => T;

    return Object.freeze({
        withReadTransaction<T>(
            callback: (reader: SecurityAuditLifecycleReader) => SynchronousResult<T>
        ): T {
            return runTransaction(
                (transaction) =>
                    callback(new DrizzleSecurityAuditLifecycleReader(transaction)),
                { behavior: "deferred" }
            );
        },
    });
}
