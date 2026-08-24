import * as v from "valibot";

import { compareStrings, lowercaseUuidV7Schema } from "./validation.ts";

/** Worker-owned marker file read by the web process to distinguish copytruncate generations. */
export const logRotationEpochProjectionFileName = "rotation-epochs.json";
/** Small fixed ceiling for one marker projection. */
export const logRotationEpochProjectionMaximumBytes = 16 * 1024;
/** Bounded source inventory retained in the marker projection. */
export const logRotationEpochProjectionMaximumEntries = 64;

const sourceIdSchema = v.pipe(
    v.string("Log rotation source id is invalid"),
    v.maxLength(128, "Log rotation source id is invalid"),
    v.regex(/^[a-z0-9][a-z0-9.-]*$/u, "Log rotation source id is invalid")
);

const entrySchema = v.strictObject({
    epoch: lowercaseUuidV7Schema("Log rotation epoch is invalid"),
    sourceId: sourceIdSchema,
    state: v.picklist(["committed", "rotating"], "Log rotation epoch state is invalid"),
});

export type LogRotationEpochProjectionEntry = v.InferOutput<typeof entrySchema>;

function entriesAreCanonical(entries: LogRotationEpochProjectionEntry[]): boolean {
    return entries.every(
        (entry, index) =>
            index === 0 ||
            compareStrings(entries[index - 1]!.sourceId, entry.sourceId) < 0
    );
}

/** Exact bounded worker/web rotation-marker boundary. */
export const logRotationEpochProjectionSchema = v.strictObject({
    entries: v.pipe(
        v.array(entrySchema, "Log rotation epochs are invalid"),
        v.maxLength(
            logRotationEpochProjectionMaximumEntries,
            "Log rotation epochs are outside their budget"
        ),
        v.check(entriesAreCanonical, "Log rotation epochs are not canonical")
    ),
    version: v.literal(1, "Log rotation epoch version is invalid"),
});

export type LogRotationEpochProjection = v.InferOutput<
    typeof logRotationEpochProjectionSchema
>;
