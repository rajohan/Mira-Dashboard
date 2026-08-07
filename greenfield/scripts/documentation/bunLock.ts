import JSON5 from "json5";
import * as v from "valibot";

const packageNameSchema = v.string();
const packageResolutionSchema = v.tupleWithRest([v.string()], v.unknown());
const packageRecordSchema = v.record(packageNameSchema, packageResolutionSchema);
const bunLockSchema = v.object({ packages: packageRecordSchema });

function resolutionVersion(name: string, resolution: string): string {
    const prefix = `${name}@`;
    if (!resolution.startsWith(prefix) || resolution.length === prefix.length) {
        throw new Error(`Unexpected Bun lockfile resolution for ${name}: ${resolution}`);
    }
    return resolution.slice(prefix.length);
}

/**
 * Resolves every declared direct package to its exact Bun lockfile version.
 * @param packageGroups Direct dependency maps from package.json.
 * @param lockfileText Tracked bun.lock source.
 * @returns Exact version by direct package name.
 */
export function resolveDirectPackageVersions(
    packageGroups: readonly Readonly<Record<string, string>>[],
    lockfileText: string
): Readonly<Record<string, string>> {
    const lockfileValue: unknown = JSON5.parse(lockfileText);
    const lockfile = v.parse(bunLockSchema, lockfileValue);
    const packageNames = new Set(packageGroups.flatMap((group) => Object.keys(group)));
    const resolvedVersions: Record<string, string> = {};

    for (const name of packageNames) {
        const packageEntry = lockfile.packages[name];
        if (!packageEntry) {
            throw new Error(`Direct package is missing from the Bun lockfile: ${name}`);
        }
        resolvedVersions[name] = resolutionVersion(name, packageEntry[0]);
    }

    return resolvedVersions;
}
