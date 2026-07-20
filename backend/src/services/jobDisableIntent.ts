import { HttpError } from "../http.ts";

export type JobDisableIntent =
    | { mode: "indefinite"; comment: string }
    | { mode: "until"; comment: string; until: string };

const disableIntentCommentMaxLength = 1000;

/** Validates and normalizes an intentional job-disable annotation. */
export function normalizeJobDisableIntent(value: unknown): JobDisableIntent | undefined {
    if (value === undefined || value === null) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError("disableIntent must be an object", 400);
    }

    const input = value as Record<string, unknown>;
    if (input.mode !== "until" && input.mode !== "indefinite") {
        throw new HttpError("disableIntent.mode must be until or indefinite", 400);
    }
    if (typeof input.comment !== "string" || !input.comment.trim()) {
        throw new HttpError("disableIntent.comment is required", 400);
    }
    const comment = input.comment.trim();
    if (comment.length > disableIntentCommentMaxLength) {
        throw new HttpError(
            `disableIntent.comment must be at most ${disableIntentCommentMaxLength} characters`,
            400
        );
    }
    if (input.mode === "indefinite") {
        return { mode: "indefinite", comment };
    }
    if (typeof input.until !== "string" || !input.until.trim()) {
        throw new HttpError("disableIntent.until is required for until mode", 400);
    }
    const untilTimestamp = Date.parse(input.until);
    if (Number.isNaN(untilTimestamp)) {
        throw new HttpError("disableIntent.until must be a valid timestamp", 400);
    }
    return {
        mode: "until",
        comment,
        until: new Date(untilTimestamp).toISOString(),
    };
}

/** Reads persisted intent without turning malformed data into an API failure. */
export function readJobDisableIntent(value: unknown): JobDisableIntent | undefined {
    try {
        return normalizeJobDisableIntent(value);
    } catch {
        return;
    }
}

/** Parses persisted JSON without treating malformed metadata as intentional. */
export function parseJobDisableIntent(
    value: string | null | undefined
): JobDisableIntent | undefined {
    if (!value) return;
    try {
        return readJobDisableIntent(JSON.parse(value) as unknown);
    } catch {
        return;
    }
}

/** Ensures a newly submitted time-bounded disable has not already expired. */
export function assertJobDisableIntentIsCurrent(intent: JobDisableIntent): void {
    if (intent.mode === "until" && Date.parse(intent.until) <= Date.now()) {
        throw new HttpError("disableIntent.until must be in the future", 400);
    }
}
