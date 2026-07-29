import * as v from "valibot";

import { finiteNumberSchema, parseContract } from "./runtime";

const optionalNumberValueSchema = v.optional(finiteNumberSchema);
const optionalStringValueSchema = v.optional(v.string());

export const quotaErrorSchema = v.strictObject({
    note: v.optional(v.string()),
    status: v.picklist(["not_configured", "error"]),
});

export const openRouterQuotaSchema = v.strictObject({
    limit: optionalNumberValueSchema,
    limitRemaining: optionalNumberValueSchema,
    limitReset: optionalStringValueSchema,
    percentUsed: optionalNumberValueSchema,
    remaining: finiteNumberSchema,
    totalCredits: finiteNumberSchema,
    usage: finiteNumberSchema,
    usageMonthly: finiteNumberSchema,
});

export const elevenLabsQuotaSchema = v.strictObject({
    percentUsed: optionalNumberValueSchema,
    remaining: finiteNumberSchema,
    resetAt: optionalStringValueSchema,
    tier: v.string(),
    total: finiteNumberSchema,
    used: finiteNumberSchema,
});

export const openAiQuotaSchema = v.strictObject({
    account: optionalStringValueSchema,
    fiveHourLeftPercent: optionalNumberValueSchema,
    fiveHourReset: optionalStringValueSchema,
    model: optionalStringValueSchema,
    percentUsed: finiteNumberSchema,
    resetAt: optionalStringValueSchema,
    weeklyLeftPercent: finiteNumberSchema,
    weeklyReset: optionalStringValueSchema,
});

export const syntheticQuotaSchema = v.strictObject({
    rollingFiveHourLimit: v.strictObject({
        limited: v.boolean(),
        max: finiteNumberSchema,
        nextTickAt: optionalStringValueSchema,
        percentUsed: optionalNumberValueSchema,
        remaining: finiteNumberSchema,
        tickPercent: v.optional(finiteNumberSchema),
    }),
    searchHourly: v.strictObject({
        limit: finiteNumberSchema,
        percentUsed: optionalNumberValueSchema,
        remaining: finiteNumberSchema,
        renewsAt: optionalStringValueSchema,
        requests: finiteNumberSchema,
    }),
    subscription: v.strictObject({
        limit: finiteNumberSchema,
        percentUsed: optionalNumberValueSchema,
        remaining: finiteNumberSchema,
        renewsAt: optionalStringValueSchema,
        requests: finiteNumberSchema,
    }),
    weeklyTokenLimit: v.strictObject({
        maxCredits: v.optional(v.string()),
        nextRegenAt: optionalStringValueSchema,
        nextRegenCredits: v.optional(v.string()),
        nextRegenPercent: v.optional(finiteNumberSchema),
        percentRemaining: finiteNumberSchema,
        remainingCredits: v.optional(v.string()),
    }),
});

const quotaProvider = <
    const TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
    schema: TSchema
) => v.union([quotaErrorSchema, schema]);

export const quotasResponseSchema = v.strictObject({
    cacheAgeMs: finiteNumberSchema,
    checkedAt: finiteNumberSchema,
    elevenlabs: quotaProvider(elevenLabsQuotaSchema),
    openai: quotaProvider(openAiQuotaSchema),
    openrouter: quotaProvider(openRouterQuotaSchema),
    synthetic: quotaProvider(syntheticQuotaSchema),
});

export type QuotaError = v.InferOutput<typeof quotaErrorSchema>;
export type OpenRouterQuota = v.InferOutput<typeof openRouterQuotaSchema>;
export type ElevenLabsQuota = v.InferOutput<typeof elevenLabsQuotaSchema>;
export type OpenAiQuota = v.InferOutput<typeof openAiQuotaSchema>;
export type SyntheticQuota = v.InferOutput<typeof syntheticQuotaSchema>;
export type QuotasResponse = v.InferOutput<typeof quotasResponseSchema>;

/**
 * Parses the cached quota summary at the browser trust boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the cached quota summary at the browser trust boundary.
 */
export function parseQuotasResponse(value: unknown, path = "quotas"): QuotasResponse {
    return parseContract(quotasResponseSchema, value, path);
}
