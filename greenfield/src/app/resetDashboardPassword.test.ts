import { describe, expect, test } from "bun:test";
import type readline from "node:readline";

import { rejectionError } from "../../scripts/testSupport/rejection.ts";
import {
    type DashboardPasswordRecoveryCommand,
    type DashboardPasswordRecoveryDependencies,
    DashboardPasswordRecoveryInputError,
    type DashboardPasswordRecoveryOperation,
    parseDashboardPasswordRecoveryArguments,
    type PasswordRecoveryTerminal,
    readPasswordRecoverySecret,
    runDashboardPasswordRecoveryCli,
} from "./resetDashboardPassword.ts";

const projectRoot = "/srv/mira-dashboard";
const commandArguments = Object.freeze([
    `--project-root=${projectRoot}`,
    "--username",
    "Raymond.Operator",
]);

function operation(
    resetPassword: DashboardPasswordRecoveryOperation["resetPassword"] = () =>
        Promise.resolve("reset"),
    lifecycle?: string[],
    disposeOperation: () => Promise<void> = () => Promise.resolve()
): DashboardPasswordRecoveryOperation & { readonly disposals: string[] } {
    const disposals: string[] = [];
    return Object.freeze({
        disposals,
        dispose() {
            disposals.push("disposed");
            lifecycle?.push("dispose");
            return disposeOperation();
        },
        resetPassword,
        username: "Raymond.Operator",
    });
}

function dependencies(
    prepared: DashboardPasswordRecoveryOperation | undefined,
    secrets: readonly string[] = ["correct horse", "correct horse"],
    lifecycle?: string[]
): DashboardPasswordRecoveryDependencies & {
    readonly outputs: string[];
    readonly prepares: DashboardPasswordRecoveryCommand[];
    readonly prompts: string[];
} {
    const outputs: string[] = [];
    const prepares: DashboardPasswordRecoveryCommand[] = [];
    const prompts: string[] = [];
    let secretIndex = 0;
    return Object.freeze({
        outputs,
        prepare(command: DashboardPasswordRecoveryCommand) {
            prepares.push(command);
            return Promise.resolve(prepared);
        },
        prepares,
        prompts,
        readSecret(prompt: string) {
            prompts.push(prompt);
            return Promise.resolve(secrets[secretIndex++] ?? "");
        },
        writeOutput(message: string) {
            outputs.push(message);
            lifecycle?.push(`output:${message}`);
        },
    });
}

function key(name: string, overrides: Partial<readline.Key> = {}): readline.Key {
    return {
        ctrl: false,
        meta: false,
        name,
        sequence: "",
        shift: false,
        ...overrides,
    };
}

function rejectedError(error: Error): Promise<never> {
    return Promise.reject(error);
}

function rejectWithNonError(reason: unknown): Promise<never> {
    return rejectedError(reason as Error);
}

type KeypressListener = (
    character: string | undefined,
    observedKey: readline.Key
) => void;

class FakeKeypressInput {
    readonly listeners = new Set<KeypressListener>();

    emit(character: string | undefined, observedKey: readline.Key): void {
        for (const listener of this.listeners) listener(character, observedKey);
    }

    off(event: string, listener: KeypressListener): this {
        if (event === "keypress") this.listeners.delete(listener);
        return this;
    }

    on(event: string, listener: KeypressListener): this {
        if (event === "keypress") this.listeners.add(listener);
        return this;
    }
}

function terminal(
    isTty = true,
    rawModeFailure?: "initialization" | "restoration"
): PasswordRecoveryTerminal & {
    readonly inputEvents: FakeKeypressInput;
    readonly rawModes: boolean[];
    readonly writes: string[];
} {
    const inputEvents = new FakeKeypressInput();
    const rawModes: boolean[] = [];
    const writes: string[] = [];
    const input = Object.assign(inputEvents, {
        isTTY: isTty,
        pause() {
            return input;
        },
        resume() {
            return input;
        },
        setRawMode(enabled: boolean) {
            rawModes.push(enabled);
            if (
                (enabled && rawModeFailure === "initialization") ||
                (!enabled && rawModeFailure === "restoration")
            ) {
                throw new Error(`simulated terminal ${rawModeFailure} failure`);
            }
            return input;
        },
    }) as unknown as NodeJS.ReadStream;
    const output = {
        isTTY: isTty,
        write(value: string) {
            writes.push(value);
            return true;
        },
    } as unknown as NodeJS.WriteStream;
    return Object.freeze({
        emitKeypressEvents() {},
        input,
        inputEvents,
        output,
        rawModes,
        writes,
    });
}

