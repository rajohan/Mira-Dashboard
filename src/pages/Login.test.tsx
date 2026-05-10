import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Login } from "./Login";

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    navigate: vi.fn(),
    refreshSession: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
    useNavigate: () => mocks.navigate,
}));

vi.mock("../stores/authStore", () => ({
    authActions: { refreshSession: mocks.refreshSession },
}));

function jsonResponse(payload: unknown, init?: ResponseInit) {
    return Response.json(payload, {
        status: init?.status ?? 200,
        ...init,
    });
}

describe("Login page", () => {
    beforeEach(() => {
        mocks.fetch.mockReset();
        mocks.navigate.mockReset();
        mocks.refreshSession.mockReset();
        mocks.refreshSession.mockResolvedValue(Promise.resolve());
        vi.stubGlobal("fetch", mocks.fetch);
    });

    it("loads standard login mode and submits credentials", async () => {
        const user = userEvent.setup();
        mocks.fetch
            .mockResolvedValueOnce(
                jsonResponse({ bootstrapRequired: false, hasGatewayToken: true })
            )
            .mockResolvedValueOnce(jsonResponse({ ok: true }));

        render(<Login />);

        expect(
            await screen.findByText("Log in with your dashboard username and password")
        ).toBeInTheDocument();

        await user.type(screen.getByPlaceholderText("Enter your username"), " raymond ");
        await user.type(screen.getByPlaceholderText("Enter your password"), "secret");
        await user.click(screen.getByRole("button", { name: "Log in" }));

        await waitFor(() => {
            expect(mocks.fetch).toHaveBeenCalledWith(
                "/api/auth/login",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ username: "raymond", password: "secret" }),
                })
            );
        });
        expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
        expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
    });

    it("loads bootstrap mode and submits the gateway token", async () => {
        const user = userEvent.setup();
        mocks.fetch
            .mockResolvedValueOnce(
                jsonResponse({ bootstrapRequired: true, hasGatewayToken: false })
            )
            .mockResolvedValueOnce(jsonResponse({ ok: true }));

        render(<Login />);

        expect(
            await screen.findByText(
                "Create the first dashboard user and save the gateway token server-side"
            )
        ).toBeInTheDocument();
        expect(
            screen.getByPlaceholderText("Enter your OpenClaw gateway token")
        ).toBeInTheDocument();

        await user.type(screen.getByPlaceholderText("Enter your username"), "mira");
        await user.type(screen.getByPlaceholderText("Enter your password"), "secret");
        await user.type(
            screen.getByPlaceholderText("Enter your OpenClaw gateway token"),
            " token "
        );
        await user.click(screen.getByRole("button", { name: "Create first user" }));

        await waitFor(() => {
            expect(mocks.fetch).toHaveBeenCalledWith(
                "/api/auth/register-first-user",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({
                        username: "mira",
                        password: "secret",
                        gatewayToken: "token",
                    }),
                })
            );
        });
    });

    it("shows bootstrap load errors", async () => {
        mocks.fetch.mockResolvedValueOnce(
            jsonResponse({ error: "nope" }, { status: 500 })
        );

        render(<Login />);

        expect(await screen.findByText("Failed to load auth state")).toBeInTheDocument();
    });

    it("shows authentication errors and refreshes bootstrap state", async () => {
        const user = userEvent.setup();
        mocks.fetch
            .mockResolvedValueOnce(
                jsonResponse({ bootstrapRequired: false, hasGatewayToken: true })
            )
            .mockResolvedValueOnce(
                jsonResponse({ error: "Invalid credentials" }, { status: 401 })
            )
            .mockResolvedValueOnce(
                jsonResponse({ bootstrapRequired: false, hasGatewayToken: true })
            );

        render(<Login />);

        await screen.findByText("Log in with your dashboard username and password");
        await user.type(screen.getByPlaceholderText("Enter your username"), "raymond");
        await user.type(screen.getByPlaceholderText("Enter your password"), "wrong");
        await user.click(screen.getByRole("button", { name: "Log in" }));

        expect(await screen.findByText("Invalid credentials")).toBeInTheDocument();
        expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
        expect(mocks.navigate).not.toHaveBeenCalled();
    });
});
