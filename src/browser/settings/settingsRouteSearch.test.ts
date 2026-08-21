import { describe, expect, test } from "bun:test";

import { normalizeSettingsSearch, settingsRouteView } from "./settingsRouteSearch.ts";

describe("settings route search", () => {
    test("keeps only exact reviewed views", () => {
        expect(normalizeSettingsSearch({ view: "dashboard" })).toEqual({
            view: "dashboard",
        });
        expect(normalizeSettingsSearch({ ignored: true, view: "openclaw" })).toEqual({
            view: "openclaw",
        });
    });

    test("drops malformed and unknown external selections", () => {
        expect(normalizeSettingsSearch({ view: "gateway" })).toEqual({});
        expect(normalizeSettingsSearch({ view: "OpenClaw" })).toEqual({});
        expect(normalizeSettingsSearch({ view: ["openclaw"] })).toEqual({});
        expect(normalizeSettingsSearch(null)).toEqual({});
        expect(normalizeSettingsSearch(["openclaw"])).toEqual({});
        expect(normalizeSettingsSearch("openclaw")).toEqual({});
    });

    test("uses Dashboard as the stable default without inventing another URL value", () => {
        expect(settingsRouteView({})).toBe("dashboard");
        expect(settingsRouteView({ view: "dashboard" })).toBe("dashboard");
        expect(settingsRouteView({ view: "openclaw" })).toBe("openclaw");
    });
});
