import * as v from "valibot";

import { parseContract, strictJsonObjectSchema, successLiteralSchema } from "../runtime";

export const jobWorkerClaimsPatchSchema = strictJsonObjectSchema({
    paused: v.boolean(),
});

export const jobWorkerClaimsStateSchema = v.strictObject({
    paused: v.boolean(),
    updatedAt: v.string(),
});

export const jobWorkerClaimsMutationResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    state: jobWorkerClaimsStateSchema,
});

export type JobWorkerClaimsPatch = v.InferOutput<typeof jobWorkerClaimsPatchSchema>;
export type JobWorkerClaimsState = v.InferOutput<typeof jobWorkerClaimsStateSchema>;
export type JobWorkerClaimsMutationResponse = v.InferOutput<
    typeof jobWorkerClaimsMutationResponseSchema
>;

export function parseJobWorkerClaimsPatch(value: unknown): JobWorkerClaimsPatch {
    return parseContract(jobWorkerClaimsPatchSchema, value);
}

export function parseJobWorkerClaimsMutationResponse(
    value: unknown
): JobWorkerClaimsMutationResponse {
    return parseContract(jobWorkerClaimsMutationResponseSchema, value, "response");
}
