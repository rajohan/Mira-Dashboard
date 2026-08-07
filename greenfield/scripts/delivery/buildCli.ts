import path from "node:path";

import * as v from "valibot";

const invalidBuildArgumentsMessage = "Build arguments are invalid";
const outputArgumentSchema = v.pipe(
    v.string(),
    v.minLength(10),
    v.maxLength(4105),
    v.regex(/^--output=[^\0]+$/u)
);

/**
 * Parses the sole optional delivery-build CLI argument without shell interpretation.
 * @param arguments_ Raw arguments following the script path.
 * @param defaultOutput Canonical script-owned output used by package commands.
 * @returns Normalized absolute output directory.
 */
export function parseBuildOutputArgument(
    arguments_: readonly string[],
    defaultOutput: string
): string {
    if (arguments_.length === 0) return defaultOutput;
    const parsed = v.safeParse(outputArgumentSchema, arguments_[0], {
        abortEarly: true,
    });
    if (arguments_.length !== 1 || !parsed.success) {
        throw new TypeError(invalidBuildArgumentsMessage);
    }
    const output = parsed.output.slice("--output=".length);
    if (!path.isAbsolute(output) || path.resolve(output) !== output) {
        throw new TypeError(invalidBuildArgumentsMessage);
    }
    return output;
}
