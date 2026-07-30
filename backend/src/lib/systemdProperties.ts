/**
 * Parses the newline-delimited `key=value` format emitted by `systemctl show`.
 * Blank lines are ignored, missing separators produce an empty value, and
 * additional separators remain part of the value.
 * @param output Bounded `systemctl show` output.
 * @returns Parsed systemd properties.
 */
export function parseSystemdProperties(output: string): Map<string, string> {
    return new Map(
        output
            .split("\n")
            .filter(Boolean)
            .map((line): [string, string] => {
                const separator = line.indexOf("=");
                return separator === -1
                    ? [line, ""]
                    : [line.slice(0, separator), line.slice(separator + 1)];
            })
    );
}
