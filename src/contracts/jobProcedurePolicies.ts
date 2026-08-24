/** Shared authenticated read policy for durable jobs and schedules. */
export const jobReadAccess = {
    capabilities: ["jobs:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
} as const;

/** Shared browser-session mutation policy for durable jobs and schedules. */
export const jobSessionWriteAccess = {
    capabilities: ["jobs:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;

/** Shared transport policy for durable job-domain queries. */
export const jobQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;

/** Shared transport policy for durable job-domain mutations. */
export const jobMutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;
