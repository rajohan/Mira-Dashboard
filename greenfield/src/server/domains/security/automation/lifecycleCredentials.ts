import * as v from "valibot";

import {
    automationCredentialSummarySchema,
    type AutomationCredentialSettings,
    type AutomationCredentialSummary,
} from "../../../../contracts/automationSecurity.ts";
import type { GeneratedOpaqueToken } from "../../../shared/opaqueToken.ts";
import type { AutomationSecurityLifecycleContext } from "./lifecycleContext.ts";
import type { AutomationCredentialInsert } from "./lifecycleRepositoryTypes.ts";

export const automationCredentialGenerationAttemptMaximum = 4;

export interface AutomationCredentialMaterial {
    readonly id: string;
    readonly token: GeneratedOpaqueToken;
}

export type AutomationCredentialMaterialGeneration =
    | {
          readonly materials: readonly AutomationCredentialMaterial[];
          readonly status: "generated";
      }
    | { readonly status: "unavailable" };

export interface AutomationCredentialCandidate {
    readonly insert: AutomationCredentialInsert;
    readonly summary: AutomationCredentialSummary;
    readonly token: GeneratedOpaqueToken;
}

export function credentialExpiry(
    settings: AutomationCredentialSettings,
    createdAt: Date
): Date | null | undefined {
    if (settings.expiresAtMs === undefined) return null;
    if (settings.expiresAtMs <= createdAt.getTime()) return;
    return new Date(settings.expiresAtMs);
}

/**
 * Generates bounded opaque material before acquiring the SQLite write lock.
 * @param context ID and opaque-token generators owned by the process context.
 * @returns Redacted availability outcome containing material only on success.
 */
export function generateCredentialMaterials(
    context: Pick<AutomationSecurityLifecycleContext, "generateId" | "generateToken">
): AutomationCredentialMaterialGeneration {
    try {
        return Object.freeze({
            materials: Array.from(
                { length: automationCredentialGenerationAttemptMaximum },
                (): AutomationCredentialMaterial =>
                    Object.freeze({
                        id: context.generateId(),
                        token: context.generateToken(),
                    })
            ),
            status: "generated" as const,
        });
    } catch {
        return Object.freeze({ status: "unavailable" as const });
    }
}

/**
 * Builds and validates timestamped credential candidates after lock acquisition.
 * @param materials Pre-generated independent identifiers and opaque tokens.
 * @param input Transaction-time credential identity, label, linkage, and timestamps.
 * @returns Frozen validated persistence candidates and one-time summaries.
 */
export function buildCredentialCandidates(
    materials: readonly AutomationCredentialMaterial[],
    input: {
        readonly createdAt: Date;
        readonly expiresAt: Date | null;
        readonly label: string;
        readonly principalId: string;
        readonly replacesCredentialId: string | null;
    }
): readonly AutomationCredentialCandidate[] {
    return materials.map(({ id, token }): AutomationCredentialCandidate => {
        const summary = v.parse(automationCredentialSummarySchema, {
            createdAtMs: input.createdAt.getTime(),
            ...(input.expiresAt === null
                ? {}
                : { expiresAtMs: input.expiresAt.getTime() }),
            id,
            label: input.label,
            prefix: token.prefix,
            ...(input.replacesCredentialId === null
                ? {}
                : { replacesCredentialId: input.replacesCredentialId }),
        });
        return Object.freeze({
            insert: Object.freeze({
                createdAt: input.createdAt,
                expiresAt: input.expiresAt,
                id,
                label: input.label,
                prefix: token.prefix,
                principalId: input.principalId,
                replacesCredentialId: input.replacesCredentialId,
                revokedAt: null,
                validatorHash: token.validatorHash,
            }),
            summary,
            token,
        });
    });
}
