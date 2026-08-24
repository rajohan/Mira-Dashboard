import { compareAsc } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import { opaqueTokenValidatorVersion } from "../../shared/opaqueToken.ts";
import { automationCredentials } from "../schema/automationCredentials.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import {
    automationPrincipalIdSchema,
    controlSafeSecurityLabelSchema,
    opaqueSelectorSchema,
    sha256TextSchema,
} from "./securityScalars.ts";

function credentialTimesAreOrdered(credential: {
    readonly createdAt: Date;
    readonly expiresAt?: Date | null;
    readonly revokedAt?: Date | null;
}): boolean {
    return (
        (credential.expiresAt == null ||
            compareAsc(credential.expiresAt, credential.createdAt) > 0) &&
        (credential.revokedAt == null ||
            compareAsc(credential.revokedAt, credential.createdAt) >= 0)
    );
}

function credentialDoesNotReplaceItself(credential: {
    readonly id: string;
    readonly replacesCredentialId?: string | null;
}): boolean {
    return (
        credential.replacesCredentialId == null ||
        credential.replacesCredentialId !== credential.id
    );
}

const credentialRefinements = {
    createdAt: nonnegativeDateSchema,
    expiresAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    label: () => controlSafeSecurityLabelSchema,
    prefix: () => opaqueSelectorSchema,
    principalId: () => automationPrincipalIdSchema,
    replacesCredentialId: uuidV7TextSchema,
    revokedAt: nonnegativeDateSchema,
    validatorHash: sha256TextSchema,
    validatorVersion: (
        schema: GetValibotTypeFromColumn<typeof automationCredentials.validatorVersion>
    ) => v.pipe(schema, v.value(opaqueTokenValidatorVersion)),
};

const generatedCredentialSelectSchema = createSelectSchema(
    automationCredentials,
    credentialRefinements
);

/** Validates rows read from automation_credentials. */
export const automationCredentialSelectSchema = v.pipe(
    v.strictObject(generatedCredentialSelectSchema.entries),
    v.check(
        (credential) => credentialTimesAreOrdered(credential),
        "Automation credential timestamps are inconsistent"
    ),
    v.check(
        (credential) => credentialDoesNotReplaceItself(credential),
        "Automation credential cannot replace itself"
    )
);

const generatedCredentialInsertSchema = createInsertSchema(
    automationCredentials,
    credentialRefinements
);
const credentialInsertEntries = v.omit(generatedCredentialInsertSchema, [
    "validatorVersion",
]).entries;

/** Validates a new credential while keeping validatorVersion database-owned. */
export const automationCredentialInsertSchema = v.pipe(
    v.strictObject(credentialInsertEntries),
    v.check(
        (credential) => credentialTimesAreOrdered(credential),
        "Automation credential timestamps are inconsistent"
    ),
    v.check(
        (credential) => credentialDoesNotReplaceItself(credential),
        "Automation credential cannot replace itself"
    )
);
