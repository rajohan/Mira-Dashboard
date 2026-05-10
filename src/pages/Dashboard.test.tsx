import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Dashboard } from "./Dashboard";

const hooks = vi.hoisted(() => ({
    useMetrics: vi.fn(),
    useOpenClawSocket: vi.fn(),
    useQuotas: vi.fn(),
    useWeather: vi.fn(),
}));

vi.mock("../hooks/useOpenClawSocket", () => ({
    useOpenClawSocket: hooks.useOpenClawSocket,
}));

vi.mock("../hooks", () => ({
    useMetrics: hooks.useMetrics,
    useQuotas: hooks.useQuotas,
    useWeather: hooks.useWeather,
}));

vi.mock("../components/ui/MetricCard", () => ({
    MetricCard: ({
        percent,
        subtitle,
        title,
        value,
    }: {
        percent?: number;
        subtitle?: string;
        title: string;
        value?: string;
    }) => (
        <section data-testid={`metric-${title.toLowerCase()}`}>
            {title}: {value || subtitle} {percent === undefined ? "" : `${percent}%`}
        </section>
    ),
}));

vi.mock("../components/features/dashboard", () => ({
    BackupOverviewCard: () => <section data-testid="backup-card">Backup</section>,
    CacheStatusCard: ({ items }: { items: unknown[] }) => (
        <section data-testid="cache-card">Cache items: {items.length}</section>
    ),
    CronOverviewCard: () => <section data-testid="cron-card">Cron</section>,
    GitOverviewCard: () => <section data-testid="git-card">Git</section>,
    LogRotationCard: () => <section data-testid="log-rotation-card">Logs</section>,
    QuotaOverviewCard: ({ quotas }: { quotas: unknown }) => (
        <section data-testid="quota-card">Quotas: {quotas ? "loaded" : "empty"}</section>
    ),
    ServiceActionsCard: () => (
        <section data-testid="service-actions-card">Services</section>
    ),
}));

function mockDashboardData(overrides = {}) {
    hooks.useOpenClawSocket.mockReturnValue({ error: null });
    hooks.useMetrics.mockReturnValue({
        data: {
            cpu: { loadAvg: [0.1, 0.2, 0.3], loadPercent: 12 },
            disk: { percent: 65, totalGB: 100, usedGB: 65 },
            memory: { percent: 50, totalGB: 8, usedGB: 4 },
            network: { downloadMbps: 12.34, uploadMbps: 5.67 },
            system: { hostname: "mira-vps", uptime: 3661 },
        },
    });
    hooks.useQuotas.mockReturnValue({ data: { providers: [] } });
    hooks.useWeather.mockReturnValue({
        data: {
            description: "clear sky",
            feelsLikeC: 6.5,
            forecast: [
                {
                    date: "2026-05-11",
                    description: "rain",
                    maxTempC: 11,
                    minTempC: 5,
                },
                {
                    date: "2026-05-12",
                    description: "cloudy",
                    maxTempC: 13,
                    minTempC: 6,
                },
            ],
            humidityPercent: 73,
            location: "Spydeberg",
            temperatureC: 7.4,
            windKph: 12,
        },
        isError: false,
        isLoading: false,
    });

    for (const [key, value] of Object.entries(overrides)) {
        if (key === "socket") hooks.useOpenClawSocket.mockReturnValue(value);
        if (key === "metrics") hooks.useMetrics.mockReturnValue(value);
        if (key === "quotas") hooks.useQuotas.mockReturnValue(value);
        if (key === "weather") hooks.useWeather.mockReturnValue(value);
    }
}

describe("Dashboard page", () => {
    beforeEach(() => {
        hooks.useMetrics.mockReset();
        hooks.useOpenClawSocket.mockReset();
        hooks.useQuotas.mockReset();
        hooks.useWeather.mockReset();
        mockDashboardData();
    });

    it("renders weather, metrics, and dashboard cards", () => {
        render(<Dashboard />);

        expect(screen.getByText("Spydeberg")).toBeInTheDocument();
        expect(screen.getByText("7°C")).toBeInTheDocument();
        expect(screen.getByText("clear sky")).toBeInTheDocument();
        expect(screen.getByText("Feels 7°")).toBeInTheDocument();
        expect(screen.getByText("73%")).toBeInTheDocument();
        expect(screen.getByText("12 km/h")).toBeInTheDocument();
        expect(screen.getByText("Today")).toBeInTheDocument();

        expect(screen.getByTestId("metric-cpu")).toHaveTextContent("CPU:");
        expect(screen.getByTestId("metric-memory")).toHaveTextContent(
            "Memory: 4 GB of 8 GB 50%"
        );
        expect(screen.getByTestId("metric-disk")).toHaveTextContent(
            "Disk: 65 GB of 100 GB 65%"
        );
        expect(screen.getByTestId("metric-uptime")).toHaveTextContent("1h 1m");
        expect(screen.getByTestId("metric-download")).toHaveTextContent("12.34 Mbit/s");
        expect(screen.getByTestId("metric-upload")).toHaveTextContent("5.67 Mbit/s");

        expect(screen.getByTestId("quota-card")).toHaveTextContent("loaded");
        expect(screen.getByTestId("cache-card")).toHaveTextContent("Cache items: 8");
        expect(screen.getByTestId("backup-card")).toBeInTheDocument();
        expect(screen.getByTestId("service-actions-card")).toBeInTheDocument();
        expect(screen.getByTestId("log-rotation-card")).toBeInTheDocument();
    });

    it("renders socket and weather errors", () => {
        mockDashboardData({
            socket: { error: "WebSocket disconnected" },
            weather: {
                data: null,
                isError: true,
                isLoading: false,
            },
        });

        render(<Dashboard />);

        expect(screen.getByText("WebSocket disconnected")).toBeInTheDocument();
        expect(
            screen.getByText("Couldn't retrieve weather data right now.")
        ).toBeInTheDocument();
        expect(screen.getByText("Unknown")).toBeInTheDocument();
    });

    it("renders loading fallbacks when metrics and weather are missing", () => {
        mockDashboardData({
            metrics: { data: null },
            quotas: { data: null },
            weather: { data: null, isError: false, isLoading: true },
        });

        render(<Dashboard />);

        expect(screen.getByText("Loading weather...")).toBeInTheDocument();
        expect(screen.getByText("--°C")).toBeInTheDocument();
        expect(screen.getByTestId("metric-cpu")).toHaveTextContent("Loading...");
        expect(screen.getByTestId("metric-memory")).toHaveTextContent("Loading...");
        expect(screen.getByTestId("metric-disk")).toHaveTextContent("Loading...");
        expect(screen.getByTestId("quota-card")).toHaveTextContent("empty");
    });
});
