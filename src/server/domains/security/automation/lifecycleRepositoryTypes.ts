import * as v from "valibot";

import type { ApplicationCapability } from "../../../../contracts/security.ts";
import {
    automationCredentialInsertSchema,
    automationCredentialSelectSchema,
} from "../../../database/validation/automationCredentials.ts";
import {
    automationPrincipalCapabilityInsertSchema,
    automationPrincipalCapabilitySelectSchema,
} from "../../../database/validation/automationPrincipalCapabilities.ts";
import {
    automationPrincipalInsertSchema,
    automationPrincipalSelectSchema,
} from "../../../database/validation/automationPrincipals.ts";
import type { SecurityAuditWriter } from "../securityAuditStore.ts";
import type {
    BrowserSessionRecord,
    SecurityUserRecord,
    SynchronousResult,
} from "../securityPersistenceTypes.ts";

export type AutomationPrincipalRecord = v.InferOutput<
    typeof automationPrincipalSelectSchema
>;
export type AutomationPrincipalInsert = v.InferOutput<
    typeof automationPrincipalInsertSchema
>;
export type AutomationCredentialRecord = Omit<
    v.InferOutput<typeof automationCredentialSelectSchema>,
    "validatorHash"
>;
export type AutomationCredentialInsert = v.InferOutput<
    typeof automationCredentialInsertSchema
>;
export type AutomationCapabilityRecord = v.InferOutput<
    typeof automationPrincipalCapabilitySelectSchema
>;
export type AutomationCapabilityInsert = v.InferOutput<
    typeof automationPrincipalCapabilityInsertSchema
>;

export interface AutomationPrincipalListInput {
    readonly beforeCreatedAt?: Date;
    readonly beforeId?: string;
    readonly limit: number;
}

export interface AutomationCredentialListInput {
    readonly beforeCreatedAt?: Date;
    readonly beforeId?: string;
    readonly limit: number;
    readonly principalId: string;
}

export interface ReplaceAutomationCapabilitiesInput {
    readonly capabilities: readonly ApplicationCapability[];
    readonly expectedAuthorizationVersion: number;
    readonly grantedAt: Date;
    readonly principalId: string;
}

export interface DisableAutomationPrincipalInput {
    readonly disabledAt: Date;
    readonly expectedAuthorizationVersion: number;
    readonly principalId: string;
}

export interface RevokeAutomationCredentialInput {
    readonly credentialId: string;
    readonly principalId: string;
    readonly revokedAt: Date;
}

/** Consistent read surface for automation-security administration. */
export interface AutomationLifecycleReader {
    countCredentials(principalId: string): number;
    countEnabledPrincipals(): number;
    countPrincipals(): number;
    countActiveCredentials(principalId: string, checkedAt: Date): number;
    findCredential(
        principalId: string,
        credentialId: string
    ): AutomationCredentialRecord | undefined;
    findPrincipal(principalId: string): AutomationPrincipalRecord | undefined;
    findReplacement(
        principalId: string,
        predecessorCredentialId: string
    ): AutomationCredentialRecord | undefined;
    findSession(userId: string, sessionId: string): BrowserSessionRecord | undefined;
    findUserById(userId: string): SecurityUserRecord | undefined;
    listCapabilities(principalId: string): AutomationCapabilityRecord[];
    listCredentials(input: AutomationCredentialListInput): AutomationCredentialRecord[];
    listPrincipals(input: AutomationPrincipalListInput): AutomationPrincipalRecord[];
}

/** Synchronous write surface owned by one SQLite IMMEDIATE transaction. */
export interface AutomationLifecycleUnitOfWork
    extends AutomationLifecycleReader, SecurityAuditWriter {
    disablePrincipal(
        input: DisableAutomationPrincipalInput
    ): AutomationPrincipalRecord | undefined;
    insertCredentialIfAvailable(
        input: AutomationCredentialInsert
    ): AutomationCredentialRecord | undefined;
    insertPrincipalIfAvailable(
        input: AutomationPrincipalInsert
    ): AutomationPrincipalRecord | undefined;
    insertCapabilities(inputs: readonly AutomationCapabilityInsert[]): void;
    replaceCapabilities(
        input: ReplaceAutomationCapabilitiesInput
    ): AutomationPrincipalRecord | undefined;
    revokeCredential(
        input: RevokeAutomationCredentialInput
    ): AutomationCredentialRecord | undefined;
    revokeActiveCredentials(principalId: string, revokedAt: Date): number;
}

/** Validated SQLite boundary for automation-security administration. */
export interface AutomationLifecycleRepository extends AutomationLifecycleReader {
    withImmediateTransaction<T>(
        callback: (unit: AutomationLifecycleUnitOfWork) => SynchronousResult<T>
    ): T;
    withReadTransaction<T>(
        callback: (reader: AutomationLifecycleReader) => SynchronousResult<T>
    ): T;
}
