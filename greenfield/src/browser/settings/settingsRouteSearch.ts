import * as v from "valibot";

const settingsRouteSearchSchema = v.strictObject({
    view: v.optional(v.picklist(["dashboard", "openclaw"])),
});

/** Validated tab selection owned by `/settings`. */
export type SettingsRouteSearch = v.InferOutput<typeof settingsRouteSearchSchema>;
export type SettingsRouteView = NonNullable<SettingsRouteSearch["view"]>;

/**
 * Keeps only the two reviewed Settings views from an untrusted external URL.
 * @param search Untrusted search object parsed by TanStack Router.
 * @returns One optional exact Settings view.
 */
export function normalizeSettingsSearch(search: unknown): SettingsRouteSearch {
    const view =
        typeof search === "object" &&
        search !== null &&
        !Array.isArray(search) &&
        "view" in search &&
        typeof search.view === "string"
            ? search.view
            : undefined;
    const parsed = v.safeParse(
        settingsRouteSearchSchema,
        view === undefined ? {} : { view }
    );
    return parsed.success ? parsed.output : {};
}

/** @returns The explicit view or the stable Dashboard default. */
export function settingsRouteView(search: SettingsRouteSearch): SettingsRouteView {
    return search.view === "openclaw" ? "openclaw" : "dashboard";
}
