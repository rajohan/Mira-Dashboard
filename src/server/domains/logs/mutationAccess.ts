import type { RecentMfaAuthorization } from "../security/authenticationLifecycleTypes.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";

/** Narrow session-bound recent-MFA port for privileged log maintenance requests. */
export interface LogMaintenanceMutationAccess {
    readonly authorizeRecentMfa: (
        identity: AuthenticatedBrowserIdentity
    ) => RecentMfaAuthorization;
}
