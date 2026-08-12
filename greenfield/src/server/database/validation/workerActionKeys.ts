import * as v from "valibot";

import { jobActionKeySchema } from "../../../contracts/jobModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { parseJsonText } from "../../../shared/json.ts";
import { compareStrings, hasUniqueArrayItems } from "../../../shared/validation.ts";
import {
    workerActionKeyMaximum,
    workerActionKeysMaximumBytes,
} from "../workerActionKeyPolicy.ts";

function actionKeysAreCanonical(keys: string[]): boolean {
    return (
        hasUniqueArrayItems(keys) &&
        keys.every((key, index) => {
            const previous = keys[index - 1];
            return previous === undefined || compareStrings(previous, key) < 0;
        }) &&
        utf8ByteLength(JSON.stringify(keys)) <= workerActionKeysMaximumBytes
    );
}

/** Strict bounded canonical worker action inventory. */
export const workerActionKeysSchema = v.pipe(
    v.array(jobActionKeySchema, "Worker action keys are invalid"),
    v.maxLength(workerActionKeyMaximum, "Worker action keys are outside their budget"),
    v.check(actionKeysAreCanonical, "Worker action keys are not canonical")
);

/**
 * Canonicalizes one validated release-owned executable-action inventory.
 * @param actionKeys Candidate action identities from worker action definitions.
 * @returns Frozen sorted unique keys safe to persist as worker identity.
 */
export function canonicalWorkerActionKeys(
    actionKeys: readonly string[]
): readonly string[] {
    const sorted = actionKeys
        .map((actionKey) => v.parse(jobActionKeySchema, actionKey))
        .toSorted(compareStrings);
    return Object.freeze([...v.parse(workerActionKeysSchema, sorted)]);
}

/**
 * Serializes one canonical inventory without whitespace or unbounded fields.
 * @param actionKeys Candidate action identities.
 * @returns Canonical JSON text accepted by the worker persistence boundary.
 */
export function serializeWorkerActionKeys(actionKeys: readonly string[]): string {
    return JSON.stringify(canonicalWorkerActionKeys(actionKeys));
}

/**
 * Parses the immutable action inventory stored on one worker row.
 * @param value Stored JSON text.
 * @returns Frozen validated canonical action identities.
 */
export function parseWorkerActionKeysJson(value: string): readonly string[] {
    const parsed = v.parse(workerActionKeysSchema, parseJsonText(value));
    return Object.freeze([...parsed]);
}
