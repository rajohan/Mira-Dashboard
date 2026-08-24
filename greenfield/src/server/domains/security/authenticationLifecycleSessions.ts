import { addMilliseconds, differenceInMilliseconds, getTime } from "date-fns";

import { browserSessionMaximumPerUser } from "../../../contracts/auth.ts";
import {
    sessionActivityWriteIntervalMs,
    type AuthenticationLifecycleContext,
} from "./authenticationLifecycleContext.ts";
import type {
    AuthenticationLifecycleReader,
    AuthenticationLifecycleUnitOfWork,
} from "./authenticationLifecycleRepository.ts";
import type {
    AuthenticationLifecycleService,
    RecentMfaAuthorization,
} from "./authenticationLifecycleTypes.ts";
import {
    authSession,
    authUser,
    type AuthenticatedBrowserIdentity,
    browserSessionIsActive as sessionIsActive,
    sessionActor,
} from "./authenticationSession.ts";
import { evaluateRecentAuthentication } from "./recentAuthentication.ts";

type SessionsContext = Pick<
    AuthenticationLifecycleContext,
    | "audit"
    | "now"
    | "recentAuthenticationWindowMs"
    | "repository"
    | "sessionIdleDurationMs"
>;

type SessionMutationAccess = "authorized" | "session-changed" | "step-up-required";

function recentMfaAccess(
    context: SessionsContext,
    unit: AuthenticationLifecycleReader,
    identity: AuthenticatedBrowserIdentity,
    checkedAt: Date
): RecentMfaAuthorization {
    const user = unit.findUserById(identity.userId);
    const actorSession = unit.findSession(identity.userId, identity.sessionId);
    if (
        user === undefined ||
        user.disabledAt !== null ||
        actorSession === undefined ||
        actorSession.authenticationVersion !== user.authenticationVersion ||
        !sessionIsActive(actorSession, checkedAt, context.sessionIdleDurationMs)
    ) {
        return "session-changed";
    }
    if (user.mfaEnabledAt === null) return "mfa-enrollment-required";
    return evaluateRecentAuthentication({
        checkedAt,
        mfaEnabledAt: user.mfaEnabledAt,
        mfaVerifiedAt: actorSession.mfaVerifiedAt,
        passwordVerifiedAt: actorSession.passwordVerifiedAt,
        windowMs: context.recentAuthenticationWindowMs,
    }).mfa.recent
        ? "authorized"
        : "step-up-required";
}

function sessionMutationAccess(
    context: SessionsContext,
    unit: AuthenticationLifecycleUnitOfWork,
    identity: AuthenticatedBrowserIdentity,
    checkedAt: Date
): SessionMutationAccess {
    const user = unit.findUserById(identity.userId);
    const actorSession = unit.findSession(identity.userId, identity.sessionId);
    if (
        user === undefined ||
        user.disabledAt !== null ||
        actorSession === undefined ||
        actorSession.authenticationVersion !== user.authenticationVersion ||
        !sessionIsActive(actorSession, checkedAt, context.sessionIdleDurationMs)
    ) {
        return "session-changed";
    }
    const recentAuthentication = evaluateRecentAuthentication({
        checkedAt,
        mfaEnabledAt: user.mfaEnabledAt,
        mfaVerifiedAt: actorSession.mfaVerifiedAt,
        passwordVerifiedAt: actorSession.passwordVerifiedAt,
        windowMs: context.recentAuthenticationWindowMs,
    });
    if (user.mfaEnabledAt === null) {
        return recentAuthentication.password.recent ? "authorized" : "step-up-required";
    }
    return recentAuthentication.mfa.recent ? "authorized" : "step-up-required";
}

/**
 * Creates session reads, activity, logout, and revocation operations.
 * @returns Session operations backed by the shared lifecycle context.
 */
export function createAuthenticationSessionOperations(
    context: SessionsContext
): Pick<
    AuthenticationLifecycleService,
    | "authorizeRecentMfa"
    | "listSessions"
    | "logout"
    | "revokeAllSessions"
    | "revokeOtherSessions"
    | "revokeSession"
    | "status"
    | "touchSession"
