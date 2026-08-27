/**
 * Formats the last-resort process startup diagnostic written before logging is available.
 * @param processRole Stable process identity included in the diagnostic.
 * @param now Timestamp captured at the failure boundary.
 * @returns One newline-terminated timestamped diagnostic line.
 */
export function formatStartupFailure(
    processRole: "web" | "worker",
    now: Date = new Date()
): string {
    const message =
        processRole === "web"
            ? "Mira Dashboard web startup failed"
            : "Mira Dashboard worker startup failed";
    return `${now.toISOString()} ${message}\n`;
}
