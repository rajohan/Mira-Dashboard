import { compareAsc } from "date-fns";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";
import { automationPrincipals } from "../schema/automationPrincipals.ts";
import { nonnegativeDateSchema } from "./scalars.ts";
import { automationPrincipalIdSchema, securityLabelSchema } from "./securityScalars.ts";

function principalTimesAreOrdered(principal: {
    readonly createdAt: Date;
    readonly disabledAt?: Date | null;
    readonly updatedAt: Date;
}): boolean {
    return (
        compareAsc(principal.updatedAt, principal.createdAt) >= 0 &&
        (principal.disabledAt == null ||
            (compareAsc(principal.disabledAt, principal.createdAt) >= 0 &&
                compareAsc(principal.disabledAt, principal.updatedAt) <= 0))
    );
}

const principalRefinements = {
    authorizationVersion: () =>
        positiveSafeIntegerSchema("Automation authorization version is invalid"),
    createdAt: nonnegativeDateSchema,
    disabledAt: nonnegativeDateSchema,
    id: () => automationPrincipalIdSchema,
    label: () => securityLabelSchema,
    updatedAt: nonnegativeDateSchema,
};

const generatedPrincipalSelectSchema = createSelectSchema(
    automationPrincipals,
    principalRefinements
);

/** Validates rows read from automation_principals. */
export const automationPrincipalSelectSchema = v.pipe(
    v.strictObject(generatedPrincipalSelectSchema.entries),
    v.check(
        (principal) => principalTimesAreOrdered(principal),
        "Automation principal timestamps are inconsistent"
    )
);

const generatedPrincipalInsertSchema = createInsertSchema(
    automationPrincipals,
    principalRefinements
);

/** Validates a named automation principal before insertion. */
export const automationPrincipalInsertSchema = v.pipe(
    v.strictObject({
        createdAt: generatedPrincipalInsertSchema.entries.createdAt,
        disabledAt: generatedPrincipalInsertSchema.entries.disabledAt,
        id: generatedPrincipalInsertSchema.entries.id,
        label: generatedPrincipalInsertSchema.entries.label,
        updatedAt: generatedPrincipalInsertSchema.entries.updatedAt,
    }),
    v.check(
        (principal) => principalTimesAreOrdered(principal),
        "Automation principal timestamps are inconsistent"
    )
);
