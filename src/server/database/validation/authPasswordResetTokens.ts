import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { authEmailInputSchema } from "../../../contracts/auth.ts";
import { authPasswordResetTokens } from "../schema/authPasswordResetTokens.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

const prefixSchema = v.pipe(v.string(), v.length(32), v.regex(/^[0-9a-f]+$/u));
const positiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const sha256HexSchema = (schema: v.StringSchema<undefined>) =>
    v.pipe(schema, v.length(64), v.regex(/^[0-9a-f]+$/u));
const refinements = {
    authenticationVersion: () => positiveIntegerSchema,
    createdAt: nonnegativeDateSchema,
    expiresAt: nonnegativeDateSchema,
    pendingEmail: () => v.nullable(authEmailInputSchema),
    prefix: () => prefixSchema,
    purpose: () => v.picklist(["email-verification", "password-reset"]),
    userId: uuidV7TextSchema,
    validatorHash: sha256HexSchema,
    validatorVersion: () => positiveIntegerSchema,
};

export const authPasswordResetTokenSelectSchema = v.strictObject(
    createSelectSchema(authPasswordResetTokens, refinements).entries
);
export const authPasswordResetTokenInsertSchema = v.strictObject(
    createInsertSchema(authPasswordResetTokens, refinements).entries
);
