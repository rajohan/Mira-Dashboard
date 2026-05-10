import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { getProgressColor, ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
    it("maps progress colors by thresholds", () => {
        expect(getProgressColor(49)).toBe("green");
        expect(getProgressColor(50)).toBe("blue");
        expect(getProgressColor(74)).toBe("blue");
        expect(getProgressColor(75)).toBe("orange");
        expect(getProgressColor(90)).toBe("red");
    });

    it("caps rendered width at 100% and uses explicit color", () => {
        const { container } = render(
            <ProgressBar percent={150} color="purple" size="sm" />
        );
        const track = container.firstElementChild;
        const bar = track?.firstElementChild as HTMLElement | null;

        expect(track).toHaveClass("h-1.5");
        expect(bar).toHaveClass("bg-purple-500");
        expect(bar).toHaveStyle({ width: "100%" });
    });
});
