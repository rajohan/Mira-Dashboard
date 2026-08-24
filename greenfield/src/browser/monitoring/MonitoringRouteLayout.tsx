import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Heading } from "../ui/Heading.tsx";
import { Tabs } from "../ui/Tabs.tsx";

type MonitoringRoutePath = "/incidents" | "/reports";
type MonitoringRouteView = "incidents" | "reports";

interface MonitoringRouteLayoutProps {
    readonly children: ReactNode;
    readonly pathname: MonitoringRoutePath;
}

/**
 * Keeps monitoring tabs mounted while the selected child route changes so
 * keyboard focus and browser history remain part of one accessible tab set.
 *
 * @returns The shared monitoring route tabs and active child.
 */
export function MonitoringRouteLayout({
    children,
    pathname,
}: MonitoringRouteLayoutProps) {
    const navigate = useNavigate();
    const value: MonitoringRouteView =
        pathname === "/incidents" ? "incidents" : "reports";

    return (
        <div>
            <Heading className="sr-only" level={1}>
                {value === "incidents" ? "Incidents" : "Reports"}
            </Heading>
            <Tabs
                ariaLabel="Monitoring views"
                onChange={(nextView) => {
                    void navigate({
                        to: nextView === "reports" ? "/reports" : "/incidents",
                    });
                }}
                tabs={[
                    {
                        label: "Reports",
                        panel: value === "reports" ? children : null,
                        value: "reports",
                    },
                    {
                        label: "Incidents",
                        panel: value === "incidents" ? children : null,
                        value: "incidents",
                    },
                ]}
                value={value}
            />
        </div>
    );
}
