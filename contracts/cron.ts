import type { JobDisableIntent } from "./jobs";

export interface CronTaskLink {
    number: number;
    title: string;
}

export interface CronJob {
    delivery?: { mode?: string; [key: string]: unknown };
    disableIntent?: JobDisableIntent;
    enabled?: boolean;
    id?: string;
    jobId?: string;
    name?: string;
    payload?: { kind?: string; [key: string]: unknown };
    schedule?: { kind?: string; [key: string]: unknown };
    sessionTarget?: string;
    state?: Record<string, unknown>;
    taskLinks?: CronTaskLink[];
    [key: string]: unknown;
}

export interface CronJobsResponse {
    jobs: CronJob[];
}

export interface CronMutationResponse {
    isOk: true;
    payload?: unknown;
}
