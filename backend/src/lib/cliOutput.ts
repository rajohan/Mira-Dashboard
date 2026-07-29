/**
 * Writes command output without observability metadata. CLI output is a public
 * command contract, while runtime diagnostics belong in structured logs.
 * @param value Value to process.
 */
export function writeCliOutput(value: string): void {
    process.stdout.write(`${value}\n`);
}

/**
 * Writes a command failure intended for the invoking terminal or process.
 * @param value Value to process.
 */
export function writeCliError(value: string): void {
    process.stderr.write(`${value}\n`);
}

/**
 * Writes an interactive prompt without appending a newline.
 * @param value Value to process.
 */
export function writeCliPrompt(value: string): void {
    process.stdout.write(value);
}
