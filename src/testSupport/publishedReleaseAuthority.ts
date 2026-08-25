import type { PublishedReleaseAuthority } from "../shared/publishedReleaseAuthority.ts";

/**
 * Builds one complete public release authority for Delivery fixtures.
 * @param releaseId Exact published commit.
 * @param tagName Semantic GitHub release tag.
 * @param runtimeRevision Exact Bun runtime revision.
 * @returns Complete digest-bound public authority.
 */
export function publishedReleaseAuthority(
    releaseId: string,
    tagName = "v1.2.3",
    runtimeRevision = "b".repeat(40)
): PublishedReleaseAuthority {
    const assets: PublishedReleaseAuthority["assets"] = [
        {
            digest: `sha256:${"c".repeat(64)}`,
            name: "receipt.json",
            size: 512,
        },
        {
            digest: `sha256:${"d".repeat(64)}`,
            name: "release.tar",
            size: 4096,
        },
    ];
    return Object.freeze({
        assets,
        releaseId,
        releaseManifestSha256: "e".repeat(64),
        runtime: { revision: runtimeRevision, version: "1.4.0" },
        tagName,
    });
}
