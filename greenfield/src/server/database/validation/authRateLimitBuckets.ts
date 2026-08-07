import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { nonnegativeDateAction } from "../../../shared/dateTime.ts";
import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";
import {
    authenticationRateLimitKinds,
    authRateLimitBuckets,
} from "../schema/authRateLimitBuckets.ts";
import { nonnegativeDateSchema } from "./scalars.ts";
import { sha256TextSchema } from "./securityScalars.ts";

export const authenticationRateLimitKindSchema = v.picklist(
    authenticationRateLimitKinds,
    "Authentication rate-limit kind is invalid"
);

const rateLimitBucketRefinements = {
    blockedUntil: nonnegativeDateSchema,
    bucketKey: sha256TextSchema,
    failureCount: () =>
        positiveSafeIntegerSchema("Authentication failure count is invalid"),
    firstFailedAt: nonnegativeDateSchema,
    kind: () => authenticationRateLimitKindSchema,
    updatedAt: nonnegativeDateSchema,
};

const generatedBucketSelectSchema = createSelectSchema(
    authRateLimitBuckets,
    rateLimitBucketRefinements
);

/** Validates one durable authentication throttle bucket read from SQLite. */
export const authRateLimitBucketSelectSchema = v.pipe(
    v.strictObject(generatedBucketSelectSchema.entries),
    v.check(
        (bucket) =>
            bucket.updatedAt.getTime() >= bucket.firstFailedAt.getTime() &&
            (bucket.blockedUntil === null ||
                bucket.blockedUntil.getTime() > bucket.updatedAt.getTime()),
        "Authentication rate-limit times are inconsistent"
    )
);

const generatedBucketInsertSchema = createInsertSchema(
    authRateLimitBuckets,
    rateLimitBucketRefinements
);
const requiredBlockedUntilSchema = v.nullable(v.pipe(v.date(), nonnegativeDateAction()));

/** Validates complete throttle state before an insert or conflict update. */
export const authRateLimitBucketInsertSchema = v.pipe(
    v.strictObject({
        ...generatedBucketInsertSchema.entries,
        blockedUntil: requiredBlockedUntilSchema,
    }),
    v.check(
        (bucket) =>
            bucket.updatedAt.getTime() >= bucket.firstFailedAt.getTime() &&
            (bucket.blockedUntil === null ||
                bucket.blockedUntil.getTime() > bucket.updatedAt.getTime()),
        "Authentication rate-limit times are inconsistent"
    )
);
