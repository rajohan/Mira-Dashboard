import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    jobAttemptCountSchema,
    jobRunEventKindSchema,
    jobRunEventMessageFitsBudget,
    jobRunEventMessageMaximumLength,
    jobRunEventProgressMaximumBytes,
    jobRunEventProgressSchema,
    jobRunEventSequenceSchema,
} from "../../../contracts/jobModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { boundedControlSafeTextSchema } from "../../../shared/validation.ts";
import { jobRunEvents } from "../schema/jobRunEvents.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

const eventMessageSchema = v.pipe(
    boundedControlSafeTextSchema(
        jobRunEventMessageMaximumLength,
        "Stored job event message is invalid"
    ),
    v.check(jobRunEventMessageFitsBudget, "Stored job event message is invalid")
);
const eventProgressJsonSchema = v.pipe(
    v.string("Stored job event progress is invalid"),
    v.check(
        (value) => utf8ByteLength(value) <= jobRunEventProgressMaximumBytes,
        "Stored job event progress is outside its byte budget"
    ),
    v.check((value) => {
        return v.safeParse(jobRunEventProgressSchema, parseJsonText(value)).success;
    }, "Stored job event progress must contain a bounded JSON object")
);

interface StoredJobRunEvent {
    readonly attempt: number;
    readonly kind:
        | "cancel-requested"
        | "cancelled"
        | "claimed"
        | "failed"
        | "lease-expired"
        | "output-truncated"
        | "progress"
        | "queued"
        | "retry-scheduled"
        | "stderr"
        | "stdout"
        | "succeeded"
        | "timed-out";
    readonly message?: string | null;
    readonly progressJson?: string | null;
    readonly workerInstanceId?: string | null;
}

function eventPayloadIsConsistent(event: StoredJobRunEvent): boolean {
    const message = event.message ?? null;
    const progressJson = event.progressJson ?? null;
    if (event.kind === "progress") return progressJson !== null;
    if (event.kind === "stderr" || event.kind === "stdout") {
        return message !== null && progressJson === null;
    }
    return progressJson === null;
}

function eventAttemptIsConsistent(event: StoredJobRunEvent): boolean {
    if (event.kind === "queued") {
        return event.attempt === 0 && event.workerInstanceId == null;
    }
    if (
        [
            "claimed",
            "failed",
            "lease-expired",
            "output-truncated",
            "progress",
            "retry-scheduled",
            "stderr",
            "stdout",
            "succeeded",
            "timed-out",
        ].includes(event.kind)
    ) {
        return event.attempt > 0;
    }
    return true;
}

const eventRefinements = {
    attempt: () => jobAttemptCountSchema,
    jobRunId: uuidV7TextSchema,
    kind: () => jobRunEventKindSchema,
    message: () => v.nullable(eventMessageSchema),
    occurredAt: nonnegativeDateSchema,
    progressJson: () => v.nullable(eventProgressJsonSchema),
    sequence: () => jobRunEventSequenceSchema,
    workerInstanceId: uuidV7TextSchema,
};

const generatedJobRunEventSelectSchema = createSelectSchema(
    jobRunEvents,
    eventRefinements
);
const jobRunEventSelectObjectSchema = v.strictObject(
    generatedJobRunEventSelectSchema.entries
);

/** Validates one immutable durable job event read from SQLite. */
export const jobRunEventSelectSchema = v.pipe(
    jobRunEventSelectObjectSchema,
    v.check(
        (event) => eventPayloadIsConsistent(event),
        "Stored job event payload is inconsistent"
    ),
    v.check(
        (event) => eventAttemptIsConsistent(event),
        "Stored job event attempt is inconsistent"
    )
);

const generatedJobRunEventInsertSchema = createInsertSchema(
    jobRunEvents,
    eventRefinements
);
const jobRunEventInsertObjectSchema = v.strictObject(
    generatedJobRunEventInsertSchema.entries
);

/** Validates one immutable durable job event before insertion. */
export const jobRunEventInsertSchema = v.pipe(
    jobRunEventInsertObjectSchema,
    v.check(
        (event) => eventPayloadIsConsistent(event),
        "Stored job event payload is inconsistent"
    ),
    v.check(
        (event) => eventAttemptIsConsistent(event),
        "Stored job event attempt is inconsistent"
    )
);
