export interface DockerUpdaterStepResult {
    kind?: "git-sync" | "update";
    step: string;
    isOk: boolean;
    stdout: string;
    stderr: string;
    changedPaths?: string[];
    code?: "NOT_FOUND" | "DISABLED" | "CONFLICT" | "UNSUPPORTED_REGISTRY";
}

export interface ManagedServiceRow {
    id: number;
    app_slug: string;
    service_name: string;
    compose_path: string;
    image_repo: string;
    compose_image_ref: string | undefined;
    compose_image_field: string | undefined;
    current_tag: string | undefined;
    current_digest: string | undefined;
    latest_tag: string | undefined;
    latest_digest: string | undefined;
    policy: string;
    pin_mode: string;
    tag_match_type: string;
    tag_match_pattern: string | undefined;
    enabled: number;
    metadata_json: string | undefined;
    last_status: string | undefined;
}

export function normalizeManagedServiceRow(
    row: ManagedServiceRow | undefined
): ManagedServiceRow | undefined {
    if (!row) return undefined;
    return {
        ...row,
        compose_image_field: row.compose_image_field ?? undefined,
        compose_image_ref: row.compose_image_ref ?? undefined,
        current_digest: row.current_digest ?? undefined,
        current_tag: row.current_tag ?? undefined,
        last_status: row.last_status ?? undefined,
        latest_digest: row.latest_digest ?? undefined,
        latest_tag: row.latest_tag ?? undefined,
        metadata_json: row.metadata_json ?? undefined,
        tag_match_pattern: row.tag_match_pattern ?? undefined,
    };
}

export function normalizeManagedServiceRows(
    rows: ManagedServiceRow[]
): ManagedServiceRow[] {
    return rows.map((row) => normalizeManagedServiceRow(row)!);
}

export type JsonRecord = Record<string, unknown>;

export interface DiscoveredComposeService {
    appSlug: string;
    serviceName: string;
    composePath: string;
    imageRepo: string;
    composeImageRef: string;
    composeImageField: string;
    currentTag: string | undefined;
    currentDigest: string | undefined;
    policy: "auto" | "notify";
    pinMode: "tag" | "digest";
    tagMatchType: "exact" | "regex";
    tagMatchPattern: string | undefined;
    enabled: boolean;
    metadata: Record<string, unknown>;
}

export interface RegistryFetchOptions {
    accept?: string;
    authorization?: string;
    signal?: AbortSignal;
}

export interface RegistryCredentials {
    password: string;
    username: string;
}
