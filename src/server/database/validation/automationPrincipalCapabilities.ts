import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    applicationCapabilitySchema,
    automationPrincipalIdSchema,
} from "../../../contracts/security.ts";
import { automationPrincipalCapabilities } from "../schema/automationPrincipalCapabilities.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

const capabilityRefinements = {
    capability: () => applicationCapabilitySchema,
    grantedAt: nonnegativeDateSchema,
    principalId: () => automationPrincipalIdSchema,
};

const generatedCapabilitySelectSchema = createSelectSchema(
    automationPrincipalCapabilities,
    capabilityRefinements
);

/** Validates rows read from automation_principal_capabilities. */
export const automationPrincipalCapabilitySelectSchema = v.strictObject(
    generatedCapabilitySelectSchema.entries
);

const generatedCapabilityInsertSchema = createInsertSchema(
    automationPrincipalCapabilities,
    capabilityRefinements
);

/** Validates one explicit automation capability grant before insertion. */
export const automationPrincipalCapabilityInsertSchema = v.strictObject(
    generatedCapabilityInsertSchema.entries
);
