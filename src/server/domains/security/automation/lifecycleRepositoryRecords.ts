import * as v from "valibot";

import { automationCredentialSelectSchema } from "../../../database/validation/automationCredentials.ts";
import { automationPrincipalCapabilitySelectSchema } from "../../../database/validation/automationPrincipalCapabilities.ts";
import { automationPrincipalSelectSchema } from "../../../database/validation/automationPrincipals.ts";
import type {
    AutomationCapabilityRecord,
    AutomationCredentialRecord,
    AutomationPrincipalRecord,
} from "./lifecycleRepositoryTypes.ts";

export function parseAutomationPrincipal(row: unknown): AutomationPrincipalRecord {
    return v.parse(automationPrincipalSelectSchema, row);
}

export function parseAutomationCredential(row: unknown): AutomationCredentialRecord {
    const credential = v.parse(automationCredentialSelectSchema, row);
    return {
        createdAt: credential.createdAt,
        expiresAt: credential.expiresAt,
        id: credential.id,
        label: credential.label,
        prefix: credential.prefix,
        principalId: credential.principalId,
        replacesCredentialId: credential.replacesCredentialId,
        revokedAt: credential.revokedAt,
        validatorVersion: credential.validatorVersion,
    };
}

export function parseAutomationCapability(row: unknown): AutomationCapabilityRecord {
    return v.parse(automationPrincipalCapabilitySelectSchema, row);
}
