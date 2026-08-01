import { errorMessage } from "../../lib/errors.ts";
import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";
import type { JsonRecord, ManagedServiceRow } from "./types.ts";

export function nowIso(): string {
    return new Date().toISOString();
}

export function getDockerBin(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_BIN", "docker");
}

export function parseImageReference(imageReference: string) {
    const digestIndex = imageReference.indexOf("@");
    const beforeDigest =
        digestIndex === -1 ? imageReference : imageReference.slice(0, digestIndex);
    const digest = digestIndex === -1 ? undefined : imageReference.slice(digestIndex + 1);
    const slashIndex = beforeDigest.lastIndexOf("/");
    const colonIndex = beforeDigest.lastIndexOf(":");
    const hasTag = colonIndex > slashIndex;
    return {
        repo: hasTag ? beforeDigest.slice(0, colonIndex) : beforeDigest,
        tag: hasTag ? beforeDigest.slice(colonIndex + 1) : undefined,
        digest,
        pinMode: digest ? "digest" : "tag",
    };
}

export function serviceLabel(
    service: Pick<ManagedServiceRow, "app_slug" | "service_name">
): string {
    return `${service.app_slug}/${service.service_name}`;
}

export function caughtMessage(error: unknown): string {
    return errorMessage(error, "Docker updater operation failed");
}

export function asRecord(value: unknown): JsonRecord {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonRecord)
        : {};
}
