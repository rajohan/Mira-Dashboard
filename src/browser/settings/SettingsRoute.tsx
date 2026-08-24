import { useNavigate, useSearch } from "@tanstack/react-router";

import { AccountSecurityRoute } from "../security/AccountSecurityRoute.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import { OpenClawSettingsPanel } from "./OpenClawSettingsPanel.tsx";
import {
    normalizeSettingsSearch,
    settingsRouteView,
    type SettingsRouteView,
} from "./settingsRouteSearch.ts";

/** @returns The consolidated Dashboard-account and OpenClaw settings surface. */
export function SettingsRoute() {
    const navigate = useNavigate({ from: "/settings" });
    const search = normalizeSettingsSearch(useSearch({ from: "/settings" }) as unknown);
    const view = settingsRouteView(search);

    function selectView(nextView: SettingsRouteView): void {
        void navigate({
            replace: true,
            search: { view: nextView },
        });
    }

    return (
        <Tabs
            ariaLabel="Settings views"
            onChange={selectView}
            tabs={[
                {
                    label: "Dashboard settings",
                    panel: view === "dashboard" ? <AccountSecurityRoute /> : null,
                    value: "dashboard",
                },
                {
                    label: "OpenClaw settings",
                    panel: view === "openclaw" ? <OpenClawSettingsPanel /> : null,
                    value: "openclaw",
                },
            ]}
            value={view}
        />
    );
}
