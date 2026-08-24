import { realpath } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { ManagedRuntime } from "effect";
import * as v from "valibot";

import {
    authPasswordInputSchema,
    authPasswordMaximumLength,
    authUsernameInputSchema,
} from "../contracts/auth.ts";
import {
    databaseRuntimeLayer,
    DatabaseRuntimeService,
} from "../server/database/runtime/databaseService.ts";
import { createHostPasswordRecoveryService } from "../server/domains/security/hostPasswordRecovery.ts";
import { createHostPasswordRecoveryRepository } from "../server/domains/security/hostPasswordRecoveryRepository.ts";
import { resolveDashboardProjectLayout } from "../server/platform/filesystem/projectLayout.ts";
import { loadRuntimeRelease } from "../server/platform/release/runtimeRelease.ts";

const dashboardPasswordRecoveryFailureMessage = "Dashboard password recovery failed";
const maximumBufferedSecretCodeUnits = authPasswordMaximumLength * 2;
const passwordRecoveryUsage = [
    "Usage: bun run auth:reset-password -- --username <username> [--reset-mfa]",
    "",
    "The new password is read twice from an interactive TTY and is never",
    "accepted through arguments or environment variables.",
].join("\n");
const passwordGraphemeSegmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
});

/** Strict, secret-free command accepted by the host password-recovery process. */
export interface DashboardPasswordRecoveryCommand {
    readonly projectRoot: string;
    readonly resetMfa: boolean;
    readonly username: string;
}

export type DashboardPasswordRecoveryArguments =
    | Readonly<{ kind: "help" }>
    | Readonly<{
          command: DashboardPasswordRecoveryCommand;
          kind: "reset";
      }>;

/** Prepared database/release scope owned by one command invocation. */
export interface DashboardPasswordRecoveryOperation {
    readonly username: string;
    dispose(): Promise<void>;
    resetPassword(
        password: string,
        resetMfa: boolean
    ): Promise<"reset" | "state-changed">;
}

/** Injectable composition and I/O boundaries used by focused CLI tests. */
export interface DashboardPasswordRecoveryDependencies {
    readonly prepare: (
        command: DashboardPasswordRecoveryCommand
    ) => Promise<DashboardPasswordRecoveryOperation | undefined>;
    readonly readSecret: (prompt: string) => Promise<string>;
    readonly writeOutput: (message: string) => void;
}

/** Minimal terminal surface needed for no-echo password entry. */
export interface PasswordRecoveryTerminal {
    readonly emitKeypressEvents: (input: NodeJS.ReadStream) => void;
    readonly input: NodeJS.ReadStream;
    readonly output: NodeJS.WriteStream;
}

/** Expected operator-facing failure whose text is safe to print. */
export class DashboardPasswordRecoveryInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DashboardPasswordRecoveryInputError";
    }
}

function removeLastGrapheme(value: string): string {
    return [...passwordGraphemeSegmenter.segment(value)]
        .slice(0, -1)
        .map(({ segment }) => segment)
        .join("");
}

function firstValidationMessage(
    issues: readonly Readonly<{ message: string }>[] | undefined
): string {
    return issues?.[0]?.message ?? dashboardPasswordRecoveryFailureMessage;
}

function normalizedProjectRoot(value: string | undefined): string {
    if (
        value === undefined ||
        value.includes("\0") ||
        !path.isAbsolute(value) ||
        value === path.parse(value).root ||
        path.resolve(value) !== value
    ) {
        throw new DashboardPasswordRecoveryInputError(
            "Password recovery command configuration is invalid"
        );
    }
    return value;
}

/**
 * Parses the exact host-only argument shape. Passwords are deliberately absent.
 * The package command injects the fixed project root before operator arguments.
 * @param arguments_ Process arguments after the executable entrypoint.
 * @returns Help or one validated, secret-free reset command.
 */
