import { describe, expect, test } from "bun:test";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import { authChallenges } from "./authChallenges.ts";
import * as databaseSchema from "./drizzleSchema.ts";
import {
    userWebAuthnCredentials,
    webAuthnTransportBitByName,
    webAuthnTransportBitmaskMaximum,
} from "./userWebAuthnCredentials.ts";

describe("WebAuthn Drizzle persistence schema", () => {
    test("declares challenge bindings, constraints, cascades, and partial uniqueness", () => {
        const config = getTableConfig(authChallenges);

        expect(config.name).toBe("auth_challenges");
        expect(config.columns.map((column) => column.name)).toEqual([
            "authentication_version",
            "challenge",
            "config_fingerprint",
            "created_at",
            "expires_at",
            "id",
            "pending_login_id",
            "purpose",
            "session_id",
        ]);
        expect(config.columns.find((column) => column.name === "id")?.primary).toBe(true);
        expect(
            config.checks
                .map((constraint) => constraint.name)
                .toSorted((left, right) => left.localeCompare(right))
        ).toEqual([
            "auth_challenges_authentication_version_check",
            "auth_challenges_binding_check",
            "auth_challenges_challenge_check",
            "auth_challenges_config_fingerprint_check",
            "auth_challenges_id_check",
            "auth_challenges_time_check",
        ]);
        expect(
            config.foreignKeys
                .map((foreignKey) => foreignKey.onDelete)
                .toSorted((left, right) => String(left).localeCompare(String(right)))
        ).toEqual(["cascade", "cascade"]);
        expect(
            config.indexes.map((index) => ({
                name: index.config.name,
                partial: index.config.where != null,
                unique: index.config.unique,
            }))
        ).toEqual([
            {
                name: "auth_challenges_expires_at_idx",
                partial: false,
                unique: false,
            },
            {
                name: "auth_challenges_pending_login_purpose_unique",
                partial: true,
                unique: true,
            },
            {
                name: "auth_challenges_session_purpose_unique",
                partial: true,
                unique: true,
            },
        ]);
    });

    test("declares bounded public credentials with durable lookup indexes", () => {
        const config = getTableConfig(userWebAuthnCredentials);

        expect(config.name).toBe("user_webauthn_credentials");
        expect(config.columns.map((column) => column.name)).toEqual([
            "algorithm",
            "backed_up",
            "counter",
            "created_at",
            "credential_id",
            "device_type",
            "id",
            "label",
            "last_used_at",
            "public_key",
            "rp_id",
            "transport_mask",
            "user_id",
        ]);
        expect(
            config.columns.find((column) => column.name === "public_key")?.dataType
        ).toBe("object buffer");
        expect(config.foreignKeys).toHaveLength(1);
        expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
        expect(config.indexes.map((index) => index.config.name)).toEqual([
            "user_webauthn_credentials_credential_id_unique",
            "user_webauthn_credentials_user_created_idx",
        ]);
        expect(config.indexes[0]?.config.unique).toBe(true);
        expect(Object.values(webAuthnTransportBitByName)).toEqual([
            1, 2, 4, 8, 16, 32, 64,
        ]);
        expect(
            Object.values(webAuthnTransportBitByName).reduce(
                (mask, transportBit) => mask | transportBit,
                0
            )
        ).toBe(webAuthnTransportBitmaskMaximum);
    });

    test("exports both tables through the Drizzle Kit catalog", () => {
        expect(databaseSchema.authChallenges).toBe(authChallenges);
        expect(databaseSchema.userWebAuthnCredentials).toBe(userWebAuthnCredentials);
    });
});
