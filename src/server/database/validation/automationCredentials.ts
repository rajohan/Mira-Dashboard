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
    securityLabelSchema,
    sessionSelectorSchema,
    sha256TextSchema,
} from "./securityScalars.ts";

function credentialTimesAreOrdered(credential: {
    readonly createdAt: Date;
    readonly expiresAt?: Date | null;
    readonly lastUsedAt?: Date | null;
    readonly revokedAt?: Date | null;
}): boolean {
    return (
        (credential.expiresAt == null ||
            compareAsc(credential.expiresAt, credential.createdAt) > 0) &&
        (credential.lastUsedAt == null ||
            (compareAsc(credential.lastUsedAt, credential.createdAt) >= 0 &&
                (credential.expiresAt == null ||
                    compareAsc(credential.lastUsedAt, credential.expiresAt) < 0) &&
                (credential.revokedAt == null ||
                    compareAsc(credential.lastUsedAt, credential.revokedAt) <= 0))) &&
        (credential.revokedAt == null ||
            compareAsc(credential.revokedAt, credential.createdAt) >= 0)
    );
}

const credentialRefinements = {
    createdAt: nonnegativeDateSchema,
    expiresAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    label: () => securityLabelSchema,
    lastUsedAt: nonnegativeDateSchema,
    prefix: () => sessionSelectorSchema,
    principalId: () => automationPrincipalIdSchema,
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
    )
);

const generatedCredentialInsertSchema = createInsertSchema(
    automationCredentials,
    credentialRefinements
);

/** Validates a new credential while keeping validatorVersion database-owned. */
export const automationCredentialInsertSchema = v.pipe(
    v.strictObject({
        createdAt: generatedCredentialInsertSchema.entries.createdAt,
        expiresAt: generatedCredentialInsertSchema.entries.expiresAt,
        id: generatedCredentialInsertSchema.entries.id,
        label: generatedCredentialInsertSchema.entries.label,
        lastUsedAt: generatedCredentialInsertSchema.entries.lastUsedAt,
        prefix: generatedCredentialInsertSchema.entries.prefix,
        principalId: generatedCredentialInsertSchema.entries.principalId,
        revokedAt: generatedCredentialInsertSchema.entries.revokedAt,
        validatorHash: generatedCredentialInsertSchema.entries.validatorHash,
    }),
    v.check(
        (credential) => credentialTimesAreOrdered(credential),
        "Automation credential timestamps are inconsistent"
    )
);
