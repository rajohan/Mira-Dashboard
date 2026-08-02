import * as v from "valibot";

import { finiteNumberSchema, parseContract } from "../runtime";
import { dashboardAuthMethodSchema, dashboardMfaMethodSchema } from "./methods";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const nonBlankStringSchema = v.pipe(
    v.string(),
    v.check((value) => value.trim().length > 0, "must not be blank")
);

export const totpFactorSchema = v.strictObject({
    confirmedAt: trimmedNonEmptyStringSchema,
    createdAt: trimmedNonEmptyStringSchema,
    id: trimmedNonEmptyStringSchema,
    label: v.string(),
});

export const webAuthnCredentialSchema = v.strictObject({
    backedUp: v.boolean(),
    createdAt: trimmedNonEmptyStringSchema,
    deviceType: v.picklist(["multiDevice", "singleDevice"]),
    id: trimmedNonEmptyStringSchema,
    label: v.string(),
    lastUsedAt: v.optional(nonBlankStringSchema),
});

export const dashboardAuthSessionSchema = v.strictObject({
    authMethod: dashboardAuthMethodSchema,
    authenticatedAt: trimmedNonEmptyStringSchema,
    createdAt: trimmedNonEmptyStringSchema,
    elevatedAt: v.optional(nonBlankStringSchema),
    elevatedMethod: v.optional(dashboardAuthMethodSchema),
    expiresAt: trimmedNonEmptyStringSchema,
    isCurrent: v.boolean(),
    lastSeenAt: trimmedNonEmptyStringSchema,
    mfaVerifiedAt: v.optional(nonBlankStringSchema),
    sessionId: trimmedNonEmptyStringSchema,
    userAgent: v.optional(nonBlankStringSchema),
});

const totpAvailabilitySchema = v.variant("available", [
    v.strictObject({ available: v.literal(true) }),
    v.strictObject({
        available: v.literal(false),
        reason: v.literal("encryption_key_not_configured"),
    }),
]);

const webAuthnAvailabilitySchema = v.variant("available", [
    v.strictObject({
        available: v.literal(true),
        rpId: trimmedNonEmptyStringSchema,
    }),
    v.strictObject({
        available: v.literal(false),
        reason: v.literal("not_configured"),
    }),
]);

export const accountSecuritySummarySchema = v.strictObject({
    factors: v.strictObject({
        enabledAt: v.optional(nonBlankStringSchema),
        methods: v.array(dashboardMfaMethodSchema),
        recoveryCodesRemaining: finiteNumberSchema,
        totpFactors: v.array(totpFactorSchema),
        webAuthnCredentials: v.array(webAuthnCredentialSchema),
    }),
    recentVerification: v.strictObject({
        mfa: v.boolean(),
        mfaRemainingMs: v.optional(finiteNumberSchema),
        mfaUntil: v.optional(nonBlankStringSchema),
        password: v.boolean(),
        passwordUntil: v.optional(nonBlankStringSchema),
    }),
    recommendation: v.strictObject({
        minimumSecurityKeys: finiteNumberSchema,
        needsBackupSecurityKey: v.boolean(),
    }),
    sessions: v.array(dashboardAuthSessionSchema),
    totp: totpAvailabilitySchema,
    webAuthn: webAuthnAvailabilitySchema,
});

export type TotpFactor = v.InferOutput<typeof totpFactorSchema>;
export type WebAuthnCredential = v.InferOutput<typeof webAuthnCredentialSchema>;
export type DashboardAuthSession = v.InferOutput<typeof dashboardAuthSessionSchema>;
export type AccountSecuritySummary = v.InferOutput<typeof accountSecuritySummarySchema>;

export function parseAccountSecuritySummary(
    value: unknown,
    path = "accountSecurity"
): AccountSecuritySummary {
    return parseContract(accountSecuritySummarySchema, value, path);
}
