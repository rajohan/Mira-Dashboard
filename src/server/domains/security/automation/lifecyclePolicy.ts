import { getTime } from "date-fns";

import type { ApplicationCapability } from "../../../../contracts/security.ts";
import type {
    AutomationCapabilityRecord,
    AutomationLifecycleReader,
    AutomationPrincipalRecord,
} from "./lifecycleRepositoryTypes.ts";
import { AutomationLifecycleStateChangedError } from "./lifecycleSummaries.ts";

export function currentPrincipal(
    reader: AutomationLifecycleReader,
    input: {
        readonly checkedAt: Date;
        readonly expectedAuthorizationVersion: number;
        readonly principalId: string;
    }
): AutomationPrincipalRecord | undefined {
    const principal = reader.findPrincipal(input.principalId);
    if (principal === undefined) return;
    if (
        principal.disabledAt !== null ||
        principal.authorizationVersion !== input.expectedAuthorizationVersion ||
        getTime(principal.createdAt) > getTime(input.checkedAt) ||
        getTime(principal.updatedAt) > getTime(input.checkedAt)
    ) {
        throw new AutomationLifecycleStateChangedError();
    }
    return principal;
}

export function validatedCapabilities(
    reader: AutomationLifecycleReader,
    principal: AutomationPrincipalRecord,
    checkedAt: Date
): readonly AutomationCapabilityRecord[] {
    const capabilities = reader.listCapabilities(principal.id);
    if (
        capabilities.some(
            ({ grantedAt }) =>
                getTime(grantedAt) < getTime(principal.createdAt) ||
                getTime(grantedAt) > getTime(principal.updatedAt) ||
                getTime(grantedAt) > getTime(checkedAt)
        )
    ) {
        throw new AutomationLifecycleStateChangedError();
    }
    return capabilities;
}

export function capabilityChanges(
    current: readonly AutomationCapabilityRecord[],
    desired: readonly ApplicationCapability[]
): {
    readonly added: readonly ApplicationCapability[];
    readonly changed: boolean;
    readonly removed: readonly ApplicationCapability[];
} {
    const currentSet = new Set(current.map(({ capability }) => capability));
    const desiredSet = new Set(desired);
    const added = desired.filter((capability) => !currentSet.has(capability));
    const removed = [...currentSet].filter((capability) => !desiredSet.has(capability));
    return Object.freeze({
        added,
        changed: added.length > 0 || removed.length > 0,
        removed,
    });
}