describe("host password recovery arguments", () => {
    test("parses one exact secret-free command and normalizes the username", () => {
        expect(parseDashboardPasswordRecoveryArguments(commandArguments)).toEqual({
            command: {
                projectRoot,
                resetMfa: false,
                username: "raymond.operator",
            },
            kind: "reset",
        });
        expect(
            parseDashboardPasswordRecoveryArguments([...commandArguments, "--reset-mfa"])
        ).toEqual({
            command: {
                projectRoot,
                resetMfa: true,
                username: "raymond.operator",
            },
            kind: "reset",
        });
    });

    test("lets help win without accepting a password argument", () => {
        expect(
            parseDashboardPasswordRecoveryArguments([
                "--password",
                "must-never-be-read",
                "--help",
            ])
        ).toEqual({ kind: "help" });
        expect(() =>
            parseDashboardPasswordRecoveryArguments([
                ...commandArguments,
                "--password",
                "must-never-be-read",
            ])
        ).toThrow("Unknown argument: --password");
    });

    test("rejects duplicate project-root, reset-MFA and username arguments", () => {
        expect(() =>
            parseDashboardPasswordRecoveryArguments([
                ...commandArguments,
                `--project-root=${projectRoot}`,
            ])
        ).toThrow("--project-root must be provided exactly once");
        expect(() =>
            parseDashboardPasswordRecoveryArguments([
                ...commandArguments,
                "--reset-mfa",
                "--reset-mfa",
            ])
        ).toThrow("--reset-mfa must be provided at most once");
        expect(() =>
            parseDashboardPasswordRecoveryArguments([
                ...commandArguments,
                "--username",
                "another-user",
            ])
        ).toThrow("--username must be provided exactly once");
    });

    test("requires one valid username value", () => {
        expect(() =>
            parseDashboardPasswordRecoveryArguments([`--project-root=${projectRoot}`])
        ).toThrow("--username is required");
        expect(() =>
            parseDashboardPasswordRecoveryArguments([
                "--username",
                `--project-root=${projectRoot}`,
            ])
        ).toThrow("--username requires a value");
        expect(() =>
            parseDashboardPasswordRecoveryArguments([
                `--project-root=${projectRoot}`,
                "--username",
                "   ",
            ])
        ).toThrow("--username requires a value");
        expect(() =>
            parseDashboardPasswordRecoveryArguments([
                `--project-root=${projectRoot}`,
                "--username",
                "--reset-mfa",
            ])
        ).toThrow("--username requires a value");
        expect(() =>
            parseDashboardPasswordRecoveryArguments([
                `--project-root=${projectRoot}`,
                "--username",
                "ab",
            ])
        ).toThrow(
            "Use 3–32 letters, numbers, periods, underscores, or hyphens. Start with a letter or number."
        );
    });

    test("rejects missing, unsafe and non-normalized project roots", () => {
        const invalidArguments = [
            ["--username", "operator"],
            [`--project-root=${projectRoot}\0nested`, "--username", "operator"],
            ["--project-root=/", "--username", "operator"],
            [`--project-root=${projectRoot}/../mira-dashboard`, "--username", "operator"],
            ["--project-root=relative", "--username", "operator"],
        ];

        for (const arguments_ of invalidArguments) {
            expect(() => parseDashboardPasswordRecoveryArguments(arguments_)).toThrow(
                "Password recovery command configuration is invalid"
            );
        }
    });
});

