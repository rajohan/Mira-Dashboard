import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { SecurityTransaction } from "../securityPersistenceTypes.ts";
import { DrizzleAutomationLifecycleReader } from "./lifecycleRepositoryReader.ts";
import type {
    AutomationLifecycleReader,
    AutomationLifecycleRepository,
    AutomationLifecycleUnitOfWork,
} from "./lifecycleRepositoryTypes.ts";
import { DrizzleAutomationLifecycleUnitOfWork } from "./lifecycleRepositoryUnitOfWork.ts";

/**
 * Creates synchronous deferred/immediate automation-security transactions.
 * @returns A validated repository bound to the supplied process database.
 */
export function createAutomationLifecycleRepository(
    database: SQLiteBunDatabase
): AutomationLifecycleRepository {
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: SecurityTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;
    const reader = new DrizzleAutomationLifecycleReader(database);

    return Object.freeze({
        countCredentials: reader.countCredentials.bind(reader),
        countEnabledPrincipals: reader.countEnabledPrincipals.bind(reader),
        countPrincipals: reader.countPrincipals.bind(reader),
        countActiveCredentials: reader.countActiveCredentials.bind(reader),
        findCredential: reader.findCredential.bind(reader),
        findPrincipal: reader.findPrincipal.bind(reader),
        findReplacement: reader.findReplacement.bind(reader),
        findSession: reader.findSession.bind(reader),
        findUserById: reader.findUserById.bind(reader),
        listCapabilities: reader.listCapabilities.bind(reader),
        listCredentials: reader.listCredentials.bind(reader),
        listPrincipals: reader.listPrincipals.bind(reader),
        withImmediateTransaction<T>(
            callback: (unit: AutomationLifecycleUnitOfWork) => T
        ): T {
            return runTransaction(
                (transaction) =>
                    callback(new DrizzleAutomationLifecycleUnitOfWork(transaction)),
                { behavior: "immediate" }
            );
        },
        withReadTransaction<T>(callback: (reader: AutomationLifecycleReader) => T): T {
            return runTransaction(
                (transaction) =>
                    callback(new DrizzleAutomationLifecycleReader(transaction)),
                { behavior: "deferred" }
            );
        },
    });
}
