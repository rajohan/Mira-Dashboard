import { compareAsc, differenceInMilliseconds } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";
import { opaqueTokenValidatorVersion } from "../../shared/opaqueToken.ts";
import { pendingLoginLifetimeMs } from "../../shared/pendingLoginPolicy.ts";
import { authPendingLogins } from "../schema/authPendingLogins.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import {
    opaqueSelectorSchema,
    securityUserAgentSchema,
    sha256TextSchema,
} from "./securityScalars.ts";

function pendingLoginStateIsValid(login: {
    readonly allowsRecovery: boolean;
    readonly allowsTotp: boolean;
    readonly allowsWebAuthn: boolean;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly passwordVerifiedAt: Date;
}): boolean {
    const lifetimeMs = differenceInMilliseconds(
        login.expiresAt,
        login.passwordVerifiedAt
    );
    return (
        (login.allowsRecovery || login.allowsTotp || login.allowsWebAuthn) &&
        compareAsc(login.passwordVerifiedAt, login.createdAt) <= 0 &&
        compareAsc(login.expiresAt, login.createdAt) > 0 &&
        lifetimeMs > 0 &&
        lifetimeMs <= pendingLoginLifetimeMs
    );
}

const pendingLoginRefinements = {
    attemptCount: () =>
        v.pipe(
            v.number("Pending login attempt count is invalid"),
            v.safeInteger("Pending login attempt count is invalid"),
            v.minValue(0, "Pending login attempt count is invalid"),
            v.maxValue(8, "Pending login attempt count is invalid")
        ),
    authenticationVersion: () =>
        positiveSafeIntegerSchema("Pending login authentication version is invalid"),
    createdAt: nonnegativeDateSchema,
    expiresAt: nonnegativeDateSchema,
    id: () => opaqueSelectorSchema,
    passwordVerifiedAt: nonnegativeDateSchema,
    replacedSessionId: () => v.nullable(opaqueSelectorSchema),
    userAgent: () => v.nullable(securityUserAgentSchema),
    userId: uuidV7TextSchema,
    validatorHash: sha256TextSchema,
    validatorVersion: (
        schema: GetValibotTypeFromColumn<typeof authPendingLogins.validatorVersion>
    ) => v.pipe(schema, v.value(opaqueTokenValidatorVersion)),
};

const generatedPendingLoginSelectSchema = createSelectSchema(
    authPendingLogins,
    pendingLoginRefinements
);

/** Validates rows read from auth_pending_logins. */
export const authPendingLoginSelectSchema = v.pipe(
    v.strictObject(generatedPendingLoginSelectSchema.entries),
    v.check(
        (pendingLogin) => pendingLoginStateIsValid(pendingLogin),
        "Pending login state is inconsistent"
    )
);

const generatedPendingLoginInsertSchema = createInsertSchema(
    authPendingLogins,
    pendingLoginRefinements
);
const pendingLoginInsertEntries = v.omit(generatedPendingLoginInsertSchema, [
    "attemptCount",
    "validatorVersion",
]).entries;

/** Validates a new pending login while keeping counters and versions database-owned. */
export const authPendingLoginInsertSchema = v.pipe(
    v.strictObject(pendingLoginInsertEntries),
    v.check(
        (pendingLogin) => pendingLoginStateIsValid(pendingLogin),
        "Pending login state is inconsistent"
    )
);
