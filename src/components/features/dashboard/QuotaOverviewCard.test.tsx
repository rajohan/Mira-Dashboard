import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { QuotasResponse, SyntheticQuota } from "../../../hooks/useQuotas";
import { QuotaOverviewCard } from "./QuotaOverviewCard";

const quotas: QuotasResponse = {
    cacheAgeMs: 1000,
    checkedAt: new Date("2026-05-10T10:00:00.000Z").getTime(),
    elevenlabs: {
        percentUsed: 75,
        remaining: 25,
        resetAt: "2026-05-11T10:00:00.000Z",
        tier: "creator",
        total: 100,
        used: 75,
    },
    openai: {
        account: "codex",
        fiveHourLeftPercent: 15,
        fiveHourReset: "13:45 on 10 May",
        model: "gpt-5.5",
        percentUsed: 85,
        resetAt: null,
        weeklyLeftPercent: 60,
        weeklyReset: "2026-05-17T10:00:00.000Z",
    },
    openrouter: {
        percentUsed: 96,
        remaining: 1.5,
        totalCredits: 10,
        usage: 8.5,
        usageMonthly: 8.5,
    },
    synthetic: {
        rollingFiveHourLimit: {
            limited: false,
            max: 100,
            nextTickAt: "unknown",
            percentUsed: 10,
            remaining: 90,
        },
        searchHourly: {
            limit: 100,
            percentUsed: 0,
            remaining: 100,
            renewsAt: null,
            requests: 0,
        },
        subscription: {
            limit: 100,
            percentUsed: 0,
            remaining: 100,
            renewsAt: null,
            requests: 0,
        },
        weeklyTokenLimit: {
            nextRegenAt: "2026-05-17T10:00:00.000Z",
            percentRemaining: 98,
        },
    },
    zai: {
        fiveHour: { resetAt: "unknown", usedPercentage: 30 },
        level: "pro",
        weekly: { resetAt: "2026-05-17T10:00:00.000Z", usedPercentage: 40 },
    },
};

describe("QuotaOverviewCard", () => {
    it("renders loading state without quota data", () => {
        render(<QuotaOverviewCard quotas={undefined} />);

        expect(screen.getByText("Loading usage limits…")).toBeInTheDocument();
    });

    it("renders usage summaries and status fallbacks", () => {
        render(
            <QuotaOverviewCard
                quotas={{
                    ...quotas,
                    elevenlabs: { note: "missing key", status: "not_configured" },
                }}
            />
        );

        expect(screen.getByText("Usage Limits")).toBeInTheDocument();
        expect(screen.getByText("OpenRouter")).toBeInTheDocument();
        expect(screen.getByText("96%")).toHaveClass("bg-red-500/20");
        expect(screen.getByText("not configured")).toBeInTheDocument();
        expect(screen.getByText("missing key")).toBeInTheDocument();
        expect(screen.getByText(/5h 70% left · weekly 60% left/u)).toBeInTheDocument();
        expect(screen.getByText(/5h 15% left · weekly 60% left/u)).toBeInTheDocument();
    });

    it("renders warning and success quota severities with reset fallbacks", () => {
        const synthetic = quotas.synthetic as SyntheticQuota;

        render(
            <QuotaOverviewCard
                quotas={{
                    ...quotas,
                    elevenlabs: {
                        ...quotas.elevenlabs,
                        percentUsed: 0,
                        resetAt: "unknown",
                    },
                    openai: {
                        ...quotas.openai,
                        fiveHourReset: "14:30",
                        percentUsed: 80,
                        weeklyReset: "not a date",
                    },
                    openrouter: {
                        ...quotas.openrouter,
                        percentUsed: 50,
                    },
                    synthetic: {
                        ...quotas.synthetic,
                        rollingFiveHourLimit: {
                            ...synthetic.rollingFiveHourLimit,
                            percentUsed: 84.4,
                        },
                        weeklyTokenLimit: {
                            ...synthetic.weeklyTokenLimit,
                            percentRemaining: 70,
                        },
                    },
                }}
            />
        );

        expect(screen.getByText("50%")).toHaveClass("bg-green-500/20");
        expect(screen.getByText("80%")).toHaveClass("bg-yellow-500/20");
        expect(screen.getByText("84%")).toHaveClass("bg-yellow-500/20");
        expect(screen.getByText("100% left")).toBeInTheDocument();
        expect(screen.getByText(/weekly not a date/u)).toBeInTheDocument();
    });

    it("renders provider status lines without optional notes or badges", () => {
        render(
            <QuotaOverviewCard
                quotas={{
                    ...quotas,
                    openai: { status: "error" },
                    openrouter: { status: "not_configured" },
                    synthetic: { status: "error" },
                    zai: { status: "not_configured" },
                }}
            />
        );

        expect(screen.getAllByText("error")).toHaveLength(2);
        expect(screen.getAllByText("not configured")).toHaveLength(2);
        expect(screen.queryByText("85%")).not.toBeInTheDocument();
    });

    it("renders null percentages and invalid OpenAI-style reset values", () => {
        const synthetic = quotas.synthetic as SyntheticQuota;

        render(
            <QuotaOverviewCard
                quotas={{
                    ...quotas,
                    elevenlabs: {
                        ...quotas.elevenlabs,
                        percentUsed: null,
                        resetAt: null,
                    },
                    openai: {
                        ...quotas.openai,
                        fiveHourLeftPercent: 0,
                        fiveHourReset: "13:45 on 10 Foo",
                        percentUsed: 0,
                    },
                    openrouter: {
                        ...quotas.openrouter,
                        percentUsed: null,
                    },
                    synthetic: {
                        ...quotas.synthetic,
                        rollingFiveHourLimit: {
                            ...synthetic.rollingFiveHourLimit,
                            percentUsed: null,
                        },
                        weeklyTokenLimit: {
                            ...synthetic.weeklyTokenLimit,
                            percentRemaining: -12,
                        },
                    },
                    zai: {
                        ...quotas.zai,
                        fiveHour: { resetAt: "13:45 on 10 Foo", usedPercentage: 130 },
                        weekly: { resetAt: "13:45", usedPercentage: 110 },
                    },
                }}
            />
        );

        expect(screen.getByText("$1.50 remaining")).toBeInTheDocument();
        expect(screen.getByText("100% left")).toBeInTheDocument();
        expect(screen.getByText(/weekly 0% left/u)).toBeInTheDocument();
        expect(screen.getByText(/5h 0% left · weekly 0% left/u)).toBeInTheDocument();
        expect(screen.getAllByText(/5h 13:45 on 10 Foo/u)).toHaveLength(2);
    });
});
