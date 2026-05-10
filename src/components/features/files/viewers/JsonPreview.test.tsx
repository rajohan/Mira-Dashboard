import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { JsonPreview } from "./JsonPreview";

vi.mock("@microlink/react-json-view", () => ({
    __esModule: true,
    default: ({ src }: { src: unknown }) => (
        <div data-testid="json-view" data-json={JSON.stringify(src)} />
    ),
}));

describe("JsonPreview", () => {
    it("renders valid JSON5 content", () => {
        render(<JsonPreview content="{ key: 'value' }" />);

        const view = screen.getByTestId("json-view");
        expect(view).toBeInTheDocument();
        expect(view.dataset.json).toBe('{"key":"value"}');
    });

    it("renders standard JSON content", () => {
        render(<JsonPreview content='{"name": "test"}' />);

        const view = screen.getByTestId("json-view");
        expect(view).toBeInTheDocument();
        expect(view.dataset.json).toBe('{"name":"test"}');
    });

    it("renders error object when content is invalid JSON", () => {
        render(<JsonPreview content="not-json-at-all" />);

        const view = screen.getByTestId("json-view");
        const parsed = JSON.parse(view.dataset.json!);
        expect(parsed.error).toBe("Failed to parse JSON");
        expect(parsed.raw).toBe("not-json-at-all");
    });
});