describe("host password recovery terminal", () => {
    test("captures graphemes without echo and always restores raw mode", async () => {
        const observed = terminal();
        const secret = readPasswordRecoverySecret("New password: ", observed);

        observed.inputEvents.emit("👩‍💻", key("text"));
        observed.inputEvents.emit(undefined, key("backspace"));
        observed.inputEvents.emit("correct horse", key("text"));
        observed.inputEvents.emit(undefined, key("enter"));

        expect(await secret).toBe("correct horse");
        expect(observed.rawModes).toEqual([true, false]);
        expect(observed.writes).toEqual(["New password: ", "\n"]);
        expect(observed.writes.join("")).not.toContain("correct horse");
    });

    test("cancels safely and rejects non-interactive execution", async () => {
        const observed = terminal();
        const secret = readPasswordRecoverySecret("Password: ", observed);
        observed.inputEvents.emit("\u0003", key("c", { ctrl: true }));

        expect(await rejectionError(secret)).toEqual(
            new DashboardPasswordRecoveryInputError("Password recovery cancelled")
        );
        expect(observed.rawModes).toEqual([true, false]);
        expect(
            await rejectionError(
                readPasswordRecoverySecret("Password: ", terminal(false))
            )
        ).toEqual(
            new DashboardPasswordRecoveryInputError(
                "Password recovery requires an interactive TTY"
            )
        );
    });

    test("rejects oversized pasted secrets instead of silently truncating", async () => {
        const observed = terminal();
        const secret = readPasswordRecoverySecret("Password: ", observed);
        observed.inputEvents.emit("x".repeat(513), key("text"));
        observed.inputEvents.emit(undefined, key("enter"));

        expect(await rejectionError(secret)).toEqual(
            new DashboardPasswordRecoveryInputError(
                "Password must contain 8–256 characters."
            )
        );
        expect(observed.rawModes).toEqual([true, false]);
    });

    test("reports terminal initialization and restoration failures", async () => {
        const initializationFailure = terminal(true, "initialization");
        expect(
            await rejectionError(
                readPasswordRecoverySecret("Password: ", initializationFailure)
            )
        ).toEqual(
            new DashboardPasswordRecoveryInputError(
                "Password recovery terminal could not be initialized"
            )
        );
        expect(initializationFailure.inputEvents.listeners.size).toBe(0);
        expect(initializationFailure.rawModes).toEqual([true]);
        expect(initializationFailure.writes).toEqual(["\n"]);

        const restorationFailure = terminal(true, "restoration");
        const secret = readPasswordRecoverySecret("Password: ", restorationFailure);
        restorationFailure.inputEvents.emit(undefined, key("enter"));

        expect(await rejectionError(secret)).toEqual(
            new DashboardPasswordRecoveryInputError(
                "Password recovery terminal could not be restored"
            )
        );
        expect(restorationFailure.inputEvents.listeners.size).toBe(0);
        expect(restorationFailure.rawModes).toEqual([true, false]);
        expect(restorationFailure.writes).toEqual(["Password: "]);
    });
});

