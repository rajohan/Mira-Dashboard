import { compareAsc, differenceInMilliseconds } from "date-fns";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { nonnegativeSafeIntegerSchema } from "../../../shared/validation.ts";
import {
    totpEnrollmentLifetimeMaximumMs,
    userTotpFactors,
} from "../schema/userTotpFactors.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import {
    controlSafeSecurityLabelSchema,
    encryptedTotpSecretEnvelopeSchema,
    mfaSecretKeyIdSchema,
} from "./securityScalars.ts";

function totpFactorStateIsValid(factor: {
    readonly confirmedAt?: Date | null;
    readonly createdAt: Date;
    readonly enrollmentExpiresAt: Date;
    readonly lastUsedStep?: number | null;
}): boolean {
    const enrollmentLifetimeMs = differenceInMilliseconds(
        factor.enrollmentExpiresAt,
        factor.createdAt
    );
    const isPending = factor.confirmedAt == null && factor.lastUsedStep == null;
    const isConfirmed =
        factor.confirmedAt != null &&
        factor.lastUsedStep != null &&
        compareAsc(factor.confirmedAt, factor.createdAt) >= 0 &&
        compareAsc(factor.confirmedAt, factor.enrollmentExpiresAt) < 0;
    return (
        enrollmentLifetimeMs > 0 &&
        enrollmentLifetimeMs <= totpEnrollmentLifetimeMaximumMs &&
        (isPending || isConfirmed)
    );
}

const totpFactorRefinements = {
    confirmedAt: nonnegativeDateSchema,
    createdAt: nonnegativeDateSchema,
    encryptedSecret: () => encryptedTotpSecretEnvelopeSchema,
    enrollmentExpiresAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    label: () => controlSafeSecurityLabelSchema,
    lastUsedStep: () => v.nullable(nonnegativeSafeIntegerSchema("TOTP step is invalid")),
    secretKeyId: () => mfaSecretKeyIdSchema,
    userId: uuidV7TextSchema,
};

const generatedTotpFactorSelectSchema = createSelectSchema(
    userTotpFactors,
    totpFactorRefinements
);

/** Validates encrypted TOTP factor rows read from SQLite. */
export const userTotpFactorSelectSchema = v.pipe(
    v.strictObject(generatedTotpFactorSelectSchema.entries),
    v.check(
        (totpFactor) => totpFactorStateIsValid(totpFactor),
        "TOTP factor state is inconsistent"
    )
);

const generatedTotpFactorInsertSchema = createInsertSchema(
    userTotpFactors,
    totpFactorRefinements
);

/** Validates pending or confirmed TOTP factors before insertion. */
export const userTotpFactorInsertSchema = v.pipe(
    v.strictObject(generatedTotpFactorInsertSchema.entries),
    v.check(
        (totpFactor) => totpFactorStateIsValid(totpFactor),
        "TOTP factor state is inconsistent"
    )
);
