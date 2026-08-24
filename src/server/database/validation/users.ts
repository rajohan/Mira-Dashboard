import { compareAsc } from "date-fns";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";
import { users } from "../schema/users.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import { argon2idPasswordHashSchema, securityUsernameSchema } from "./securityScalars.ts";

const userRefinements = {
    authenticationVersion: () =>
        positiveSafeIntegerSchema("User authentication version is invalid"),
    createdAt: nonnegativeDateSchema,
    disabledAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    passwordHash: () => argon2idPasswordHashSchema,
    updatedAt: nonnegativeDateSchema,
    username: () => securityUsernameSchema,
};

function userTimesAreOrdered(user: {
    readonly createdAt: Date;
    readonly disabledAt?: Date | null;
    readonly updatedAt: Date;
}): boolean {
    return (
        compareAsc(user.updatedAt, user.createdAt) >= 0 &&
        (user.disabledAt == null ||
            (compareAsc(user.disabledAt, user.createdAt) >= 0 &&
                compareAsc(user.disabledAt, user.updatedAt) <= 0))
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
        id: generatedUserInsertSchema.entries.id,
        passwordHash: generatedUserInsertSchema.entries.passwordHash,
        updatedAt: generatedUserInsertSchema.entries.updatedAt,
        username: generatedUserInsertSchema.entries.username,
    }),
    v.check((user) => userTimesAreOrdered(user), "User timestamps are inconsistent")
);
