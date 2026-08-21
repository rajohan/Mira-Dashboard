/** One reviewed child process in a repository command plan. */
export interface CommandProcess {
    readonly arguments: readonly string[];
    readonly environment?: Readonly<Record<string, string>>;
    readonly name: string;
}

/**
 * Runs one command with inherited output and no shell interpretation.
 * @param command Exact executable and arguments.
 * @param options Repository root and optional environment.
 * @returns Child exit code.
 */
export async function runCommandProcess(
    command: CommandProcess,
    options: Readonly<{
        cwd: string;
        environment?: Readonly<Record<string, string | undefined>>;
    }>
): Promise<number> {
    const child = Bun.spawn([...command.arguments], {
        cwd: options.cwd,
        env: {
            ...options.environment,
            ...command.environment,
        },
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
    });
    return child.exited;
}

/**
 * Runs independent commands concurrently and returns the first non-zero result.
 * @param commands Exact independent child plans.
 * @param options Repository root and optional environment.
 * @returns First non-zero exit code or zero.
 */
export async function runCommandProcesses(
    commands: readonly CommandProcess[],
    options: Readonly<{
        cwd: string;
        environment?: Readonly<Record<string, string | undefined>>;
    }>
): Promise<number> {
    const results = await Promise.all(
        commands.map((command) => runCommandProcess(command, options))
    );
    return results.find((result) => result !== 0) ?? 0;
}
