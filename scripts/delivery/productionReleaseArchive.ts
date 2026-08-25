import {
    maximumReleaseArtifactCount,
    maximumReleaseArtifactDirectoryCount,
} from "./releaseArtifactInventory.ts";

const invalidArchiveMessage = "Production release archive is invalid";
const maximumProductionReleaseArchiveEntries =
    maximumReleaseArtifactCount + maximumReleaseArtifactDirectoryCount;

/**
 * Rejects archive paths outside the single commit-addressed release directory.
 * @param listing Newline-delimited `tar -tf` output.
 * @param releaseId Exact release commit.
 */
export function assertProductionReleaseArchiveListing(
    listing: string,
    releaseId: string
): void {
    const entries = listing.split("\n").filter(Boolean);
    if (
        !/^[a-f\d]{40}$/u.test(releaseId) ||
        entries.length === 0 ||
        entries.length > maximumProductionReleaseArchiveEntries ||
        entries.some(
            (entry) =>
                !(entry === `${releaseId}/` || entry.startsWith(`${releaseId}/`)) ||
                entry.split("/").includes("..")
        )
    ) {
        throw new Error(invalidArchiveMessage);
    }
}