describe("host password recovery CLI lifecycle", () => {
    test("prints help without opening the database or reading a secret", async () => {
        const observed = dependencies(undefined);
        await runDashboardPasswordRecoveryCli(["--help"], observed);

        expect(observed.prepares).toEqual([]);
        expect(observed.prompts).toEqual([]);
        expect(observed.outputs).toHaveLength(1);
        expect(observed.outputs[0]).toContain("auth:reset-password");
    });

    test("rejects an unknown user before the first password prompt", async () => {
        const observed = dependencies(undefined);
        const failure = await rejectionError(
            runDashboardPasswordRecoveryCli(commandArguments, observed)
        );

        expect(failure).toEqual(
            new DashboardPasswordRecoveryInputError(
                "Dashboard user not found or unavailable"
            )
        );
        expect(observed.prompts).toEqual([]);
        expect(observed.outputs).toEqual([]);
    });

    test("validates and confirms before committing, then disposes before success", async () => {
        const events: string[] = [];
        const prepared = operation((password, resetMfa) => {
            events.push(`reset:${password}:${resetMfa}`);
            return Promise.resolve("reset");
        }, events);
        const observed = dependencies(
            prepared,
            ["correct horse", "correct horse"],
            events
        );

        await runDashboardPasswordRecoveryCli(commandArguments, observed);

        expect(observed.prompts).toEqual([
            "New Dashboard password: ",
            "Confirm new password: ",
        ]);
        expect(prepared.disposals).toEqual(["disposed"]);
        expect(events).toEqual([
            "reset:correct horse:false",
            "dispose",
            "output:Password reset for Raymond.Operator; MFA preserved and all sessions revoked.",
        ]);
        expect(observed.outputs.join("\n")).not.toContain("correct horse");
    });

    test("rejects an invalid first password before confirmation or reset", async () => {
        let resetCalls = 0;
        const prepared = operation(() => {
            resetCalls += 1;
            return Promise.resolve("reset");
        });
        const observed = dependencies(prepared, ["short"]);

        expect(
            await rejectionError(
                runDashboardPasswordRecoveryCli(commandArguments, observed)
            )
        ).toEqual(
            new DashboardPasswordRecoveryInputError(
                "Password must contain 8–256 characters."
            )
        );
        expect(observed.prompts).toEqual(["New Dashboard password: "]);
        expect(resetCalls).toBe(0);
        expect(prepared.disposals).toEqual(["disposed"]);
        expect(observed.outputs).toEqual([]);
    });

    test("rejects mismatch and concurrent account changes without success output", async () => {
        const mismatchedOperation = operation();
        const mismatch = dependencies(mismatchedOperation, [
            "correct horse",
            "wrong horse",
        ]);
        expect(
            await rejectionError(
                runDashboardPasswordRecoveryCli(commandArguments, mismatch)
            )
        ).toEqual(new DashboardPasswordRecoveryInputError("Passwords do not match"));
        expect(mismatchedOperation.disposals).toEqual(["disposed"]);
        expect(mismatch.outputs).toEqual([]);

        const changedOperation = operation(() => Promise.resolve("state-changed"));
        const changed = dependencies(changedOperation);
        expect(
            await rejectionError(
                runDashboardPasswordRecoveryCli(commandArguments, changed)
            )
        ).toEqual(
            new DashboardPasswordRecoveryInputError(
                "Dashboard user changed during password recovery; try again"
            )
        );
        expect(changedOperation.disposals).toEqual(["disposed"]);
        expect(changed.outputs).toEqual([]);
    });

    test("wraps a non-Error secret-read failure and preserves it over disposal", async () => {
        const readFailure = Object.freeze({ stage: "readSecret" });
        const disposeFailure = Object.freeze({ stage: "dispose" });
        const prepared = operation(undefined, undefined, () =>
            rejectWithNonError(disposeFailure)
        );
        const defaults = dependencies(prepared);
        const observed: DashboardPasswordRecoveryDependencies = {
            ...defaults,
            readSecret: () => rejectWithNonError(readFailure),
        };

        const failure = await rejectionError(
            runDashboardPasswordRecoveryCli(commandArguments, observed)
        );
        expect(failure.message).toBe("Dashboard password recovery failed");
        expect(failure.cause).toBe(readFailure);
        expect(prepared.disposals).toEqual(["disposed"]);
        expect(defaults.outputs).toEqual([]);
    });

    test("wraps a non-Error reset failure after confirmation", async () => {
        const resetFailure = Object.freeze({ stage: "resetPassword" });
        const prepared = operation(() => rejectWithNonError(resetFailure));
        const observed = dependencies(prepared);

        const failure = await rejectionError(
            runDashboardPasswordRecoveryCli(commandArguments, observed)
        );
        expect(failure.message).toBe("Dashboard password recovery failed");
        expect(failure.cause).toBe(resetFailure);
        expect(observed.prompts).toEqual([
            "New Dashboard password: ",
            "Confirm new password: ",
        ]);
        expect(prepared.disposals).toEqual(["disposed"]);
        expect(observed.outputs).toEqual([]);
    });

    test("wraps a non-Error disposal failure after a committed reset", async () => {
        const disposeFailure = Object.freeze({ stage: "dispose" });
        const prepared = operation(undefined, undefined, () =>
            rejectWithNonError(disposeFailure)
        );
        const observed = dependencies(prepared);

        const failure = await rejectionError(
            runDashboardPasswordRecoveryCli(commandArguments, observed)
        );
        expect(failure.message).toBe("Dashboard password recovery failed");
        expect(failure.cause).toBe(disposeFailure);
        expect(prepared.disposals).toEqual(["disposed"]);
        expect(observed.outputs).toEqual([]);
    });

    test("reports a successful password and MFA reset", async () => {
        const resetMfaValues: boolean[] = [];
        const prepared = operation((_, resetMfa) => {
            resetMfaValues.push(resetMfa);
            return Promise.resolve("reset");
        });
        const observed = dependencies(prepared);

        await runDashboardPasswordRecoveryCli(
            [...commandArguments, "--reset-mfa"],
            observed
        );

        expect(resetMfaValues).toEqual([true]);
        expect(prepared.disposals).toEqual(["disposed"]);
        expect(observed.outputs).toEqual([
            "Password and MFA reset for Raymond.Operator; all sessions revoked.",
        ]);
    });
});
