import type {
    CreateAutomationCredentialInput,
    CreateAutomationCredentialResult,
    CreateAutomationPrincipalInput,
    CreateAutomationPrincipalResult,
    DisableAutomationPrincipalInput,
    DisableAutomationPrincipalResult,
    ListAutomationCredentialsInput,
    ListAutomationCredentialsResult,
    ListAutomationPrincipalsInput,
    ListAutomationPrincipalsResult,
    ReplaceAutomationCapabilitiesInput,
    ReplaceAutomationCapabilitiesResult,
    RevokeAutomationCredentialInput,
    RevokeAutomationCredentialResult,
    RotateAutomationCredentialInput,
    RotateAutomationCredentialResult,
} from "../../../../contracts/automationSecurity.ts";
import type { GeneratedOpaqueToken } from "../../../shared/opaqueToken.ts";
import type {
    AuthenticatedBrowserIdentity,
    AuthenticationRequestMetadata,
} from "../authenticationSession.ts";
import type { AutomationLifecycleRepository } from "./lifecycleRepositoryTypes.ts";

export type AutomationAdministrationPolicyFailure =
    | { readonly status: "mfa-enrollment-required" }
    | { readonly status: "session-changed" }
    | { readonly status: "step-up-required" };

export type AutomationAdministrationTargetFailure =
    | { readonly status: "conflict" }
    | { readonly status: "not-found" };

export type AutomationCredentialGenerationFailure =
    | { readonly status: "invalid-expiry" }
    | { readonly status: "unavailable" };

export interface AutomationSecurityLifecycleService {
    createCredential(
        identity: AuthenticatedBrowserIdentity,
        input: CreateAutomationCredentialInput,
        metadata: AuthenticationRequestMetadata
    ):
        | {
              readonly result: CreateAutomationCredentialResult;
              readonly status: "created";
          }
        | AutomationAdministrationPolicyFailure
        | AutomationAdministrationTargetFailure
        | AutomationCredentialGenerationFailure;
    createPrincipal(
        identity: AuthenticatedBrowserIdentity,
        input: CreateAutomationPrincipalInput,
        metadata: AuthenticationRequestMetadata
    ):
        | { readonly result: CreateAutomationPrincipalResult; readonly status: "created" }
        | AutomationAdministrationPolicyFailure
        | AutomationCredentialGenerationFailure
        | { readonly status: "conflict" };
    disablePrincipal(
        identity: AuthenticatedBrowserIdentity,
        input: DisableAutomationPrincipalInput,
        metadata: AuthenticationRequestMetadata
    ):
        | {
              readonly result: DisableAutomationPrincipalResult;
              readonly status: "disabled";
          }
        | AutomationAdministrationPolicyFailure
        | AutomationAdministrationTargetFailure;
    listCredentials(
        identity: AuthenticatedBrowserIdentity,
        input: ListAutomationCredentialsInput
    ):
        | { readonly result: ListAutomationCredentialsResult; readonly status: "listed" }
        | { readonly status: "not-found" }
        | { readonly status: "session-changed" };
    listPrincipals(
        identity: AuthenticatedBrowserIdentity,
        input: ListAutomationPrincipalsInput
    ):
        | { readonly result: ListAutomationPrincipalsResult; readonly status: "listed" }
        | { readonly status: "session-changed" };
    replaceCapabilities(
        identity: AuthenticatedBrowserIdentity,
        input: ReplaceAutomationCapabilitiesInput,
        metadata: AuthenticationRequestMetadata
    ):
        | {
              readonly result: ReplaceAutomationCapabilitiesResult;
              readonly status: "replaced";
          }
        | AutomationAdministrationPolicyFailure
        | AutomationAdministrationTargetFailure;
    revokeCredential(
        identity: AuthenticatedBrowserIdentity,
        input: RevokeAutomationCredentialInput,
        metadata: AuthenticationRequestMetadata
    ):
        | {
              readonly result: RevokeAutomationCredentialResult;
              readonly status: "revoked";
          }
        | AutomationAdministrationPolicyFailure
        | AutomationAdministrationTargetFailure;
    rotateCredential(
        identity: AuthenticatedBrowserIdentity,
        input: RotateAutomationCredentialInput,
        metadata: AuthenticationRequestMetadata
    ):
        | {
              readonly result: RotateAutomationCredentialResult;
              readonly status: "rotated";
          }
        | AutomationAdministrationPolicyFailure
        | AutomationAdministrationTargetFailure
        | AutomationCredentialGenerationFailure;
}

export interface AutomationSecurityLifecycleDependencies {
    readonly generateId?: () => string;
    readonly generateToken?: () => GeneratedOpaqueToken;
    readonly now?: () => Date;
    readonly recentAuthenticationWindowMs?: number;
    readonly repository: AutomationLifecycleRepository;
    readonly sessionIdleDurationMs?: number;
}
