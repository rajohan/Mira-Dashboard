import * as v from "valibot";

import {
    finiteNumberSchema,
    nonNegativeIntegerSchema,
    parseContract,
    strictJsonObjectSchema,
} from "./runtime";

const defaultModelSchema = v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty(),
    v.maxLength(200),
    v.check((value) => !value.includes("\0"), "must not contain a null byte")
);

const refreshIntervalSchema = v.pipe(
    finiteNumberSchema,
    v.transform((value) => Math.max(1000, Math.min(60_000, Math.trunc(value))))
);

export const dashboardThemeSchema = v.picklist(["dark", "light", "system"]);

export const dashboardSettingsSchema = v.strictObject({
    defaultModel: defaultModelSchema,
    refreshInterval: refreshIntervalSchema,
    sidebarCollapsed: v.boolean(),
    theme: dashboardThemeSchema,
});

export const dashboardSettingsPatchSchema = strictJsonObjectSchema({
    defaultModel: v.optional(defaultModelSchema),
    refreshInterval: v.optional(refreshIntervalSchema),
    sidebarCollapsed: v.optional(v.boolean()),
    theme: v.optional(dashboardThemeSchema),
});

export const dashboardSettingsResponseSchema = v.strictObject({
    ...dashboardSettingsSchema.entries,
    gateway: v.strictObject({
        gateway: v.picklist(["connected", "disconnected"]),
        sessions: nonNegativeIntegerSchema,
    }),
});

export type DashboardTheme = v.InferOutput<typeof dashboardThemeSchema>;
export type DashboardSettings = v.InferOutput<typeof dashboardSettingsSchema>;
export type DashboardSettingsPatch = v.InferOutput<typeof dashboardSettingsPatchSchema>;
export type DashboardSettingsResponse = v.InferOutput<
    typeof dashboardSettingsResponseSchema
>;

/**
 * Parses persisted Dashboard settings.
 * @param value Value to process.
 * @returns Parsed persisted Dashboard settings.
 */
export function parseDashboardSettings(value: unknown): DashboardSettings {
    return parseContract(dashboardSettingsSchema, value, "settings");
}

/**
 * Parses a Dashboard settings update at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed Dashboard settings update.
 */
export function parseDashboardSettingsPatch(value: unknown): DashboardSettingsPatch {
    return parseContract(dashboardSettingsPatchSchema, value);
}
