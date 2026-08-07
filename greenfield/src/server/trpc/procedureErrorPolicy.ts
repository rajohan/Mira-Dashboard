import { getTRPCErrorFromUnknown, StandardSchemaV1Error, TRPCError } from "@trpc/server";

import { procedureContracts } from "../../contracts/contractRegistry.ts";
import type { ContractErrorCode, ProcedureContract } from "../../contracts/registry.ts";
import {
    isDatabaseRuntimeWriteUnavailableError,
    type DatabaseRuntimeWriteUnavailableError,
} from "../database/runtime/databaseErrors.ts";
import { AuthenticationWorkSettlementError } from "../domains/security/authenticationWorkGate.ts";

export type ProcedureExpectedErrorPolicy = Readonly<
    Record<string, readonly ContractErrorCode[]>
>;

function freezeProcedureExpectedErrorPolicy<
    const TPolicy extends ProcedureExpectedErrorPolicy,
>(policy: TPolicy): TPolicy {
    for (const errors of Object.values(policy)) Object.freeze(errors);
    return Object.freeze(policy);
}

/**
 * Server-owned allowlist for expected errors intentionally exposed by each route.
 * It intentionally duplicates contract metadata: the server policy is authored as an
 * independent enforcement boundary, and the startup assertion detects drift between them.
 */
