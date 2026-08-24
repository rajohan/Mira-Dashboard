import { describe, expect, test } from "bun:test";

import {
    CONFIG_REDACTION_SENTINEL,
    isSensitiveConfigKey,
    redactConfigJsonText,
} from "./configRedaction.ts";

describe("greenfield config redaction parity", () => {
    test("retains the legacy canonical and suffix secret-key policy", () => {
        for (const key of [
            "apiKey",
            "Authorization",
            "cookie",
            "credentials",
            "gateway-token",
            "private_key",
            "webhookUrl",
            "providerClientSecret",
            "databasePassword",
            "signingKey",
        ]) {
            expect(isSensitiveConfigKey(key)).toBe(true);
        }
        for (const key of ["enabled", "gatewayUrl", "model", "name", "username"]) {
            expect(isSensitiveConfigKey(key)).toBe(false);
        }
    });

    test("deeply redacts valid JSON and fails closed for invalid text", () => {
        const redacted = redactConfigJsonText(
            JSON.stringify({
                gateway: { token: "gateway-secret", url: "ws://127.0.0.1:18789" },
                plugins: [{ apiKey: "plugin-secret", enabled: true }],
            })
        );

        expect(redacted).toBe(
            `${JSON.stringify(
                {
                    gateway: {
                        token: CONFIG_REDACTION_SENTINEL,
                        url: "ws://127.0.0.1:18789",
                    },
                    plugins: [{ apiKey: CONFIG_REDACTION_SENTINEL, enabled: true }],
                },
                undefined,
                2
            )}\n`
        );
        expect(redacted).not.toContain("gateway-secret");
        expect(redacted).not.toContain("plugin-secret");
        expect(redactConfigJsonText('{"token":"unterminated"')).toBeUndefined();
    });
});
