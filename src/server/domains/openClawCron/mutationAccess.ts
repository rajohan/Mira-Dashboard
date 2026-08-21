import type { RecentMfaAuthorization } from "../security/authenticationLifecycleTypes.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";

/** Narrow session-bound recent-MFA port used by OpenClaw cron controls. */
export interface OpenClawCronMutationAccess {
    readonly authorizeRecentMfa: (
        identity: AuthenticatedBrowserIdentity
    ) => RecentMfaAuthorization;
}
