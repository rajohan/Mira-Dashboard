import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { utf8ByteLength } from "../../../shared/encoding.ts";
import { jsonObjectSchema, parseJsonText } from "../../../shared/json.ts";
import { boundedNonBlankTextSchema } from "../../../shared/validation.ts";
import { auditEvents } from "../schema/auditEvents.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

export const auditMetadataMaximumBytes = 4 * 1024;

const auditActorKindSchema = v.picklist(["anonymous", "automation", "system", "user"]);
const auditOutcomeSchema = v.picklist([
    "accepted",
    "attempted",
    "cancelled",
    "denied",
    "failed",
    "succeeded",
]);
const auditNameSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(128),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u)
);
const auditMetadataJsonSchema = v.pipe(
    v.string(),
    v.check((value) => utf8ByteLength(value) <= auditMetadataMaximumBytes),
    v.check((value) => v.safeParse(jsonObjectSchema, parseJsonText(value)).success)
);
const auditMetadataInsertJsonSchema = v.pipe(
    v.string(),
    v.check((value) => utf8ByteLength(value) <= auditMetadataMaximumBytes),
    v.transform(parseJsonText),
    jsonObjectSchema,
    v.transform((value) => JSON.stringify(value)),
    v.check((value) => utf8ByteLength(value) <= auditMetadataMaximumBytes)
);

const auditEventSelectRefinements = {
    action: () => auditNameSchema,
    actorId: () => boundedNonBlankTextSchema(128),
    actorKind: () => auditActorKindSchema,
    authenticatorId: () => v.nullable(boundedNonBlankTextSchema(128)),
    id: uuidV7TextSchema,
    metadataJson: () => auditMetadataJsonSchema,
    occurredAt: nonnegativeDateSchema,
    outcome: () => auditOutcomeSchema,
    requestId: () => v.nullable(boundedNonBlankTextSchema(128)),
    targetId: () => boundedNonBlankTextSchema(256),
    targetType: () => v.pipe(auditNameSchema, v.maxLength(64)),
};

function auditActorMatchesAuthenticator(event: {
    readonly actorKind: "anonymous" | "automation" | "system" | "user";
    readonly authenticatorId: string | null;
}): boolean {
    return event.actorKind === "automation" || event.actorKind === "user"
        ? event.authenticatorId !== null
        : event.authenticatorId === null;
}

const generatedAuditEventSelectSchema = createSelectSchema(
    auditEvents,
    auditEventSelectRefinements
);

/** Validates immutable rows read from audit_events. */
export const auditEventSelectSchema = v.pipe(
    v.strictObject(generatedAuditEventSelectSchema.entries),
    v.check(
        (event) => auditActorMatchesAuthenticator(event),
        "Audit actor and authenticator are inconsistent"
    )
);

const generatedAuditEventInsertSchema = createInsertSchema(auditEvents, {
    ...auditEventSelectRefinements,
    metadataJson: () => auditMetadataInsertJsonSchema,
});
const requiredAuditAuthenticatorIdSchema = v.nullable(boundedNonBlankTextSchema(128));

/** Validates one redacted audit event before append-only insertion. */
export const auditEventInsertSchema = v.pipe(
    v.strictObject({
        ...generatedAuditEventInsertSchema.entries,
        authenticatorId: requiredAuditAuthenticatorIdSchema,
    }),
    v.check(
        (event) => auditActorMatchesAuthenticator(event),
        "Audit actor and authenticator are inconsistent"
    )
);
