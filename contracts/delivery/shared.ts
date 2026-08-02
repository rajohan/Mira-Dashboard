import * as v from "valibot";

export const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
export const fullCommitShaSchema = v.pipe(v.string(), v.regex(/^[\da-f]{40}$/u));
