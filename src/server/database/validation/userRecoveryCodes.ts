import { compareAsc } from "date-fns";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { userRecoveryCodes } from "../schema/userRecoveryCodes.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import { argon2idPasswordHashSchema, opaqueSelectorSchema } from "./securityScalars.ts";

function recoveryCodeTimesAreOrdered(code: {
    readonly createdAt: Date;
    readonly usedAt?: Date | null;
}): boolean {
    return code.usedAt == null || compareAsc(code.usedAt, code.createdAt) >= 0;
}

const recoveryCodeRefinements = {
    createdAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    selector: () => opaqueSelectorSchema,
    usedAt: nonnegativeDateSchema,
    userId: uuidV7TextSchema,
    validatorHash: () => argon2idPasswordHashSchema,
};

const generatedRecoveryCodeSelectSchema = createSelectSchema(
    userRecoveryCodes,
    recoveryCodeRefinements
);

/** Validates recovery-code rows read from SQLite. */
export const userRecoveryCodeSelectSchema = v.pipe(
    v.strictObject(generatedRecoveryCodeSelectSchema.entries),
    v.check(
        (recoveryCode) => recoveryCodeTimesAreOrdered(recoveryCode),
        "Recovery code timestamps are inconsistent"
    )
);

const generatedRecoveryCodeInsertSchema = createInsertSchema(
    userRecoveryCodes,
    recoveryCodeRefinements
);

/** Validates one canonical Argon2id-backed recovery code before insertion. */
export const userRecoveryCodeInsertSchema = v.pipe(
    v.strictObject(generatedRecoveryCodeInsertSchema.entries),
    v.check(
        (recoveryCode) => recoveryCodeTimesAreOrdered(recoveryCode),
        "Recovery code timestamps are inconsistent"
    )
);