export function parseDashboardPasswordRecoveryArguments(
    arguments_: readonly string[]
): DashboardPasswordRecoveryArguments {
    if (arguments_.includes("--help") || arguments_.includes("-h")) {
        return Object.freeze({ kind: "help" });
    }

    let projectRoot: string | undefined;
    let resetMfa = false;
    let sawResetMfa = false;
    let username: string | undefined;

    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument?.startsWith("--project-root=")) {
            if (projectRoot !== undefined) {
                throw new DashboardPasswordRecoveryInputError(
                    "--project-root must be provided exactly once"
                );
            }
            projectRoot = argument.slice("--project-root=".length);
            continue;
        }
        if (argument === "--reset-mfa") {
            if (sawResetMfa) {
                throw new DashboardPasswordRecoveryInputError(
                    "--reset-mfa must be provided at most once"
                );
            }
            sawResetMfa = true;
            resetMfa = true;
            continue;
        }
        if (argument === "--username") {
            if (username !== undefined) {
                throw new DashboardPasswordRecoveryInputError(
                    "--username must be provided exactly once"
                );
            }
            const candidate = arguments_[index + 1]?.trim();
            if (!candidate || candidate.startsWith("-")) {
                throw new DashboardPasswordRecoveryInputError(
                    "--username requires a value"
                );
            }
            const parsed = v.safeParse(authUsernameInputSchema, candidate, {
                abortEarly: true,
            });
            if (!parsed.success) {
                throw new DashboardPasswordRecoveryInputError(
                    firstValidationMessage(parsed.issues)
                );
            }
            username = parsed.output;
            index += 1;
            continue;
        }
        throw new DashboardPasswordRecoveryInputError(
            `Unknown argument: ${argument ?? ""}`
        );
    }

    if (username === undefined) {
        throw new DashboardPasswordRecoveryInputError("--username is required");
    }
    return Object.freeze({
        command: Object.freeze({
            projectRoot: normalizedProjectRoot(projectRoot),
            resetMfa,
            username,
        }),
        kind: "reset",
    });
}

/**
 * Reads one bounded secret from an interactive terminal without echoing it.
 * @param prompt Operator-facing prompt written before key input.
 * @param terminal Exact no-echo terminal boundary.
 * @returns Secret captured from the terminal.
 */
export async function readPasswordRecoverySecret(
    prompt: string,
    terminal: PasswordRecoveryTerminal
): Promise<string> {
    const { input, output } = terminal;
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
        throw new DashboardPasswordRecoveryInputError(
            "Password recovery requires an interactive TTY"
        );
    }

    terminal.emitKeypressEvents(input);
    let value = "";
    let overflowed = false;
    let rawModeEnabled = false;

    return new Promise<string>((resolve, reject) => {
        let finished = false;

        const finish = (error?: Error): void => {
            if (finished) return;
            finished = true;
            input.off("keypress", onKeypress);
            let cleanupError: Error | undefined;
            try {
                if (rawModeEnabled) input.setRawMode(false);
                input.pause();
                output.write("\n");
            } catch {
                cleanupError = new DashboardPasswordRecoveryInputError(
                    "Password recovery terminal could not be restored"
                );
            }
            if (error !== undefined) reject(error);
            else if (cleanupError === undefined) resolve(value);
            else reject(cleanupError);
        };

        const onKeypress = (character: string | undefined, key: readline.Key): void => {
            if (key.ctrl && key.name === "c") {
                finish(
                    new DashboardPasswordRecoveryInputError("Password recovery cancelled")
                );
                return;
            }
            if (key.name === "return" || key.name === "enter") {
                finish(
                    overflowed
                        ? new DashboardPasswordRecoveryInputError(
                              "Password must contain 8–256 characters."
                          )
                        : undefined
                );
                return;
            }
            if (key.name === "backspace") {
                value = removeLastGrapheme(value);
                return;
            }
            if (character && !key.ctrl && !key.meta) {
                if (value.length + character.length > maximumBufferedSecretCodeUnits) {
                    overflowed = true;
                    return;
                }
                value += character;
            }
        };

        try {
            input.on("keypress", onKeypress);
            input.setRawMode(true);
            rawModeEnabled = true;
            input.resume();
            output.write(prompt);
        } catch {
            finish(
                new DashboardPasswordRecoveryInputError(
                    "Password recovery terminal could not be initialized"
                )
            );
        }
    });
}

function validatedPassword(password: string): string {
    const parsed = v.safeParse(authPasswordInputSchema, password, {
        abortEarly: true,
    });
    if (!parsed.success) {
        throw new DashboardPasswordRecoveryInputError(
            firstValidationMessage(parsed.issues)
        );
    }
    return parsed.output;
}

/**
 * Executes help or one complete password reset while always closing its DB scope.
 * @param arguments_ Process arguments after the executable entrypoint.
 * @param dependencies Release/database and terminal boundaries.
 * @returns Completion after help or a committed reset.
 */
