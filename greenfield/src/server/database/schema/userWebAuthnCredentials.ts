import { sql } from "drizzle-orm";
import {
    blob,
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { factorLabelMaximumLength } from "../../../contracts/accountSecurity.ts";
import {
    webAuthnCredentialIdMaximumLength,
    webAuthnCredentialIdMinimumLength,
    webAuthnPublicKeyMaximumLength,
    webAuthnSupportedAlgorithm,
    type WebAuthnTransport,
} from "../../../contracts/webauthn.ts";
import {
    boundedCanonicalBase64UrlTextCheck,
    boundedControlSafeTextCheck,
    boundedNonBlankTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import { users } from "./users.ts";

export const webAuthnCounterMaximum = 4_294_967_295;
export const webAuthnTransportBitmaskMaximum = 127;
export const webAuthnTransportBitByName = Object.freeze({
    ble: 1,
    cable: 2,
    hybrid: 4,
    internal: 8,
    nfc: 16,
    "smart-card": 32,
    usb: 64,
} satisfies Readonly<Record<WebAuthnTransport, number>>);

/** Verified WebAuthn public-key credentials owned by one dashboard user. */
export const userWebAuthnCredentials = sqliteTable(
    "user_webauthn_credentials",
    {
        algorithm: integer("algorithm").notNull(),
        backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
        counter: integer("counter").notNull(),
        createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
        credentialId: text("credential_id").notNull(),
        deviceType: text("device_type", {
            enum: ["singleDevice", "multiDevice"],
        }).notNull(),
        id: text("id").notNull().primaryKey(),
        label: text("label").notNull(),
        lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
        publicKey: blob("public_key", { mode: "buffer" }).notNull(),
        rpId: text("rp_id").notNull(),
        transportMask: integer("transport_mask").notNull(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
    },
    (table) => [
        check(
            "user_webauthn_credentials_algorithm_check",
            sql`${table.algorithm} = ${sql.raw(String(webAuthnSupportedAlgorithm))}`
        ),
        check(
            "user_webauthn_credentials_counter_check",
            sql`${table.counter} BETWEEN 0 AND ${sql.raw(String(webAuthnCounterMaximum))}`
        ),
        check(
            "user_webauthn_credentials_credential_id_check",
            boundedCanonicalBase64UrlTextCheck(
                table.credentialId,
                webAuthnCredentialIdMinimumLength,
                webAuthnCredentialIdMaximumLength
            )
        ),
        check(
            "user_webauthn_credentials_device_state_check",
            sql`${table.backedUp} IN (0, 1) AND ${table.deviceType} IN ('singleDevice', 'multiDevice') AND NOT (${table.deviceType} = 'singleDevice' AND ${table.backedUp} = 1)`
        ),
        check("user_webauthn_credentials_id_check", uuidV7TextCheck(table.id)),
        check(
            "user_webauthn_credentials_label_check",
            boundedControlSafeTextCheck(table.label, factorLabelMaximumLength)
        ),
        check(
            "user_webauthn_credentials_public_key_check",
            sql`length(${table.publicKey}) BETWEEN 1 AND ${sql.raw(String(webAuthnPublicKeyMaximumLength))}`
        ),
        check(
            "user_webauthn_credentials_rp_id_check",
            boundedNonBlankTextCheck(table.rpId, 253)
        ),
        check(
            "user_webauthn_credentials_time_check",
            sql`${timestampMillisecondsCheck(table.createdAt)} AND (${table.lastUsedAt} IS NULL OR (${timestampMillisecondsCheck(table.lastUsedAt)} AND ${table.lastUsedAt} >= ${table.createdAt}))`
        ),
        check(
            "user_webauthn_credentials_transport_mask_check",
            sql`${table.transportMask} BETWEEN 0 AND ${sql.raw(String(webAuthnTransportBitmaskMaximum))}`
        ),
        uniqueIndex("user_webauthn_credentials_credential_id_unique").on(
            table.credentialId
        ),
        index("user_webauthn_credentials_user_created_idx").on(
            table.userId,
            table.createdAt,
            table.id
        ),
    ]
);
