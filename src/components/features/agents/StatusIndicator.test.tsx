import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusIndicator } from "./StatusIndicator";

describe("StatusIndicator", () => {
    it("pulses for active and thinking states", () => {
        const { container, rerender } = render(<StatusIndicator status="active" />);

        expect(container.firstElementChild).toHaveClass("animate-pulse");

        rerender(<StatusIndicator status="idle" />);

        expect(container.firstElementChild).not.toHaveClass("animate-pulse");
    });
});
