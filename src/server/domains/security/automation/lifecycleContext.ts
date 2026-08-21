import * as v from "valibot";

import { nonnegativeDateAction } from "../../../../shared/dateTime.ts";
import { generateOpaqueToken } from "../../../shared/opaqueToken.ts";
import { createSecurityAuditEvent, type SecurityAuditEventInput } from "../audit.ts";
import { parseBrowserSessionIdleDurationMs } from "../authenticationPolicy.ts";
import {
    browserSessionIsActive,
    sessionActor,
    type AuthenticatedBrowserIdentity,
} from "../authenticationSession.ts";
import {
    evaluateRecentAuthentication,
    parseRecentAuthenticationWindowMs,
} from "../recentAuthentication.ts";
import type {
    AutomationLifecycleReader,
    AutomationLifecycleRepository,
    AutomationLifecycleUnitOfWork,
} from "./lifecycleRepositoryTypes.ts";
import type {
    AutomationAdministrationPolicyFailure,
    AutomationSecurityLifecycleDependencies,
} from "./lifecycleTypes.ts";

const lifecycleClockSchema = v.pipe(
    v.date("Automation-security clock is invalid"),
    nonnegativeDateAction()
);

export interface AutomationSecurityLifecycleContext {
    readonly audit: (
        unit: AutomationLifecycleUnitOfWork,
        input: Omit<SecurityAuditEventInput, "id">
    ) => void;
    readonly authorizeAdministration: (
        reader: AutomationLifecycleReader,
        identity: AuthenticatedBrowserIdentity,
        checkedAt: Date
    ) => AutomationAdministrationPolicyFailure | undefined;
    readonly authorizeSession: (
        reader: AutomationLifecycleReader,
        identity: AuthenticatedBrowserIdentity,
        checkedAt: Date
    ) => { readonly status: "session-changed" } | undefined;
    readonly generateId: () => string;
    readonly generateToken: () => ReturnType<typeof generateOpaqueToken>;
    readonly now: () => Date;
    readonly repository: AutomationLifecycleRepository;
}

function sessionIsCurrent(
    sessionIdleDurationMs: number,
    reader: AutomationLifecycleReader,
    identity: AuthenticatedBrowserIdentity,
    checkedAt: Date
) {
    const user = reader.findUserById(identity.userId);
    const session = reader.findSession(identity.userId, identity.sessionId);
    if (
        user === undefined ||
        user.disabledAt !== null ||
        session === undefined ||
        session.authenticationVersion !== user.authenticationVersion ||
        !browserSessionIsActive(session, checkedAt, sessionIdleDurationMs)
    ) {
        return;
    }
    return { session, user };
}

/**
 * Builds validated policy, clock, generation, and audit dependencies.
 * @param dependencies Repository plus optional clock, policy, and generation overrides.
 * @returns Frozen lifecycle context shared by principal and credential operations.
 */
export function createAutomationSecurityLifecycleContext(
    dependencies: AutomationSecurityLifecycleDependencies
): AutomationSecurityLifecycleContext {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const generateToken =
        dependencies.generateToken ?? (() => generateOpaqueToken("automation"));
    const clock = dependencies.now ?? (() => new Date());
    const now = () => v.parse(lifecycleClockSchema, clock());
    const recentAuthenticationWindowMs = parseRecentAuthenticationWindowMs(
        dependencies.recentAuthenticationWindowMs
    );
    const sessionIdleDurationMs = parseBrowserSessionIdleDurationMs(
        dependencies.sessionIdleDurationMs
    );
    const audit: AutomationSecurityLifecycleContext["audit"] = (unit, input) => {
        unit.insertAuditEvent(createSecurityAuditEvent({ ...input, id: generateId() }));
    };
    const authorizeSession: AutomationSecurityLifecycleContext["authorizeSession"] = (
        reader,
        identity,
        checkedAt
    ) =>
        sessionIsCurrent(sessionIdleDurationMs, reader, identity, checkedAt) === undefined
            ? { status: "session-changed" }
            : undefined;
    const authorizeAdministration: AutomationSecurityLifecycleContext["authorizeAdministration"] =
        (reader, identity, checkedAt) => {
            const current = sessionIsCurrent(
                sessionIdleDurationMs,
                reader,
                identity,
                checkedAt
            );
            if (current === undefined) return { status: "session-changed" };
            if (current.user.mfaEnabledAt === null) {
                return { status: "mfa-enrollment-required" };
            }
            const recent = evaluateRecentAuthentication({
                checkedAt,
                mfaEnabledAt: current.user.mfaEnabledAt,
                mfaVerifiedAt: current.session.mfaVerifiedAt,
                passwordVerifiedAt: current.session.passwordVerifiedAt,
                windowMs: recentAuthenticationWindowMs,
            });
            return recent.mfa.recent ? undefined : { status: "step-up-required" };
        };

    return Object.freeze({
        audit,
        authorizeAdministration,
        authorizeSession,
        generateId,
        generateToken,
        now,
        repository: dependencies.repository,
    });
}

export function administrationActor(identity: AuthenticatedBrowserIdentity) {
    return sessionActor(identity);
}
