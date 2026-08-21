import type { Database } from "bun:sqlite";

import { addDays, addMinutes, parseISO } from "date-fns";
import * as v from "valibot";

import { authSessions } from "../../../../database/schema/authSessions.ts";
import { users } from "../../../../database/schema/users.ts";
import { authSessionInsertSchema } from "../../../../database/validation/authSessions.ts";
import { userInsertSchema } from "../../../../database/validation/users.ts";
import {
    opaqueTokenValidatorVersion,
    parseOpaqueToken,
    type GeneratedOpaqueToken,
} from "../../../../shared/opaqueToken.ts";
import { testImmediateDatabaseWriteAdmission } from "../../../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../../../test/support/freshDatabase.ts";
import { testDashboardPasswordHash } from "../../../../test/support/securityPassword.ts";
import type {
    AuthenticatedBrowserIdentity,
    AuthenticationRequestMetadata,
} from "../../authenticationSession.ts";
import type { SynchronousResult } from "../../securityPersistenceTypes.ts";
import { createAutomationSecurityLifecycleService } from "../lifecycle.ts";
import { createAutomationLifecycleRepository } from "../lifecycleRepository.ts";
import type {
    AutomationLifecycleReader,
    AutomationLifecycleRepository,
    AutomationLifecycleUnitOfWork,
} from "../lifecycleRepositoryTypes.ts";
import type {
    AutomationSecurityLifecycleDependencies,
    AutomationSecurityLifecycleService,
} from "../lifecycleTypes.ts";

export const automationLifecycleBaseTime = parseISO("2026-08-05T01:00:00.000Z");
export const automationLifecycleMfaEnabledAt = addMinutes(automationLifecycleBaseTime, 1);
export const automationLifecycleSessionCreatedAt = addMinutes(
    automationLifecycleBaseTime,
    2
);
export const automationLifecycleInitialNow = addMinutes(automationLifecycleBaseTime, 3);
export const automationLifecycleUserId = "019fc968-1a9b-7000-8000-000000000001";
export const automationLifecycleSessionId = "a".repeat(32);
export const automationLifecyclePrincipalId = "automation-lifecycle";
export const automationLifecycleMetadata: AuthenticationRequestMetadata = Object.freeze({
    clientSourceId: "b".repeat(64),
    requestId: "automation-lifecycle-request",
});
export const automationLifecycleIdentity: AuthenticatedBrowserIdentity = Object.freeze({
    sessionId: automationLifecycleSessionId,
    userId: automationLifecycleUserId,
});

