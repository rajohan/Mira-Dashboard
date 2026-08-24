import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { PageHeader } from "../ui/PageHeader.tsx";
import { Tabs } from "../ui/Tabs.tsx";

type MonitoringRoutePath = "/incidents" | "/reports";
type MonitoringRouteView = "incidents" | "reports";

interface MonitoringRouteLayoutProps {
    readonly children: ReactNode;
    readonly pathname: MonitoringRoutePath;
}

const monitoringRouteCopy = Object.freeze({
    incidents: Object.freeze({
        description:
            "See current and resolved problems reported by monitoring. This page updates automatically and checks again every 30 seconds if live updates stop.",
        title: "Incidents",
    }),
    reports: Object.freeze({
        description:
            "Read daily briefs, summaries, health checks, and other monitoring reports. This page updates automatically and checks again every 30 seconds if live updates stop.",
        title: "Reports",
    }),
});

/**
 * Keeps monitoring tabs mounted while the selected child route changes so
 * keyboard focus and browser history remain part of one accessible tab set.
 *
 * @returns The shared monitoring page header, route tabs, and active child.
 */
export function MonitoringRouteLayout({
    children,
    pathname,
}: MonitoringRouteLayoutProps) {
    const navigate = useNavigate();
    const value: MonitoringRouteView =
        pathname === "/incidents" ? "incidents" : "reports";
    const copy = monitoringRouteCopy[value];

    return (
        <div>
            <PageHeader
                description={copy.description}
                eyebrow="Monitoring"
                title={copy.title}
            />
            <Tabs
                ariaLabel="Monitoring views"
                className="mt-8"
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
