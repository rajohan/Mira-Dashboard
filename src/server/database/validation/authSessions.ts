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
    sessionSelectorSchema,
    sha256TextSchema,
} from "./securityScalars.ts";

function sessionTimesAreOrdered(session: {
    readonly authenticatedAt: Date;
    readonly createdAt: Date;
    readonly elevatedAt?: Date | null;
    readonly elevatedMethod?: string | null;
    readonly expiresAt: Date;
    readonly lastSeenAt: Date;
    readonly mfaVerifiedAt?: Date | null;
}): boolean {
    const elevationPairMatches =
        (session.elevatedAt == null) === (session.elevatedMethod == null);
    return (
        compareAsc(session.authenticatedAt, session.createdAt) <= 0 &&
        compareAsc(session.expiresAt, session.createdAt) > 0 &&
        compareAsc(session.lastSeenAt, session.createdAt) >= 0 &&
        compareAsc(session.lastSeenAt, session.expiresAt) < 0 &&
        (session.mfaVerifiedAt == null ||
            (compareAsc(session.mfaVerifiedAt, session.authenticatedAt) >= 0 &&
                compareAsc(session.mfaVerifiedAt, session.expiresAt) < 0)) &&
        elevationPairMatches &&
        (session.elevatedAt == null ||
            (compareAsc(session.elevatedAt, session.authenticatedAt) >= 0 &&
                compareAsc(session.elevatedAt, session.expiresAt) < 0))
    );
}

const sessionRefinements = {
    authenticatedAt: nonnegativeDateSchema,
    authenticationVersion: () =>
        positiveSafeIntegerSchema("Session authentication version is invalid"),
    authMethod: () => authenticationMethodSchema,
    createdAt: nonnegativeDateSchema,
    elevatedAt: nonnegativeDateSchema,
    elevatedMethod: () => v.nullable(authenticationMethodSchema),
    expiresAt: nonnegativeDateSchema,
    id: () => sessionSelectorSchema,
    lastSeenAt: nonnegativeDateSchema,
    mfaVerifiedAt: nonnegativeDateSchema,
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

/** Validates a complete durable browser session before insertion. */
export const authSessionInsertSchema = v.pipe(
    v.strictObject({
        authenticatedAt: generatedSessionInsertSchema.entries.authenticatedAt,
        authenticationVersion: generatedSessionInsertSchema.entries.authenticationVersion,
        authMethod: generatedSessionInsertSchema.entries.authMethod,
        createdAt: generatedSessionInsertSchema.entries.createdAt,
        elevatedAt: generatedSessionInsertSchema.entries.elevatedAt,
        elevatedMethod: generatedSessionInsertSchema.entries.elevatedMethod,
        expiresAt: generatedSessionInsertSchema.entries.expiresAt,
        id: generatedSessionInsertSchema.entries.id,
        lastSeenAt: generatedSessionInsertSchema.entries.lastSeenAt,
        mfaVerifiedAt: generatedSessionInsertSchema.entries.mfaVerifiedAt,
        userAgent: generatedSessionInsertSchema.entries.userAgent,
        userId: generatedSessionInsertSchema.entries.userId,
        validatorHash: generatedSessionInsertSchema.entries.validatorHash,
    }),
    v.check(
        (session) => sessionTimesAreOrdered(session),
        "Session timestamps are inconsistent"
    )
);
