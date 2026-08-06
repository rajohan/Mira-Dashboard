import { addMilliseconds, differenceInMilliseconds, getTime } from "date-fns";

import { browserSessionMaximumPerUser } from "../../../contracts/auth.ts";
import {
    sessionActivityWriteIntervalMs,
    type AuthenticationLifecycleContext,
} from "./authenticationLifecycleContext.ts";
import type { AuthenticationLifecycleService } from "./authenticationLifecycleTypes.ts";
import {
    authSession,
    authUser,
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

/**
 * Creates session reads, activity, logout, and revocation operations.
 * @returns Session operations backed by the shared lifecycle context.
 */
export function createAuthenticationSessionOperations(
    context: SessionsContext
): Pick<
    AuthenticationLifecycleService,
    "listSessions" | "logout" | "revokeSession" | "status" | "touchSession"
> {
    return {
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

        logout(identity, metadata) {
            if (identity === undefined) return false;
            return context.repository.withImmediateTransaction((unit) => {
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

        revokeSession(identity, sessionId, metadata) {
            return context.repository.withImmediateTransaction((unit) => {
                const occurredAt = context.now();
                const user = unit.findUserById(identity.userId);
                const actorSession = unit.findSession(
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
                        occurredAt,
                        context.sessionIdleDurationMs
                    )
                ) {
                    return;
                }
                const recentAuthentication = evaluateRecentAuthentication({
                    checkedAt: occurredAt,
                    mfaEnabledAt: user.mfaEnabledAt,
                    mfaVerifiedAt: actorSession.mfaVerifiedAt,
                    passwordVerifiedAt: actorSession.passwordVerifiedAt,
                    windowMs: context.recentAuthenticationWindowMs,
                });
                if (
                    user.mfaEnabledAt === null
                        ? !recentAuthentication.password.recent
                        : !recentAuthentication.mfa.recent
                ) {
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

        touchSession(identity) {
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
            const updated = context.repository.withImmediateTransaction((unit) => {
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
