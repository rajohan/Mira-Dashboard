import { expect, test } from "bun:test";

import { createResendPasswordRecoveryEmailSender } from "./passwordRecoveryEmail.ts";

function normalizeRequestUrl(input: string | URL | Request): string {
    if (typeof input === "string") return input;
    return input instanceof URL ? input.href : input.url;
}

test("Resend password recovery uses the fixed host and idempotent transactional payload", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const sender = createResendPasswordRecoveryEmailSender({
        apiKey: "test-api-key",
        fetch: Object.assign(
            (input: string | URL | Request, init?: RequestInit) => {
                requestUrl = normalizeRequestUrl(input);
                requestInit = init;
                return Promise.resolve(new Response(null, { status: 202 }));
            },
            { preconnect() {} }
        ),
        fromEmail: "no-reply@account.example.com",
    });
    await sender.send({
        idempotencyKey: "password-reset/abc",
        resetUrl: "https://dashboard.example.com/login?resetToken=secret",
        to: "operator@example.com",
    });
    expect(requestUrl).toBe("https://api.resend.com/emails");
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("Idempotency-Key")).toBe(
        "password-reset/abc"
    );
    if (typeof requestInit?.body !== "string") throw new TypeError("Expected JSON body");
    expect(JSON.parse(requestInit.body)).toMatchObject({
        from: "Mira Dashboard <no-reply@account.example.com>",
        subject: "Reset your Mira Dashboard password",
        to: ["operator@example.com"],
    });

    await sender.sendVerification({
        idempotencyKey: "email-verification/def",
        to: "replacement@example.com",
        verificationUrl: "https://dashboard.example.com/login?verifyEmailToken=secret",
    });
    expect(new Headers(requestInit?.headers).get("Idempotency-Key")).toBe(
        "email-verification/def"
    );
    if (typeof requestInit?.body !== "string") throw new TypeError("Expected JSON body");
    expect(JSON.parse(requestInit.body)).toMatchObject({
        subject: "Verify your Mira Dashboard email",
        to: ["replacement@example.com"],
    });
});
