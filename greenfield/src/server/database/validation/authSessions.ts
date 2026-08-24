import { compareAsc } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import { authenticationMethodSchema } from "../../../contracts/security.ts";
import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";
import { opaqueTokenValidatorVersion } from "../../shared/opaqueToken.ts";
import { authSessions } from "../schema/authSessions.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import {
    securityUserAgentSchema,
    opaqueSelectorSchema,
    sha256TextSchema,
} from "./securityScalars.ts";

function sessionTimesAreOrdered(session: {
    readonly authenticatedAt: Date;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly lastSeenAt: Date;
    readonly mfaVerifiedAt?: Date | null;
    readonly passwordVerifiedAt: Date;
    readonly authMethod: string;
}): boolean {
    return (
        compareAsc(session.authenticatedAt, session.createdAt) <= 0 &&
        compareAsc(session.expiresAt, session.createdAt) > 0 &&
        compareAsc(session.lastSeenAt, session.createdAt) >= 0 &&
        compareAsc(session.lastSeenAt, session.expiresAt) < 0 &&
        compareAsc(session.passwordVerifiedAt, session.authenticatedAt) >= 0 &&
        compareAsc(session.passwordVerifiedAt, session.createdAt) <= 0 &&
        (session.mfaVerifiedAt == null ||
            (compareAsc(session.mfaVerifiedAt, session.authenticatedAt) >= 0 &&
                compareAsc(session.mfaVerifiedAt, session.createdAt) <= 0)) &&
        (session.authMethod === "password" || session.mfaVerifiedAt != null)
    );
}

const sessionRefinements = {
    authenticatedAt: nonnegativeDateSchema,
    authenticationVersion: () =>
        positiveSafeIntegerSchema("Session authentication version is invalid"),
    authMethod: () => authenticationMethodSchema,
    createdAt: nonnegativeDateSchema,
    expiresAt: nonnegativeDateSchema,
    id: () => opaqueSelectorSchema,
    lastSeenAt: nonnegativeDateSchema,
    mfaVerifiedAt: nonnegativeDateSchema,
    passwordVerifiedAt: nonnegativeDateSchema,
    userAgent: () => v.nullable(securityUserAgentSchema),
    userId: uuidV7TextSchema,
    validatorHash: sha256TextSchema,
    validatorVersion: (
        schema: GetValibotTypeFromColumn<typeof authSessions.validatorVersion>
    ) => v.pipe(schema, v.value(opaqueTokenValidatorVersion)),
};

const generatedSessionSelectSchema = createSelectSchema(authSessions, sessionRefinements);

/** Validates joined or direct rows read from auth_sessions. */
export const authSessionSelectSchema = v.pipe(
    v.strictObject(generatedSessionSelectSchema.entries),
    v.check(
        (session) => sessionTimesAreOrdered(session),
        "Session timestamps are inconsistent"
    )
);

const generatedSessionInsertSchema = createInsertSchema(authSessions, sessionRefinements);
const sessionInsertEntries = v.omit(generatedSessionInsertSchema, [
    "validatorVersion",
]).entries;

/** Validates a complete durable browser session before insertion. */
export const authSessionInsertSchema = v.pipe(
    v.strictObject(sessionInsertEntries),
    v.check(
        (session) => sessionTimesAreOrdered(session),
        "Session timestamps are inconsistent"
    )
);
