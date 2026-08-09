import type { RecentMfaAuthorization } from "../security/authenticationLifecycleTypes.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";

/** Recent-MFA policy applied to every terminal read and control. */
export interface TerminalRecentAuthenticationAccess {
    readonly authorizeRecentMfa: (
        identity: AuthenticatedBrowserIdentity
    ) => RecentMfaAuthorization;
}
