import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type {
    SecurityTransaction,
    SynchronousResult,
} from "../securityPersistenceTypes.ts";
import { DrizzleAutomationLifecycleReader } from "./lifecycleRepositoryReader.ts";
import type {
    AutomationLifecycleReader,
    AutomationLifecycleRepository,
    AutomationLifecycleUnitOfWork,
} from "./lifecycleRepositoryTypes.ts";
import { DrizzleAutomationLifecycleUnitOfWork } from "./lifecycleRepositoryUnitOfWork.ts";

type DrizzleTransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];

/**
 * Creates synchronous deferred/immediate automation-security transactions.
 * @returns A validated repository bound to the supplied process database.
 */
export function createAutomationLifecycleRepository(
    database: SQLiteBunDatabase
): AutomationLifecycleRepository {
    const reader = new DrizzleAutomationLifecycleReader(database);

    return Object.freeze({
        countActiveCredentials: reader.countActiveCredentials.bind(reader),
        countCredentials: reader.countCredentials.bind(reader),
        countEnabledPrincipals: reader.countEnabledPrincipals.bind(reader),
        countPrincipals: reader.countPrincipals.bind(reader),
        findCredential: reader.findCredential.bind(reader),
        findPrincipal: reader.findPrincipal.bind(reader),
        findReplacement: reader.findReplacement.bind(reader),
        findSession: reader.findSession.bind(reader),
        findUserById: reader.findUserById.bind(reader),
        listCapabilities: reader.listCapabilities.bind(reader),
        listCredentials: reader.listCredentials.bind(reader),
        listPrincipals: reader.listPrincipals.bind(reader),
        withImmediateTransaction<T>(
            callback: (
                unit: AutomationLifecycleUnitOfWork
            ) => SynchronousResult<T> | never
        ): T {
            const transactionCallback = ((transaction: SecurityTransaction) =>
                callback(
                    new DrizzleAutomationLifecycleUnitOfWork(transaction)
                )) as DrizzleTransactionCallback;
            return database.transaction(transactionCallback, {
                behavior: "immediate",
            }) as T;
        },
        withReadTransaction<T>(
            callback: (
                transactionReader: AutomationLifecycleReader
            ) => SynchronousResult<T> | never
        ): T {
            const transactionCallback = ((transaction: SecurityTransaction) =>
                callback(
                    new DrizzleAutomationLifecycleReader(transaction)
                )) as DrizzleTransactionCallback;
            return database.transaction(transactionCallback, {
                behavior: "deferred",
            }) as T;
        },
    });
}
