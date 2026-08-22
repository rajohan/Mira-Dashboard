const resendEmailEndpoint = "https://api.resend.com/emails";

export interface PasswordRecoveryEmail {
    readonly idempotencyKey: string;
    readonly resetUrl: string;
    readonly signal?: AbortSignal;
    readonly to: string;
}

export interface PasswordRecoveryEmailSender {
    send(message: PasswordRecoveryEmail): Promise<void>;
    sendVerification(message: {
        readonly idempotencyKey: string;
        readonly signal?: AbortSignal;
        readonly to: string;
        readonly verificationUrl: string;
    }): Promise<void>;
}

export interface ResendPasswordRecoveryEmailSenderOptions {
    readonly apiKey: string;
    readonly fetch?: typeof fetch;
    readonly fromEmail: string;
}

/**
 * Creates the fixed-host Resend transport for one transactional reset message.
 * @returns Password-recovery email sender.
 */
export function createResendPasswordRecoveryEmailSender(
    options: ResendPasswordRecoveryEmailSenderOptions
): PasswordRecoveryEmailSender {
    const request = options.fetch ?? fetch;
    async function deliver(input: {
        readonly body: Record<string, unknown>;
        readonly idempotencyKey: string;
        readonly signal?: AbortSignal;
    }): Promise<void> {
        const signal = input.signal
            ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000);
        const response = await request(resendEmailEndpoint, {
            body: JSON.stringify(input.body),
            headers: {
                Authorization: `Bearer ${options.apiKey}`,
                "Content-Type": "application/json",
                "Idempotency-Key": input.idempotencyKey,
            },
            method: "POST",
            signal,
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("Security email delivery failed");
    }
    return Object.freeze({
        async send(message: PasswordRecoveryEmail) {
            const escapedUrl = message.resetUrl.replaceAll("&", "&amp;");
            await deliver({
                body: {
                    from: `Mira Dashboard <${options.fromEmail}>`,
                    html: `<p>A password reset was requested for Mira Dashboard.</p><p><a href="${escapedUrl}">Reset your password</a></p><p>This link expires in 15 minutes and can be used once.</p><p>If you did not request this, you can ignore this email.</p>`,
                    subject: "Reset your Mira Dashboard password",
                    text: `Reset your Mira Dashboard password:\n\n${message.resetUrl}\n\nThis link expires in 15 minutes and can be used once. If you did not request this, you can ignore this email.`,
                    to: [message.to],
                },
                idempotencyKey: message.idempotencyKey,
                signal: message.signal,
            });
        },
        async sendVerification(
            message: Parameters<PasswordRecoveryEmailSender["sendVerification"]>[0]
        ) {
            const escapedUrl = message.verificationUrl.replaceAll("&", "&amp;");
            await deliver({
                body: {
                    from: `Mira Dashboard <${options.fromEmail}>`,
                    html: `<p>Verify this email address for Mira Dashboard.</p><p><a href="${escapedUrl}">Verify email address</a></p><p>This link expires in 15 minutes and can be used once.</p><p>If you did not request this, you can ignore this email.</p>`,
                    subject: "Verify your Mira Dashboard email",
                    text: `Verify your Mira Dashboard email:\n\n${message.verificationUrl}\n\nThis link expires in 15 minutes and can be used once. If you did not request this, you can ignore this email.`,
                    to: [message.to],
                },
                idempotencyKey: message.idempotencyKey,
                signal: message.signal,
            });
        },
    });
}
