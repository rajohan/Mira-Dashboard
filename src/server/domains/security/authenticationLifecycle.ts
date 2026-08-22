import { createAuthenticationBootstrapOperation } from "./authenticationLifecycleBootstrap.ts";
import { createAuthenticationLifecycleContext } from "./authenticationLifecycleContext.ts";
import { createAuthenticationLoginOperation } from "./authenticationLifecycleLogin.ts";
import { createAuthenticationPasswordOperation } from "./authenticationLifecyclePassword.ts";
import { createAuthenticationPasswordRecoveryOperations } from "./authenticationLifecyclePasswordRecovery.ts";
import { createAuthenticationSessionOperations } from "./authenticationLifecycleSessions.ts";
import type {
    AuthenticationLifecycleDependencies,
    AuthenticationLifecycleService,
} from "./authenticationLifecycleTypes.ts";

export type {
    AuthenticationLifecycleDependencies,
    AuthenticationLifecycleService,
    AuthenticationStatus,
    BootstrapResult,
    ChangePasswordResult,
    LoginResult,
    PendingLoginLifecyclePort,
    RecentMfaAuthorization,
    VerifyGatewayCredential,
} from "./authenticationLifecycleTypes.ts";
export type {
    AuthenticatedBrowserIdentity,
    AuthenticationRequestMetadata,
} from "./authenticationSession.ts";

/**
 * Creates the mutable browser-authentication service above validated repositories.
 * @param dependencies Validated persistence, cryptography, clocks, and resource budgets.
 * @returns Frozen service composed from focused authentication use cases.
 */
export function createAuthenticationLifecycleService(
    dependencies: AuthenticationLifecycleDependencies
): AuthenticationLifecycleService {
    const context = createAuthenticationLifecycleContext(dependencies);
    return Object.freeze({
        ...createAuthenticationBootstrapOperation(context),
        ...createAuthenticationLoginOperation(context),
        ...createAuthenticationPasswordOperation(context),
        ...createAuthenticationPasswordRecoveryOperations(context),
        ...createAuthenticationSessionOperations(context),
    });
}