export function deterministicSecurityId(index: number): string {
    if (!Number.isSafeInteger(index) || index < 0 || index > 281_474_976_710_655) {
        throw new RangeError("Deterministic security id index is invalid");
    }
    return `019fc968-1a9b-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

export function deterministicAutomationToken(index: number): GeneratedOpaqueToken {
    if (!Number.isSafeInteger(index) || index < 1) {
        throw new RangeError("Deterministic automation token index is invalid");
    }
    const prefix = index.toString(16).padStart(32, "0");
    const validator = (index + 4096).toString(16).padStart(64, "0");
    const token = `${prefix}.${validator}`;
    const parsed = parseOpaqueToken(token, "automation");
    if (parsed === undefined) {
        throw new Error("Deterministic automation token is invalid");
    }
    return Object.freeze({
        ...parsed,
        token,
        validatorVersion: opaqueTokenValidatorVersion,
    });
}

export interface AutomationLifecycleRepositoryHooks {
    readonly beforeImmediateCallback?: () => void;
    readonly beforeReadCallback?: () => void;
}

/**
 * Wraps real transactions with deterministic post-acquisition test hooks.
 * @param repository Real repository whose transaction boundaries remain authoritative.
 * @param hooks Callbacks invoked after each corresponding transaction is acquired.
 * @returns Repository facade preserving every production reader and transaction method.
 */
export function withAutomationLifecycleRepositoryHooks(
    repository: AutomationLifecycleRepository,
    hooks: AutomationLifecycleRepositoryHooks
): AutomationLifecycleRepository {
    return Object.freeze({
        ...repository,
        withImmediateTransaction<T>(
            callback: (unit: AutomationLifecycleUnitOfWork) => SynchronousResult<T>
        ): Promise<T> {
            return repository.withImmediateTransaction((unit) => {
                hooks.beforeImmediateCallback?.();
                return callback(unit);
            });
        },
        withReadTransaction<T>(
            callback: (reader: AutomationLifecycleReader) => SynchronousResult<T>
        ): T {
            return repository.withReadTransaction((reader) => {
                hooks.beforeReadCallback?.();
                return callback(reader);
            });
        },
    });
}

type LifecycleDependencyOverrides = Partial<
    Omit<AutomationSecurityLifecycleDependencies, "repository">
> & {
    readonly repository?: AutomationLifecycleRepository;
};

export interface AutomationLifecycleFixture {
    readonly createService: (
        overrides?: LifecycleDependencyOverrides
    ) => AutomationSecurityLifecycleService;
    readonly database: Awaited<ReturnType<typeof openFreshMigratedDatabase>>;
    readonly identity: AuthenticatedBrowserIdentity;
    readonly metadata: AuthenticationRequestMetadata;
    readonly repository: AutomationLifecycleRepository;
    readonly setNow: (value: Date) => void;
}

/**
 * Opens one MFA-enabled recent session on the reviewed fresh baseline.
 * @returns Fresh database, repository, replaceable clock, identity, and service factory.
 */
export async function openAutomationLifecycleFixture(): Promise<AutomationLifecycleFixture> {
    const database = await openFreshMigratedDatabase();
    let currentTime = automationLifecycleInitialNow;
    let generatedIdIndex = 100;
    let generatedTokenIndex = 100;

    try {
        database.orm
            .insert(users)
            .values(
                v.parse(userInsertSchema, {
                    createdAt: automationLifecycleBaseTime,
                    disabledAt: null,
                    id: automationLifecycleUserId,
                    mfaEnabledAt: automationLifecycleMfaEnabledAt,
                    passwordHash: testDashboardPasswordHash,
                    updatedAt: automationLifecycleMfaEnabledAt,
                    username: "raymond",
                })
            )
            .run();
        database.orm
            .insert(authSessions)
            .values(
                v.parse(authSessionInsertSchema, {
                    authenticatedAt: automationLifecycleSessionCreatedAt,
                    authenticationVersion: 1,
                    authMethod: "totp",
                    createdAt: automationLifecycleSessionCreatedAt,
                    expiresAt: addDays(automationLifecycleSessionCreatedAt, 30),
                    id: automationLifecycleSessionId,
                    lastSeenAt: automationLifecycleSessionCreatedAt,
                    mfaVerifiedAt: automationLifecycleSessionCreatedAt,
                    passwordVerifiedAt: automationLifecycleSessionCreatedAt,
                    userAgent: null,
                    userId: automationLifecycleUserId,
                    validatorHash: "c".repeat(64),
                })
            )
            .run();

        const repository = createAutomationLifecycleRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        return {
            createService(overrides = {}) {
                return createAutomationSecurityLifecycleService({
                    generateId: () => deterministicSecurityId(generatedIdIndex++),
                    generateToken: () =>
                        deterministicAutomationToken(generatedTokenIndex++),
                    now: () => currentTime,
                    repository,
                    ...overrides,
                });
            },
            database,
            identity: automationLifecycleIdentity,
            metadata: automationLifecycleMetadata,
            repository,
            setNow(value) {
                currentTime = value;
            },
        };
    } catch (error) {
        database.sqlite.close(true);
        throw error;
    }
}

export interface PersistedAutomationCredential {
    readonly expiresAt: number | null;
    readonly id: string;
    readonly prefix: string;
    readonly replacesCredentialId: string | null;
    readonly revokedAt: number | null;
    readonly validatorHash: string;
}

export function readPersistedAutomationCredentials(
    sqlite: Database,
    principalId = automationLifecyclePrincipalId
): PersistedAutomationCredential[] {
    return sqlite
        .query<PersistedAutomationCredential, [string]>(`
            SELECT
                expires_at AS expiresAt,
                id,
                prefix,
                replaces_credential_id AS replacesCredentialId,
                revoked_at AS revokedAt,
                validator_hash AS validatorHash
            FROM automation_credentials
            WHERE principal_id = ?
            ORDER BY created_at, id
        `)
        .all(principalId);
}

export interface PersistedAutomationAuditEvent {
    readonly action: string;
    readonly metadataJson: string;
    readonly occurredAt: number;
    readonly targetId: string;
}

export function readAutomationAuditEvents(
    sqlite: Database
): PersistedAutomationAuditEvent[] {
    return sqlite
        .query<PersistedAutomationAuditEvent, []>(`
            SELECT
                action,
                metadata_json AS metadataJson,
                occurred_at AS occurredAt,
                target_id AS targetId
            FROM audit_events
            WHERE action GLOB 'automation.*'
            ORDER BY occurred_at, id
        `)
        .all();
}
