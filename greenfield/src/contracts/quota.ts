import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedControlSafeTextSchema,
    nonnegativeSafeIntegerSchema,
} from "../shared/validation.ts";

/** Stable cache identity for normalized external-provider usage limits. */
export const quotaCacheKey = "quotas.summary";
/** Exact schema identity retained with the quota cache row. */
export const quotaCacheSchemaId = "quotas.summary.v1";
/** Aggregate source identity; individual provider authority remains worker-only. */
export const quotaCacheSource = "quota.providers";
/** Maximum fresh lifetime retained by the Dashboard cache. */
export const quotaCacheTtlMs = 60 * 60_000;

export const quotaProviderIdSchema = v.picklist(
    ["elevenlabs", "openai", "openrouter", "synthetic"],
    "Quota provider is invalid"
);

export const quotaProviderStatusSchema = v.picklist(
    ["available", "not-configured", "unavailable"],
    "Quota provider status is invalid"
);

const quotaPercentSchema = v.pipe(
    v.number("Quota percentage is invalid"),
    v.finite("Quota percentage is invalid"),
    v.minValue(0, "Quota percentage is invalid"),
    v.maxValue(100, "Quota percentage is invalid")
);

const quotaValueSchema = v.pipe(
    v.number("Quota value is invalid"),
    v.finite("Quota value is invalid"),
    v.minValue(0, "Quota value is invalid"),
    v.maxValue(Number.MAX_SAFE_INTEGER, "Quota value is invalid")
);

export const quotaWindowSchema = v.strictObject({
    resetsAtMs: timestampMillisecondsSchema("Quota window reset is invalid"),
    usedPercent: quotaPercentSchema,
    windowDurationMinutes: nonnegativeSafeIntegerSchema(
        "Quota window duration is invalid"
    ),
});

export const quotaProviderProjectionSchema = v.pipe(
    v.strictObject({
        id: quotaProviderIdSchema,
        label: boundedControlSafeTextSchema(32, "Quota label is invalid"),
        limit: v.optional(quotaValueSchema),
        remaining: v.optional(quotaValueSchema),
        remainingPercent: v.optional(quotaPercentSchema),
        resetsAtMs: v.optional(
            timestampMillisecondsSchema("Quota reset timestamp is invalid")
        ),
        status: quotaProviderStatusSchema,
        unit: v.optional(
            v.picklist(
                ["credits", "currency-usd", "requests", "text-characters"],
                "Quota unit is invalid"
            )
        ),
        used: v.optional(quotaValueSchema),
        usedPercent: v.optional(quotaPercentSchema),
        windows: v.optional(
            v.pipe(
                v.array(quotaWindowSchema, "Quota windows are invalid"),
                v.minLength(1, "Quota windows are invalid"),
                v.maxLength(8, "Quota windows are invalid")
            )
        ),
    }),
    v.check(
        (provider) =>
            provider.status === "available"
                ? provider.used !== undefined ||
                  provider.remaining !== undefined ||
                  provider.usedPercent !== undefined ||
                  provider.remainingPercent !== undefined ||
                  provider.windows !== undefined
                : provider.limit === undefined &&
                  provider.remaining === undefined &&
                  provider.remainingPercent === undefined &&
                  provider.resetsAtMs === undefined &&
                  provider.unit === undefined &&
                  provider.used === undefined &&
                  provider.usedPercent === undefined &&
                  provider.windows === undefined,
        "Quota provider projection is inconsistent"
    )
);

export const quotaCachePayloadSchema = v.pipe(
    v.strictObject({
        observedAtMs: timestampMillisecondsSchema("Quota timestamp is invalid"),
        providers: v.pipe(
            v.array(quotaProviderProjectionSchema, "Quota providers are invalid"),
            v.length(4, "Quota projection must contain every provider")
        ),
    }),
    v.check(
        ({ providers }) =>
            providers.every(
                (provider, index) =>
                    provider.id ===
                    (["elevenlabs", "openai", "openrouter", "synthetic"] as const)[index]
            ),
        "Quota providers must be unique and canonically ordered"
    )
);

export type QuotaProviderProjection = v.InferOutput<typeof quotaProviderProjectionSchema>;
export type QuotaCachePayload = v.InferOutput<typeof quotaCachePayloadSchema>;
