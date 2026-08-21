import { getTime } from "date-fns";
import * as v from "valibot";

import {
    type ListSecurityAuditEventsInput,
    type ListSecurityAuditEventsResult,
    listSecurityAuditEventsResultSchema,
    securityAuditMetadataSchema,
} from "../../../contracts/securityAudit.ts";
import { nonnegativeDateAction } from "../../../shared/dateTime.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { parseBrowserSessionIdleDurationMs } from "./authenticationPolicy.ts";
import {
    browserSessionIsActive,
    type AuthenticatedBrowserIdentity,
} from "./authenticationSession.ts";
import type {
    SecurityAuditLifecycleReader,
    SecurityAuditLifecycleRepository,
} from "./securityAuditLifecycleRepository.ts";
import type { SecurityAuditEventRecord } from "./securityAuditStore.ts";

const securityAuditClockSchema = v.pipe(
    v.date("Security audit clock is invalid"),
    nonnegativeDateAction("Security audit clock is invalid")
);

export interface SecurityAuditLifecycleDependencies {
    readonly now?: () => Date;
    readonly repository: SecurityAuditLifecycleRepository;
    readonly sessionIdleDurationMs?: number;
}

export type ListSecurityAuditEventsLifecycleResult =
    | { readonly result: ListSecurityAuditEventsResult; readonly status: "listed" }
    | { readonly status: "session-changed" };

export interface SecurityAuditLifecycleService {
    listEvents(
        identity: AuthenticatedBrowserIdentity,
        input: ListSecurityAuditEventsInput
    ): ListSecurityAuditEventsLifecycleResult;
}

function sessionIsCurrent(
    reader: SecurityAuditLifecycleReader,
    identity: AuthenticatedBrowserIdentity,
    checkedAt: Date,
    sessionIdleDurationMs: number
): boolean {
    const user = reader.findUserById(identity.userId);
    const session = reader.findSession(identity.userId, identity.sessionId);
    return (
        user !== undefined &&
        user.disabledAt === null &&
        session !== undefined &&
        session.authenticationVersion === user.authenticationVersion &&
        browserSessionIsActive(session, checkedAt, sessionIdleDurationMs)
    );
}

function auditEventSummary(record: SecurityAuditEventRecord) {
    const actor =
        record.authenticatorId === null
            ? { id: record.actorId, kind: record.actorKind }
            : {
                  authenticatorId: record.authenticatorId,
                  id: record.actorId,
                  kind: record.actorKind,
              };
    return {
        action: record.action,
        actor,
        id: record.id,
        metadata: v.parse(
            securityAuditMetadataSchema,
            parseJsonText(record.metadataJson)
        ),
        occurredAtMs: getTime(record.occurredAt),
        outcome: record.outcome,
        ...(record.requestId === null ? {} : { requestId: record.requestId }),
        target: { id: record.targetId, type: record.targetType },
    };
}

/**
 * Creates the session-only, read-only security audit inventory lifecycle.
 * @returns A lifecycle that revalidates the actor inside every read transaction.
 */
export function createSecurityAuditLifecycleService(
    dependencies: SecurityAuditLifecycleDependencies
): SecurityAuditLifecycleService {
    const clock = dependencies.now ?? (() => new Date());
    const now = () => v.parse(securityAuditClockSchema, clock());
    const sessionIdleDurationMs = parseBrowserSessionIdleDurationMs(
        dependencies.sessionIdleDurationMs
    );

    return Object.freeze({
        listEvents(
            identity: AuthenticatedBrowserIdentity,
            input: ListSecurityAuditEventsInput
        ) {
            return dependencies.repository.withReadTransaction((reader) => {
                const checkedAt = now();
                if (
                    !sessionIsCurrent(reader, identity, checkedAt, sessionIdleDurationMs)
                ) {
                    return { status: "session-changed" as const };
                }
                if (reader.hasFutureEvents(checkedAt)) {
                    throw new Error("Security audit history contains a future event");
                }
                const rows = reader.listEvents({
                    ...(input.cursor === undefined
                        ? {}
                        : {
                              beforeId: input.cursor.id,
                              beforeOccurredAt: new Date(input.cursor.occurredAtMs),
                          }),
                    limit: input.limit + 1,
                });
                const page = rows.slice(0, input.limit);
                const last = page.at(-1);
                const result = v.parse(listSecurityAuditEventsResultSchema, {
                    events: page.map((event) => auditEventSummary(event)),
                    ...(rows.length > input.limit && last !== undefined
                        ? {
                              nextCursor: {
                                  id: last.id,
                                  occurredAtMs: getTime(last.occurredAt),
                              },
                          }
                        : {}),
                });
                return { result, status: "listed" as const };
            });
        },
    });
}
