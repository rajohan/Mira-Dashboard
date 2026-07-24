import readline from "node:readline";

import { hashPassword } from "./auth.ts";
import { database } from "./database.ts";
import { writeAuditEvent } from "./services/auditEvents.ts";
import { clearAuthenticationFailures } from "./services/authenticationThrottle.ts";

interface ResetArguments {
    shouldResetMfa: boolean;
    username: string;
}

interface UserIdentity {
    id: number;
    username: string;
}

function usage(): string {
    return [
        "Usage: bun run auth:reset-password -- --username <username> [--reset-mfa]",
        "",
        "The new password is read twice from an interactive TTY and is never",
        "accepted through arguments or environment variables.",
    ].join("\n");
}

function parseArguments(arguments_: string[]): ResetArguments | undefined {
    if (arguments_.includes("--help") || arguments_.includes("-h")) {
        console.log(usage());
        return undefined;
    }
    let username: string | undefined;
    let isResetMfa = false;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === "--reset-mfa") {
            isResetMfa = true;
            continue;
        }
        if (argument === "--username") {
            const candidate = arguments_[index + 1]?.trim();
            if (!candidate || candidate.startsWith("-")) {
                throw new TypeError("--username requires a value");
            }
            username = candidate.toLowerCase();
            index += 1;
            continue;
        }
        throw new TypeError(`Unknown argument: ${argument}`);
    }
    if (!username) {
        throw new TypeError("--username is required");
    }
    return { shouldResetMfa: isResetMfa, username };
}

async function readSecret(prompt: string): Promise<string> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Password reset requires an interactive TTY");
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(prompt);

    return new Promise<string>((resolve, reject) => {
        let value = "";

        function finish(error?: Error): void {
            process.stdin.off("keypress", onKeypress);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write("\n");
            if (error) {
                reject(error);
            } else {
                resolve(value);
            }
        }

        function onKeypress(character: string | undefined, key: readline.Key): void {
            if (key.ctrl && key.name === "c") {
                finish(new Error("Password reset cancelled"));
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                finish();
                return;
            }
            if (key.name === "backspace") {
                value = [...value].slice(0, -1).join("");
                return;
            }
            if (character && !key.ctrl && !key.meta && value.length < 256) {
                value += character;
            }
        }

        process.stdin.on("keypress", onKeypress);
    });
}

function validatePassword(password: string): void {
    if (password.length < 8 || password.length > 256) {
        throw new TypeError("Password must be 8-256 characters");
    }
}

async function resetPassword(arguments_: ResetArguments): Promise<void> {
    const user = database
        .prepare(
            `SELECT id, username
             FROM users
             WHERE lower(username) = lower(?)`
        )
        .get(arguments_.username) as UserIdentity | undefined;
    if (!user) {
        throw new Error("Dashboard user not found");
    }

    const password = await readSecret("New Dashboard password: ");
    validatePassword(password);
    const confirmation = await readSecret("Confirm new password: ");
    if (password !== confirmation) {
        throw new Error("Passwords do not match");
    }
    const passwordHash = await hashPassword(password);
    const timestamp = new Date().toISOString();

    database.run("BEGIN IMMEDIATE");
    try {
        const revokedSessions = database
            .prepare("DELETE FROM auth_sessions WHERE user_id = ?")
            .run(user.id).changes;
        database
            .prepare("DELETE FROM auth_pending_logins WHERE user_id = ?")
            .run(user.id);
        database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE user_id = ?")
            .run(user.id);
        clearAuthenticationFailures("login-password", user.username);
        clearAuthenticationFailures("account-password", user.id);
        clearAuthenticationFailures("second-factor", user.id);
        if (arguments_.shouldResetMfa) {
            database
                .prepare("DELETE FROM user_recovery_codes WHERE user_id = ?")
                .run(user.id);
            database
                .prepare("DELETE FROM user_totp_factors WHERE user_id = ?")
                .run(user.id);
            database
                .prepare("DELETE FROM user_webauthn_credentials WHERE user_id = ?")
                .run(user.id);
        }
        database
            .prepare(
                `UPDATE users
                 SET password_hash = ?,
                     mfa_enabled_at = CASE WHEN ? = 1 THEN NULL ELSE mfa_enabled_at END,
                     updated_at = ?
                 WHERE id = ?`
            )
            .run(passwordHash, arguments_.shouldResetMfa ? 1 : 0, timestamp, user.id);
        writeAuditEvent({
            action: "auth.password.reset",
            actor: { id: "host-recovery-cli", type: "system" },
            metadata: {
                mfaReset: arguments_.shouldResetMfa,
                revokedSessions,
            },
            outcome: "succeeded",
            targetId: String(user.id),
            targetType: "user",
        });
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "Password reset and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }

    console.log(
        arguments_.shouldResetMfa
            ? `Password and MFA reset for ${user.username}; all sessions revoked.`
            : `Password reset for ${user.username}; MFA preserved and all sessions revoked.`
    );
}

try {
    const arguments_ = parseArguments(Bun.argv.slice(2));
    if (arguments_) {
        await resetPassword(arguments_);
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : "Password reset failed");
    console.error(usage());
    process.exitCode = 1;
} finally {
    database.close();
}
