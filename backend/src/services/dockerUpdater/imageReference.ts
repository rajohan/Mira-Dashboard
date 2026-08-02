import { asRecord, parseImageReference } from "./support.ts";
import type { JsonRecord, ManagedServiceRow } from "./types.ts";

export function imageRegistry(repo: string): string {
    const first = repo.split("/", 1)[0] || "";
    const registry =
        first === "localhost" || first.includes(".") || first.includes(":")
            ? first
            : "docker.io";
    return registry === "index.docker.io" ? "docker.io" : registry;
}

function hostDockerPlatform(): string {
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    return `linux/${arch}`;
}

export function servicePlatform(service: ManagedServiceRow): string {
    let metadata: JsonRecord;
    try {
        metadata = asRecord(
            service.metadata_json ? JSON.parse(service.metadata_json) : {}
        );
    } catch {
        metadata = {};
    }
    return typeof metadata.platform === "string" && metadata.platform
        ? metadata.platform
        : hostDockerPlatform();
}

export function buildTargetImageReference(service: ManagedServiceRow): string {
    const parsed = parseImageReference(service.compose_image_ref || service.image_repo);
    if (service.pin_mode === "digest" && service.latest_digest) {
        const tag = service.latest_tag || parsed.tag;
        return tag
            ? `${parsed.repo}:${tag}@${service.latest_digest}`
            : `${parsed.repo}@${service.latest_digest}`;
    }
    return `${parsed.repo}:${service.latest_tag || service.current_tag || "latest"}`;
}
