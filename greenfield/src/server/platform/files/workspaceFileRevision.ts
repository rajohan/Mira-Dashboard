import type Fs from "node:fs";

/**
 * Builds a strong opaque revision shared by descriptor reads and worker-side CAS writes.
 * @param rootId Reviewed root identity.
 * @param segments Descriptor-rooted literal path segments.
 * @param stat Open file identity and metadata.
 * @returns Lowercase SHA-256 revision bound to identity and metadata.
 */
export function workspaceFileRevisionForStat(
    rootId: string,
    segments: readonly string[],
    stat: Fs.BigIntStats
): string {
    return new Bun.CryptoHasher("sha256")
        .update(rootId)
        .update("\0")
        .update(segments.join("\0"))
        .update("\0")
        .update(stat.dev.toString())
        .update(":")
        .update(stat.ino.toString())
        .update(":")
        .update(stat.mode.toString())
        .update(":")
        .update(stat.size.toString())
        .update(":")
        .update(stat.mtimeNs.toString())
        .update(":")
        .update(stat.ctimeNs.toString())
        .digest("hex");
}
