import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    jobActionKeySchema,
    jobDescriptionSchema,
    scheduleIdSchema,
} from "../../../contracts/jobModel.ts";
import {
    automationPrincipalIdSchema,
    securityRecordIdSchema,
} from "../../../contracts/security.ts";
import { boundedNonBlankTextSchema } from "../../../shared/validation.ts";
import { jobDisableIntents } from "../schema/jobDisableIntents.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

const createdActorKindSchema = v.picklist(["automation", "user"]);
const endedActorKindSchema = v.picklist(["automation", "system", "user"]);
const endedReasonSchema = v.picklist(["expired", "re-enabled", "replaced"]);
const externalJobIdSchema = boundedNonBlankTextSchema(256, "External job id is invalid");

function actorIsValid(kind: "automation" | "system" | "user", id: string): boolean {
    if (kind === "automation") {
        return v.safeParse(automationPrincipalIdSchema, id).success;
    }
    if (kind === "user") return v.safeParse(securityRecordIdSchema, id).success;
    return v.safeParse(jobActionKeySchema, id).success;
}

interface StoredDisableIntent {
    readonly createdAt: Date;
    readonly createdById: string;
    readonly createdByKind: "automation" | "user";
    readonly endedAt?: Date | null;
    readonly endedById?: string | null;
    readonly endedByKind?: "automation" | "system" | "user" | null;
    readonly endedReason?: "expired" | "re-enabled" | "replaced" | null;
    readonly expiresAt?: Date | null;
    readonly externalJobId?: string | null;
    readonly externalProvider?: "openclaw" | null;
    readonly scheduledJobId?: string | null;
    readonly targetKind: "dashboard-schedule" | "openclaw-cron";
}

function disableIntentIsConsistent(intent: StoredDisableIntent): boolean {
    if (!actorIsValid(intent.createdByKind, intent.createdById)) return false;

    const expiresAt = intent.expiresAt ?? null;
    if (expiresAt !== null && expiresAt.getTime() <= intent.createdAt.getTime()) {
        return false;
    }

    const targetsDashboard = intent.targetKind === "dashboard-schedule";
    if (
        targetsDashboard !== (intent.scheduledJobId != null) ||
        targetsDashboard === (intent.externalProvider != null) ||
        targetsDashboard === (intent.externalJobId != null)
    ) {
        return false;
    }

    const endedAt = intent.endedAt ?? null;
    const endedById = intent.endedById ?? null;
    const endedByKind = intent.endedByKind ?? null;
    const endedReason = intent.endedReason ?? null;
    const isOpen = endedAt === null;
    if (
        isOpen !== (endedById === null) ||
        isOpen !== (endedByKind === null) ||
        isOpen !== (endedReason === null)
    ) {
        return false;
    }
    if (isOpen) return true;
    if (
        endedById === null ||
        endedByKind === null ||
        endedReason === null ||
        !actorIsValid(endedByKind, endedById) ||
        endedAt.getTime() < intent.createdAt.getTime()
    ) {
        return false;
    }
    return (
        endedReason !== "expired" ||
        (endedByKind === "system" &&
            expiresAt !== null &&
            endedAt.getTime() >= expiresAt.getTime())
    );
}

const disableIntentRefinements = {
    createdAt: nonnegativeDateSchema,
    createdById: () => v.string(),
    createdByKind: () => createdActorKindSchema,
    endedAt: nonnegativeDateSchema,
    endedById: () => v.nullable(v.string()),
    endedByKind: () => v.nullable(endedActorKindSchema),
    endedReason: () => v.nullable(endedReasonSchema),
    expiresAt: nonnegativeDateSchema,
    externalJobId: () => v.nullable(externalJobIdSchema),
    id: uuidV7TextSchema,
    reason: () => jobDescriptionSchema,
    scheduledJobId: () => v.nullable(scheduleIdSchema),
};

const generatedDisableIntentSelectSchema = createSelectSchema(
    jobDisableIntents,
    disableIntentRefinements
);
const disableIntentSelectObjectSchema = v.strictObject(
    generatedDisableIntentSelectSchema.entries
);

/** Validates one append-only disable-intent row read from SQLite. */
export const jobDisableIntentSelectSchema = v.pipe(
    disableIntentSelectObjectSchema,
    v.check(
        (intent) => disableIntentIsConsistent(intent),
        "Stored job disable intent is inconsistent"
    )
);

const generatedDisableIntentInsertSchema = createInsertSchema(
    jobDisableIntents,
    disableIntentRefinements
);
const disableIntentInsertObjectSchema = v.strictObject(
    generatedDisableIntentInsertSchema.entries
);

/** Validates one open disable intent before insertion. */
export const jobDisableIntentInsertSchema = v.pipe(
    disableIntentInsertObjectSchema,
    v.check(
        (intent) =>
            intent.endedAt == null &&
            intent.endedById == null &&
            intent.endedByKind == null &&
            intent.endedReason == null &&
            disableIntentIsConsistent(intent),
        "New job disable intent must be open and consistent"
    )
);

const jobDisableIntentCloseObjectSchema = v.strictObject({
    endedAt: nonnegativeDateSchema(v.date()),
    endedById: v.string("Job disable-intent closure actor is invalid"),
    endedByKind: endedActorKindSchema,
    endedReason: endedReasonSchema,
});

/** Validates the complete closure projection for an existing disable intent. */
export const jobDisableIntentCloseSchema = v.pipe(
    jobDisableIntentCloseObjectSchema,
    v.check(
        (closure) =>
            actorIsValid(closure.endedByKind, closure.endedById) &&
            (closure.endedReason !== "expired" || closure.endedByKind === "system"),
        "Job disable-intent closure actor is invalid"
    )
);
