import { compareAsc } from "date-fns";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { authEmailInputSchema } from "../../../contracts/auth.ts";
import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";
import { users } from "../schema/users.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import { argon2idPasswordHashSchema, securityUsernameSchema } from "./securityScalars.ts";

const userRefinements = {
    authenticationVersion: () =>
        positiveSafeIntegerSchema("User authentication version is invalid"),
    createdAt: nonnegativeDateSchema,
    disabledAt: nonnegativeDateSchema,
    email: () => authEmailInputSchema,
    emailVerifiedAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    mfaEnabledAt: nonnegativeDateSchema,
    passwordHash: () => argon2idPasswordHashSchema,
    updatedAt: nonnegativeDateSchema,
    username: () => securityUsernameSchema,
};

function userTimesAreOrdered(user: {
    readonly createdAt: Date;
    readonly disabledAt?: Date | null;
    readonly emailVerifiedAt?: Date | null;
    readonly mfaEnabledAt?: Date | null;
    readonly updatedAt: Date;
}): boolean {
    return (
        compareAsc(user.updatedAt, user.createdAt) >= 0 &&
        (user.disabledAt == null ||
            (compareAsc(user.disabledAt, user.createdAt) >= 0 &&
                compareAsc(user.disabledAt, user.updatedAt) <= 0)) &&
        (user.emailVerifiedAt == null ||
            (compareAsc(user.emailVerifiedAt, user.createdAt) >= 0 &&
                compareAsc(user.emailVerifiedAt, user.updatedAt) <= 0)) &&
        (user.mfaEnabledAt == null ||
            (compareAsc(user.mfaEnabledAt, user.createdAt) >= 0 &&
                compareAsc(user.mfaEnabledAt, user.updatedAt) <= 0))
    );
}

const generatedUserSelectSchema = createSelectSchema(users, userRefinements);

/** Validates rows read from the users table. */
export const userSelectSchema = v.pipe(
    v.strictObject(generatedUserSelectSchema.entries),
    v.check((user) => userTimesAreOrdered(user), "User timestamps are inconsistent")
);

const generatedUserInsertSchema = createInsertSchema(users, userRefinements);

/** Validates initial operator rows while keeping authenticationVersion database-owned. */
export const userInsertSchema = v.pipe(
    v.strictObject({
        createdAt: generatedUserInsertSchema.entries.createdAt,
        disabledAt: generatedUserInsertSchema.entries.disabledAt,
        email: generatedUserInsertSchema.entries.email,
        emailVerifiedAt: generatedUserInsertSchema.entries.emailVerifiedAt,
        id: generatedUserInsertSchema.entries.id,
        mfaEnabledAt: generatedUserInsertSchema.entries.mfaEnabledAt,
        passwordHash: generatedUserInsertSchema.entries.passwordHash,
        updatedAt: generatedUserInsertSchema.entries.updatedAt,
        username: generatedUserInsertSchema.entries.username,
    }),
    v.check((user) => userTimesAreOrdered(user), "User timestamps are inconsistent")
);
