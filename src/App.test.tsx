import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
}));

vi.mock("@tanstack/react-devtools", () => ({
    TanStackDevtools: ({ plugins }: { plugins: unknown[] }) => (
        <div data-testid="devtools">{plugins.length} devtools plugins</div>
    ),
}));

vi.mock("@tanstack/react-form-devtools", () => ({
    FormDevtoolsPanel: () => <div>form devtools</div>,
}));

vi.mock("@tanstack/react-query", () => ({
    QueryClientProvider: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="query-provider">{children}</div>
    ),
}));

vi.mock("@tanstack/react-query-devtools", () => ({
    ReactQueryDevtoolsPanel: () => <div>query devtools</div>,
}));

vi.mock("@tanstack/react-router", () => ({
    RouterProvider: () => <div data-testid="router-provider">router content</div>,
}));

vi.mock("@tanstack/react-router-devtools", () => ({
    TanStackRouterDevtoolsPanel: () => <div>router devtools</div>,
}));

vi.mock("./hooks/useOpenClawSocket", () => ({
    OpenClawSocketProvider: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="socket-provider">{children}</div>
    ),
}));

vi.mock("./lib/queryClient", () => ({
    queryClient: {},
}));

vi.mock("./router", () => ({
    router: { navigate: mocks.navigate },
}));

import App from "./App";

describe("App", () => {
    it("renders the provider stack and devtools plugins around the router", () => {
        render(<App />);

        expect(screen.getByTestId("query-provider")).toBeInTheDocument();
        expect(screen.getByTestId("socket-provider")).toBeInTheDocument();
        expect(screen.getByTestId("router-provider")).toHaveTextContent("router content");
        expect(screen.getByTestId("devtools")).toHaveTextContent("3 devtools plugins");
    });

    it("navigates to login on global unauthorized events and removes the listener", () => {
        const { unmount } = render(<App />);

        window.dispatchEvent(new Event("openclaw:unauthorized"));
        expect(mocks.navigate).toHaveBeenCalledWith({ to: "/login" });

        mocks.navigate.mockClear();
        unmount();
        window.dispatchEvent(new Event("openclaw:unauthorized"));
        expect(mocks.navigate).not.toHaveBeenCalled();
    });
});
