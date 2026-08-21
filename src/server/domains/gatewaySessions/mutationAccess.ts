import type { RecentMfaAuthorization } from "../security/authenticationLifecycleTypes.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";

/** Narrow session-bound recent-MFA policy required by OpenClaw controls. */
export interface GatewaySessionMutationAccess {
    readonly authorizeRecentMfa: (
        identity: AuthenticatedBrowserIdentity
    ) => RecentMfaAuthorization;
}
