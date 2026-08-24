/**
 * Creates runtime policy from a version read at a composition boundary.
 * @param version Version selected from `.bun-version` or observed from the runtime.
 * @returns Immutable channel and API-baseline policy.
 */
export function createBunRuntimePolicy(
    version: string
): Readonly<{ channel: string; version: string }> {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
        throw new Error("Repository Bun version is invalid");
    }
    return Object.freeze({ channel: version, version });
}
