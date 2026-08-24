import { compareAsc } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    type GetValibotTypeFromColumn,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    webAuthnPublicKeyMaximumLength,
    webAuthnSupportedAlgorithm,
} from "../../../contracts/webauthn.ts";
import { nonnegativeSafeIntegerSchema } from "../../../shared/validation.ts";
import {
    userWebAuthnCredentials,
    webAuthnCounterMaximum,
    webAuthnTransportBitmaskMaximum,
} from "../schema/userWebAuthnCredentials.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import { controlSafeSecurityLabelSchema } from "./securityScalars.ts";
import {
    persistedWebAuthnCredentialIdSchema,
    persistedWebAuthnRpIdSchema,
} from "./webauthnScalars.ts";

function webAuthnCredentialStateIsValid(credential: {
    readonly backedUp: boolean;
    readonly createdAt: Date;
    readonly deviceType: string;
    readonly lastUsedAt?: Date | null;
}): boolean {
    return (
        !(credential.deviceType === "singleDevice" && credential.backedUp) &&
        (credential.lastUsedAt == null ||
            compareAsc(credential.lastUsedAt, credential.createdAt) >= 0)
    );
}

const webAuthnCredentialRefinements = {
    algorithm: () => v.literal(webAuthnSupportedAlgorithm),
    counter: () =>
        v.pipe(
            nonnegativeSafeIntegerSchema("WebAuthn counter is invalid"),
            v.maxValue(webAuthnCounterMaximum, "WebAuthn counter is invalid")
        ),
    createdAt: nonnegativeDateSchema,
    credentialId: () => persistedWebAuthnCredentialIdSchema,
    id: uuidV7TextSchema,
    label: () => controlSafeSecurityLabelSchema,
    lastUsedAt: nonnegativeDateSchema,
    publicKey: (
        schema: GetValibotTypeFromColumn<typeof userWebAuthnCredentials.publicKey>
    ) =>
        v.pipe(
            schema,
            v.check(
                (publicKey) =>
                    publicKey.byteLength > 0 &&
                    publicKey.byteLength <= webAuthnPublicKeyMaximumLength,
                "WebAuthn public key is invalid"
            )
        ),
    rpId: () => persistedWebAuthnRpIdSchema,
    transportMask: () =>
        v.pipe(
            nonnegativeSafeIntegerSchema("WebAuthn transport mask is invalid"),
            v.maxValue(
                webAuthnTransportBitmaskMaximum,
                "WebAuthn transport mask is invalid"
            )
        ),
    userId: uuidV7TextSchema,
};

const generatedWebAuthnCredentialSelectSchema = createSelectSchema(
    userWebAuthnCredentials,
    webAuthnCredentialRefinements
);

/** Validates a durable WebAuthn credential read from SQLite. */
export const userWebAuthnCredentialSelectSchema = v.pipe(
    v.strictObject(generatedWebAuthnCredentialSelectSchema.entries),
    v.check(
        (credential) => webAuthnCredentialStateIsValid(credential),
        "WebAuthn credential state is inconsistent"
    )
);

const generatedWebAuthnCredentialInsertSchema = createInsertSchema(
    userWebAuthnCredentials,
    webAuthnCredentialRefinements
);

/** Validates a verified WebAuthn credential before insertion. */
export const userWebAuthnCredentialInsertSchema = v.pipe(
    v.strictObject(generatedWebAuthnCredentialInsertSchema.entries),
    v.check(
        (credential) => webAuthnCredentialStateIsValid(credential),
        "WebAuthn credential state is inconsistent"
    )
);
