import { describe, expect, test } from "bun:test";

import { QuotaResetTime } from "./OverviewEnvironmentSection.tsx";

const { render, screen } = await import("@testing-library/react");

describe("QuotaResetTime", () => {
    test("renders a safe fallback when an untrusted caller bypasses the quota contract", () => {
        render(<QuotaResetTime resetsAtMs={8_640_000_000_000_001} />);

        expect(screen.getByText("Unavailable")).toBeTruthy();
        expect(document.querySelector("time")).toBeNull();
    });
});
