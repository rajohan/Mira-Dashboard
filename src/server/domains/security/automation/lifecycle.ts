import { createAutomationCredentialOperations } from "./credentialOperations.ts";
import { createAutomationSecurityLifecycleContext } from "./lifecycleContext.ts";
import type {
    AutomationSecurityLifecycleDependencies,
    AutomationSecurityLifecycleService,
} from "./lifecycleTypes.ts";
import { createAutomationPrincipalOperations } from "./principalOperations.ts";

export type {
    AutomationSecurityLifecycleDependencies,
    AutomationSecurityLifecycleService,
} from "./lifecycleTypes.ts";

/**
 * Composes browser-managed automation principal and credential operations.
 * @param dependencies Process repository, policy, clock, and generation dependencies.
 * @returns Frozen automation-security lifecycle service.
 */
export function createAutomationSecurityLifecycleService(
    dependencies: AutomationSecurityLifecycleDependencies
): AutomationSecurityLifecycleService {
    const context = createAutomationSecurityLifecycleContext(dependencies);
    return Object.freeze({
        ...createAutomationCredentialOperations(context),
        ...createAutomationPrincipalOperations(context),
    });
}
