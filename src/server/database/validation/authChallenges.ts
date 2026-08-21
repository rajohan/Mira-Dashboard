import { compareAsc, differenceInMilliseconds } from "date-fns";
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";
import {
    authChallenges,
    webAuthnChallengeLifetimeMaximumMs,
} from "../schema/authChallenges.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import { opaqueSelectorSchema, sha256TextSchema } from "./securityScalars.ts";
import { persistedWebAuthnChallengeSchema } from "./webauthnScalars.ts";

function authChallengeStateIsValid(challenge: {
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly pendingLoginId?: string | null;
    readonly purpose: string;
    readonly sessionId?: string | null;
}): boolean {
    const lifetimeMs = differenceInMilliseconds(challenge.expiresAt, challenge.createdAt);
    const hasCompatibleBinding =
        (challenge.purpose === "login" &&
            challenge.pendingLoginId != null &&
            challenge.sessionId == null) ||
        ((challenge.purpose === "registration" || challenge.purpose === "step-up") &&
            challenge.sessionId != null &&
            challenge.pendingLoginId == null);
    return (
        hasCompatibleBinding &&
        compareAsc(challenge.expiresAt, challenge.createdAt) > 0 &&
        lifetimeMs <= webAuthnChallengeLifetimeMaximumMs
    );
}

const authChallengeRefinements = {
    authenticationVersion: () =>
        positiveSafeIntegerSchema("WebAuthn authentication version is invalid"),
    challenge: () => persistedWebAuthnChallengeSchema,
    configFingerprint: sha256TextSchema,
    createdAt: nonnegativeDateSchema,
    expiresAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    pendingLoginId: () => v.nullable(opaqueSelectorSchema),
    sessionId: () => v.nullable(opaqueSelectorSchema),
};

const generatedAuthChallengeSelectSchema = createSelectSchema(
    authChallenges,
    authChallengeRefinements
);

/** Validates a single-use WebAuthn challenge read from SQLite. */
export const authChallengeSelectSchema = v.pipe(
    v.strictObject(generatedAuthChallengeSelectSchema.entries),
    v.check(
        (challenge) => authChallengeStateIsValid(challenge),
        "WebAuthn challenge state is inconsistent"
    )
);

const generatedAuthChallengeInsertSchema = createInsertSchema(
    authChallenges,
    authChallengeRefinements
);

/** Validates a purpose-bound WebAuthn challenge before insertion. */
export const authChallengeInsertSchema = v.pipe(
    v.strictObject(generatedAuthChallengeInsertSchema.entries),
    v.check(
        (challenge) => authChallengeStateIsValid(challenge),
        "WebAuthn challenge state is inconsistent"
    )
);
