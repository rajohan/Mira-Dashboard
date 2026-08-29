import { constants } from "node:fs";
import { open } from "node:fs/promises";

import * as v from "valibot";

import { deliveryRequestOperationResultSchema } from "../src/contracts/delivery.ts";
import { deliveryJobOperationResultSchema } from "../src/contracts/deliveryWorker.ts";
import { jobRunDetailSchema } from "../src/contracts/jobs.ts";

const origin = "http://127.0.0.1:3100";
const credentialPath =
    "/home/ubuntu/.config/mira-dashboard/automation/delivery-deploy.token";
const maximumResponseBytes = 1024 * 1024;
const pollIntervalMs = 1000;
const deploymentDeadlineMs = 100 * 60 * 1000;

interface TrpcEnvelope {
    readonly result?: { readonly data?: { readonly json?: unknown } };
}

export class ProductionDeployTemporarilyUnavailableError extends Error {}

async function readCredential(): Promise<string> {
    const file = await open(
        credentialPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
        const status = await file.stat();
        if (
            !status.isFile() ||
            (status.mode & 0o777) !== 0o600 ||
            status.size < 97 ||
            status.size > 98 ||
            (typeof process.getuid === "function" && status.uid !== process.getuid())
        ) {
            throw new Error("Production deploy credential is unavailable");
        }
        const token = new TextDecoder("utf-8", { fatal: true })
            .decode(await file.readFile())
            .trim();
        if (!/^[0-9a-f]{32}\.[0-9a-f]{64}$/u.test(token)) {
            throw new Error("Production deploy credential is unavailable");
        }
        return token;
    } finally {
        await file.close();
    }
}

async function request(
    token: string,
    kind: "mutation" | "query",
    procedure: string,
    input: unknown
): Promise<unknown> {
    const envelope = JSON.stringify({ json: input });
    const url = new URL(`/trpc/${procedure}`, origin);
    if (kind === "query") url.searchParams.set("input", envelope);
    const response = await fetch(url, {
        ...(kind === "mutation" ? { body: envelope } : {}),
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(kind === "mutation" ? { "Content-Type": "application/json" } : {}),
            "User-Agent": "mira-dashboard-production-deploy/1.0",
        },
        method: kind === "query" ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
    }).catch(() => {
        throw new ProductionDeployTemporarilyUnavailableError();
    });
    if (response.status === 502 || response.status === 503) {
        throw new ProductionDeployTemporarilyUnavailableError();
    }
    const declared = response.headers.get("content-length");
    if (!response.ok || (declared !== null && Number(declared) > maximumResponseBytes)) {
        throw new Error("Production deploy request failed");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumResponseBytes) {
        throw new Error("Production deploy request failed");
    }
    const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as TrpcEnvelope;
    if (parsed.result?.data === undefined || !("json" in parsed.result.data)) {
        throw new Error("Production deploy request failed");
    }
    return parsed.result.data.json;
}

function terminal(state: string): boolean {
    return ["cancelled", "failed", "succeeded", "timed-out"].includes(state);
}

export interface ProductionDeployClientDependencies {
    readonly nowMs?: () => number;
    readonly readToken?: () => Promise<string>;
    readonly request?: typeof request;
    readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** Queues and waits for the same durable production Delivery job used by the UI. */
export async function queueProductionDeploy(
    dependencies: ProductionDeployClientDependencies = {}
): Promise<void> {
    const nowMs = dependencies.nowMs ?? Date.now;
    const requestDeploy = dependencies.request ?? request;
    const sleep = dependencies.sleep ?? Bun.sleep;
    const token = await (dependencies.readToken ?? readCredential)();
    const deadline = nowMs() + deploymentDeadlineMs;
    const idempotencyKey = Bun.randomUUIDv7().replaceAll("-", "");
    let queued: v.InferOutput<typeof deliveryRequestOperationResultSchema> | undefined;
    while (queued === undefined && nowMs() < deadline) {
        try {
            queued = v.parse(
                deliveryRequestOperationResultSchema,
                await requestDeploy(token, "mutation", "delivery.deployCurrent", {
                    confirmation: "deploy-delivery-main",
                    idempotencyKey,
                })
            );
        } catch (error) {
            if (!(error instanceof ProductionDeployTemporarilyUnavailableError)) {
                throw error;
            }
            await sleep(pollIntervalMs);
        }
    }
    if (queued === undefined) {
        throw new Error("Production deploy job was not queued before its deadline");
    }
    while (nowMs() < deadline) {
        let rawDetail: unknown;
        try {
            rawDetail = await requestDeploy(token, "query", "jobs.getRun", {
                id: queued.jobRunId,
            });
        } catch (error) {
            if (!(error instanceof ProductionDeployTemporarilyUnavailableError)) {
                throw error;
            }
            // The web service is expected to be briefly unavailable during cutover.
            await sleep(pollIntervalMs);
            continue;
        }
        const detail = v.parse(jobRunDetailSchema, rawDetail);
        if (terminal(detail.run.state)) {
            if (detail.run.state === "succeeded") {
                const result = v.parse(deliveryJobOperationResultSchema, detail.result);
                if (
                    result.operation === "deploy" &&
                    (result.outcome === "completed" ||
                        result.outcome === "completed-with-warnings")
                ) {
                    return;
                }
                throw new Error(`Production deploy outcome ${result.outcome}`);
            }
            throw new Error(`Production deploy job ${detail.run.state}`);
        }
        await sleep(pollIntervalMs);
    }
    throw new Error("Production deploy job did not settle before its deadline");
}
