import type { RecentMfaAuthorization } from "../security/authenticationLifecycleTypes.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";

/** Narrow session-bound recent-MFA policy used by OpenClaw settings controls. */
export interface OpenClawSettingsMutationAccess {
    readonly authorizeRecentMfa: (
        identity: AuthenticatedBrowserIdentity
    ) => RecentMfaAuthorization;
}