export async function runDashboardPasswordRecoveryCli(
    arguments_: readonly string[],
    dependencies: DashboardPasswordRecoveryDependencies
): Promise<void> {
    const parsed = parseDashboardPasswordRecoveryArguments(arguments_);
    if (parsed.kind === "help") {
        dependencies.writeOutput(passwordRecoveryUsage);
        return;
    }

    const operation = await dependencies.prepare(parsed.command);
    if (operation === undefined) {
        throw new DashboardPasswordRecoveryInputError(
            "Dashboard user not found or unavailable"
        );
    }

    let failure: unknown;
    let reset = false;
    try {
        const password = validatedPassword(
            await dependencies.readSecret("New Dashboard password: ")
        );
        const confirmation = await dependencies.readSecret("Confirm new password: ");
        if (password !== confirmation) {
            throw new DashboardPasswordRecoveryInputError("Passwords do not match");
        }
        const status = await operation.resetPassword(password, parsed.command.resetMfa);
        if (status === "state-changed") {
            throw new DashboardPasswordRecoveryInputError(
                "Dashboard user changed during password recovery; try again"
            );
        }
        reset = true;
    } catch (error) {
        failure = error;
    }

    try {
        await operation.dispose();
    } catch (error) {
        failure ??= error;
    }
    if (failure !== undefined) {
        throw failure instanceof Error
            ? failure
            : new Error(dashboardPasswordRecoveryFailureMessage, { cause: failure });
    }
    if (!reset) throw new Error(dashboardPasswordRecoveryFailureMessage);

    dependencies.writeOutput(
        parsed.command.resetMfa
            ? `Password and MFA reset for ${operation.username}; all sessions revoked.`
            : `Password reset for ${operation.username}; MFA preserved and all sessions revoked.`
    );
}

async function preparePasswordRecoveryOperation(
    command: DashboardPasswordRecoveryCommand
): Promise<DashboardPasswordRecoveryOperation | undefined> {
    const layout = await resolveDashboardProjectLayout(command.projectRoot);
    const releaseRoot = await realpath(path.resolve(import.meta.dir, ".."));
    const activeReleaseRoot = await realpath(
        path.join(layout.production.releases, "current")
    );
    if (releaseRoot !== activeReleaseRoot) {
        throw new Error(dashboardPasswordRecoveryFailureMessage);
    }
    const release = await loadRuntimeRelease(
        layout.production.releases,
        releaseRoot,
        "web"
    );
    const runtime = ManagedRuntime.make(
        databaseRuntimeLayer({
            migrationsDirectory: path.join(releaseRoot, "migrations"),
            releaseId: release.manifest.source.commitSha,
            startupMode: "validate-only",
            stateDirectory: layout.production.state.root,
        })
    );

    try {
        await runtime.context();
        const database = await runtime.runPromise(DatabaseRuntimeService);
        const repository = createHostPasswordRecoveryRepository(database.orm, {
            run: (operation) => runtime.runPromise(database.runImmediateWrite(operation)),
        });
        const service = createHostPasswordRecoveryService({ repository });
        const prepared = service.prepare(command.username);
        if (prepared === undefined) {
            await runtime.dispose();
            return undefined;
        }
        let disposed = false;
        return Object.freeze({
            dispose() {
                if (!disposed) {
                    disposed = true;
                    return runtime.dispose();
                }
                return Promise.resolve();
            },
            async resetPassword(password: string, resetMfa: boolean) {
                const result = await prepared.resetPassword({ password, resetMfa });
                return result.status;
            },
            username: prepared.username,
        });
    } catch (error) {
        try {
            await runtime.dispose();
        } catch {
            // Preserve the initiating recovery failure.
        }
        throw error;
    }
}

const defaultDependencies = Object.freeze({
    prepare: preparePasswordRecoveryOperation,
    readSecret: (prompt: string) =>
        readPasswordRecoverySecret(prompt, {
            emitKeypressEvents: (input) => readline.emitKeypressEvents(input),
            input: process.stdin,
            output: process.stdout,
        }),
    writeOutput: (message: string) => process.stdout.write(`${message}\n`),
} satisfies DashboardPasswordRecoveryDependencies);

function printableFailure(error: unknown): string {
    return error instanceof DashboardPasswordRecoveryInputError
        ? error.message
        : dashboardPasswordRecoveryFailureMessage;
}

if (import.meta.main) {
    try {
        await runDashboardPasswordRecoveryCli(Bun.argv.slice(2), defaultDependencies);
    } catch (error) {
        process.stderr.write(`${printableFailure(error)}\n${passwordRecoveryUsage}\n`);
        process.exitCode = 1;
    }
}
