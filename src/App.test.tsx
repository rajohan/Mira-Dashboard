import { render, screen } from "@testing-library/react";
import { describe, expect, it, jest, mock } from "bun:test";

import { hoisted } from "./test/testUtils";

const mocks = hoisted(() => ({
    navigate: jest.fn(),
}));

mock.module("@tanstack/react-devtools", () => ({
    TanStackDevtools: ({ plugins }: { plugins: unknown[] }) => (
        <div data-testid="devtools">{plugins.length} devtools plugins</div>
    ),
}));

mock.module("@tanstack/react-form-devtools", () => ({
    FormDevtoolsPanel: () => <div>form devtools</div>,
}));

mock.module("@tanstack/react-query", () => ({
    QueryClientProvider: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="query-provider">{children}</div>
    ),
}));

mock.module("@tanstack/react-query-devtools", () => ({
    ReactQueryDevtoolsPanel: () => <div>query devtools</div>,
}));

mock.module("@tanstack/react-router", () => ({
    RouterProvider: () => <div data-testid="router-provider">router content</div>,
}));

mock.module("@tanstack/react-router-devtools", () => ({
    TanStackRouterDevtoolsPanel: () => <div>router devtools</div>,
}));

mock.module("./hooks/useOpenClawSocket", () => ({
    OpenClawSocketProvider: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="socket-provider">{children}</div>
    ),
}));

mock.module("./lib/queryClient", () => ({
    queryClient: {},
}));

mock.module("./router", () => ({
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