> {
    return {
        authorizeRecentMfa(identity) {
            return context.repository.withReadTransaction((reader) =>
                recentMfaAccess(context, reader, identity, context.now())
            );
        },
        listSessions(identity) {
            return context.repository.withReadTransaction((reader) => {
                const checkedAt = context.now();
                const user = reader.findUserById(identity.userId);
                const actorSession = reader.findSession(
                    identity.userId,
                    identity.sessionId
                );
                if (
                    user === undefined ||
                    user.disabledAt !== null ||
                    actorSession === undefined ||
                    actorSession.authenticationVersion !== user.authenticationVersion ||
                    !sessionIsActive(
                        actorSession,
                        checkedAt,
                        context.sessionIdleDurationMs
                    )
                ) {
                    return;
                }
                return reader
                    .listSessions({
                        authenticationVersion: user.authenticationVersion,
                        checkedAt,
                        idleAfter: addMilliseconds(
                            checkedAt,
                            -context.sessionIdleDurationMs
                        ),
                        limit: browserSessionMaximumPerUser,
                        userId: identity.userId,
                    })
                    .filter(
                        (session) =>
                            session.authenticationVersion ===
                                user.authenticationVersion &&
                            sessionIsActive(
                                session,
                                checkedAt,
                                context.sessionIdleDurationMs
                            )
                    )
                    .map((session) => authSession(session, identity.sessionId));
            });
        },

        async logout(identity, metadata) {
            if (identity === undefined) return false;
            return await context.repository.withImmediateTransaction((unit) => {
                const occurredAt = context.now();
                const revoked = unit.deleteSession(identity.userId, identity.sessionId);
                if (!revoked) return false;
                context.audit(unit, {
                    action: "auth.logout",
                    actor: sessionActor(identity),
                    occurredAt,
                    outcome: "succeeded",
                    requestId: metadata.requestId,
                    targetId: identity.sessionId,
                    targetType: "auth_session",
                });
                return true;
            });
        },

        async revokeSession(identity, sessionId, metadata) {
            return await context.repository.withImmediateTransaction((unit) => {
                const occurredAt = context.now();
                const access = sessionMutationAccess(context, unit, identity, occurredAt);
                if (access === "session-changed") return;
                if (access === "step-up-required") {
                    return { status: "step-up-required" as const };
                }
                const revoked = unit.deleteSession(identity.userId, sessionId);
                if (revoked) {
                    context.audit(unit, {
                        action: "auth.session.revoke",
                        actor: sessionActor(identity),
                        metadata: { revoked: true },
                        occurredAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: sessionId,
                        targetType: "auth_session",
                    });
                }
                return { revoked };
            });
        },

        async revokeAllSessions(identity, metadata) {
            return await context.repository.withImmediateTransaction((unit) => {
                const occurredAt = context.now();
                const access = sessionMutationAccess(context, unit, identity, occurredAt);
                if (access === "session-changed") return;
                if (access === "step-up-required") {
                    return { status: "step-up-required" as const };
                }
                unit.deletePendingLoginsForUser(identity.userId);
                const revokedSessions = unit.deleteAllSessions(identity.userId);
                if (revokedSessions > 0) {
                    context.audit(unit, {
                        action: "auth.session.revoke-all",
                        actor: sessionActor(identity),
                        metadata: { revokedSessions },
                        occurredAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: identity.userId,
                        targetType: "auth_sessions",
                    });
                }
                return { revokedSessions };
            });
        },

        async revokeOtherSessions(identity, metadata) {
            return await context.repository.withImmediateTransaction((unit) => {
                const occurredAt = context.now();
                const access = sessionMutationAccess(context, unit, identity, occurredAt);
                if (access === "session-changed") return;
                if (access === "step-up-required") {
                    return { status: "step-up-required" as const };
                }
                const revokedSessions = unit.deleteOtherSessions(
                    identity.userId,
                    identity.sessionId
                );
                if (revokedSessions > 0) {
                    context.audit(unit, {
                        action: "auth.session.revoke-others",
                        actor: sessionActor(identity),
                        metadata: { revokedSessions },
                        occurredAt,
                        outcome: "succeeded",
                        requestId: metadata.requestId,
                        targetId: identity.userId,
                        targetType: "auth_sessions",
                    });
                }
                return { revokedSessions };
            });
        },

        status(identity) {
            const isBootstrapRequired = context.repository.countUsers() === 0;
            if (identity === undefined || isBootstrapRequired) {
                return { authenticated: false, isBootstrapRequired };
            }
            const user = context.repository.findUserById(identity.userId);
            const session = context.repository.findSession(
                identity.userId,
                identity.sessionId
            );
            if (
                user === undefined ||
                user.disabledAt !== null ||
                session === undefined ||
                session.authenticationVersion !== user.authenticationVersion ||
                !sessionIsActive(session, context.now(), context.sessionIdleDurationMs)
            ) {
                return { authenticated: false, isBootstrapRequired: false };
            }
            return {
                authenticated: true,
                isBootstrapRequired: false,
                session: authSession(session, identity.sessionId),
                user: authUser(user),
            };
        },

        async touchSession(identity) {
            const touchedAt = context.now();
            const user = context.repository.findUserById(identity.userId);
            const current = context.repository.findSession(
                identity.userId,
                identity.sessionId
            );
            if (
                user === undefined ||
                user.disabledAt !== null ||
                current === undefined ||
                current.authenticationVersion !== user.authenticationVersion ||
                !sessionIsActive(current, touchedAt, context.sessionIdleDurationMs)
            ) {
                return;
            }
            if (
                differenceInMilliseconds(touchedAt, current.lastSeenAt) <
                sessionActivityWriteIntervalMs
            ) {
                return { lastSeenAtMs: getTime(current.lastSeenAt) };
            }
            const updated = await context.repository.withImmediateTransaction((unit) => {
                const currentUser = unit.findUserById(identity.userId);
                if (
                    currentUser === undefined ||
                    currentUser.disabledAt !== null ||
                    currentUser.authenticationVersion !== current.authenticationVersion
                ) {
                    return;
                }
                return unit.touchSession(
                    identity.userId,
                    identity.sessionId,
                    touchedAt,
                    addMilliseconds(touchedAt, -sessionActivityWriteIntervalMs)
                );
            });
            if (updated !== undefined) {
                return { lastSeenAtMs: getTime(updated.lastSeenAt) };
            }
            const refreshed = context.repository.findSession(
                identity.userId,
                identity.sessionId
            );
            return refreshed !== undefined &&
                refreshed.authenticationVersion === user.authenticationVersion &&
                sessionIsActive(refreshed, touchedAt, context.sessionIdleDurationMs)
                ? { lastSeenAtMs: getTime(refreshed.lastSeenAt) }
                : undefined;
        },
    };
}