export const procedureExpectedErrorPolicy = freezeProcedureExpectedErrorPolicy({
    "agents.getConfiguration": ["FORBIDDEN", "UNAUTHORIZED"],
    "agents.getStatus": ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
    "agents.listStatuses": ["FORBIDDEN", "UNAUTHORIZED"],
    "agents.listTaskHistory": ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
    "agents.updateMetadata": [
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "accountSecurity.beginTotpEnrollment": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "accountSecurity.beginWebAuthnEnrollment": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "accountSecurity.beginWebAuthnStepUp": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "accountSecurity.confirmTotpEnrollment": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "accountSecurity.confirmWebAuthnEnrollment": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "accountSecurity.disableMfa": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "accountSecurity.reauthenticatePassword": [
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "accountSecurity.removeTotpFactor": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "accountSecurity.removeWebAuthnCredential": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "accountSecurity.rotateRecoveryCodes": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "accountSecurity.stepUpRecovery": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "accountSecurity.stepUpTotp": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "accountSecurity.stepUpWebAuthn": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "accountSecurity.summary": ["FORBIDDEN", "UNAUTHORIZED"],
    "auth.beginWebAuthnLogin": ["CONFLICT", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    "auth.bootstrap": [
        "CONFLICT",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "auth.changePassword": [
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "auth.login": [
        "CONFLICT",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "auth.loginRecovery": ["SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
    "auth.loginTotp": ["SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
    "auth.loginWebAuthn": ["SERVICE_UNAVAILABLE", "TOO_MANY_REQUESTS", "UNAUTHORIZED"],
    "auth.logout": ["SERVICE_UNAVAILABLE"],
    "auth.revokeAllSessions": ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    "auth.revokeOtherSessions": ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    "auth.revokeSession": ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    "auth.sessions": ["FORBIDDEN", "UNAUTHORIZED"],
    "auth.status": [],
    "auth.touch": ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    "automationSecurity.createCredential": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "PRECONDITION_FAILED",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "automationSecurity.createPrincipal": [
        "CONFLICT",
        "FORBIDDEN",
        "PRECONDITION_FAILED",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "automationSecurity.disablePrincipal": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "automationSecurity.listCredentials": ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
    "automationSecurity.listPrincipals": ["FORBIDDEN", "UNAUTHORIZED"],
    "automationSecurity.replaceCapabilities": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "automationSecurity.revokeCredential": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "automationSecurity.rotateCredential": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "PRECONDITION_FAILED",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "events.stream": [
        "BAD_REQUEST",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    "incidents.get": ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
    "incidents.list": ["FORBIDDEN", "UNAUTHORIZED"],
    "monitoring.submitCompleteSnapshot": [
        "BAD_REQUEST",
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "notifications.clearRead": ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    "notifications.delete": [
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "notifications.list": ["FORBIDDEN", "UNAUTHORIZED"],
    "notifications.markAllRead": ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    "notifications.markRead": [
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "notifications.upsert": [
        "BAD_REQUEST",
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "reports.delete": [
        "FORBIDDEN",
        "NOT_FOUND",
        "PRECONDITION_FAILED",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "reports.get": ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
    "reports.list": ["FORBIDDEN", "UNAUTHORIZED"],
    "reports.upsert": [
        "BAD_REQUEST",
        "CONFLICT",
        "FORBIDDEN",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "securityAudit.listEvents": ["FORBIDDEN", "UNAUTHORIZED"],
    "system.runtimeIdentity": [],
    "tasks.addUpdate": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "tasks.assign": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "tasks.create": ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
    "tasks.delete": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "tasks.deleteProgress": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "tasks.get": ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
    "tasks.list": ["FORBIDDEN", "UNAUTHORIZED"],
    "tasks.listUpdates": ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"],
    "tasks.move": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "tasks.update": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
    "tasks.updateProgress": [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "UNAUTHORIZED",
    ],
} as const satisfies ProcedureExpectedErrorPolicy);

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

/**
 * Fails closed when the implemented route inventory and public contract error metadata drift.
 * @param contracts Public procedure contracts.
 * @param policy Runtime route allowlist for expected client-visible errors.
 */
export function assertProcedureExpectedErrorPolicy(
    contracts: readonly Pick<ProcedureContract, "errors" | "name">[],
    policy: ProcedureExpectedErrorPolicy
): void {
    const contractNames = contracts.map(({ name }) => name);
    const policyNames = Object.keys(policy);
    if (
        new Set(contractNames).size !== contractNames.length ||
        !sameStrings(contractNames.toSorted(), policyNames.toSorted())
    ) {
        throw new TypeError(
            "Procedure expected-error policy does not match the contract inventory"
        );
    }

    for (const contract of contracts) {
        if (!sameStrings(contract.errors, policy[contract.name] ?? [])) {
            throw new TypeError(
                `Procedure expected-error policy does not match ${contract.name}`
            );
        }
    }
}

assertProcedureExpectedErrorPolicy(procedureContracts, procedureExpectedErrorPolicy);
const runtimeProcedureExpectedErrorPolicy: ProcedureExpectedErrorPolicy =
    procedureExpectedErrorPolicy;

class UndeclaredProcedureErrorCause extends Error {
    public constructor(path: string, code: string) {
        super(`Procedure ${path} attempted to expose undeclared error ${code}`);
        this.name = "UndeclaredProcedureErrorCause";
    }
}

function isImplicitInputValidationError(error: TRPCError): boolean {
    return error.code === "BAD_REQUEST" && error.cause instanceof StandardSchemaV1Error;
}

function databaseWriteUnavailableCause(
    error: TRPCError
): DatabaseRuntimeWriteUnavailableError | undefined {
    if (error.code !== "INTERNAL_SERVER_ERROR") return undefined;
    if (isDatabaseRuntimeWriteUnavailableError(error.cause)) return error.cause;
    return error.cause instanceof AuthenticationWorkSettlementError &&
        isDatabaseRuntimeWriteUnavailableError(error.cause.cause)
        ? error.cause.cause
        : undefined;
}

function mapDatabaseWriteUnavailableError(error: TRPCError): TRPCError {
    const cause = databaseWriteUnavailableCause(error);
    return cause === undefined
        ? error
        : new TRPCError({
              cause,
              code: "SERVICE_UNAVAILABLE",
              message: "Database write capacity is temporarily unavailable",
          });
}

/**
 * Converts undeclared errors from registered production routes into internal defects.
 * Framework-owned input-validation failures and existing internal defects remain implicit.
 * @param path Fully qualified tRPC procedure path.
 * @param error Error returned by the tRPC middleware chain.
 * @returns Original declared/implicit error or a safe internal replacement.
 */
export function applyProcedureExpectedErrorPolicy(
    path: string,
    error: TRPCError
): TRPCError {
    const mappedError = mapDatabaseWriteUnavailableError(error);
    const expectedErrors = Object.hasOwn(runtimeProcedureExpectedErrorPolicy, path)
        ? runtimeProcedureExpectedErrorPolicy[path]
        : undefined;
    if (
        mappedError.code === "INTERNAL_SERVER_ERROR" ||
        isImplicitInputValidationError(mappedError) ||
        (expectedErrors !== undefined &&
            (expectedErrors as readonly string[]).includes(mappedError.code))
    ) {
        return mappedError;
    }

    return new TRPCError({
        cause: new UndeclaredProcedureErrorCause(path, mappedError.code),
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
    });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return (
        ((typeof value === "object" && value !== null) || typeof value === "function") &&
        typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
    );
}

async function* enforceAsyncIterableErrors(
    path: string,
    iterable: AsyncIterable<unknown>
): AsyncGenerator<unknown, void, unknown> {
    try {
        yield* iterable;
    } catch (error) {
        throw applyProcedureExpectedErrorPolicy(path, getTRPCErrorFromUnknown(error));
    }
}

/**
 * Extends expected-error enforcement through deferred subscription iteration.
 * @param path Fully qualified tRPC procedure path.
 * @param value Successful procedure result.
 * @returns Original value or an equivalent policy-enforced async iterable.
 */
export function applyProcedureExpectedErrorPolicyToOutput<T>(path: string, value: T): T {
    return isAsyncIterable(value)
        ? (enforceAsyncIterableErrors(path, value) as T)
        : value;
}
