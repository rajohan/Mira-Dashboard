import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PullRequests } from "./PullRequests";

const hooks = vi.hoisted(() => ({
    approve: vi.fn(),
    deploy: vi.fn(),
    productionCheckout: {
        branch: "main",
        expectedBranch: "main",
        expectedRoot: "/home/ubuntu/projects/mira-dashboard",
        head: "abc123",
        isClean: true,
        isProductionRoot: true,
        isSafeForDeploy: true,
        root: "/home/ubuntu/projects/mira-dashboard",
        upstream: "origin/main",
        worktreeRoot: "/home/ubuntu/projects/mira-dashboard-worktrees",
    },
    pullRequests: [
        {
            additions: 10,
            author: { login: "mira-2026" },
            baseRefName: "main",
            body: "Adds tests",
            changedFiles: 2,
            deletions: 1,
            headRefName: "add-tests",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            mergeable: "MERGEABLE",
            number: 10,
            reviewDecision: "APPROVED",
            statusCheckRollup: [{ conclusion: "SUCCESS", name: "ci" }],
            title: "Add dashboard tests",
            updatedAt: "2026-05-11T00:00:00.000Z",
            url: "https://github.com/rajohan/Mira-Dashboard/pull/10",
        },
    ],
    refetch: vi.fn(),
    reject: vi.fn(),
    useApprovePullRequest: vi.fn(),
    useDeployDashboard: vi.fn(),
    useProductionCheckout: vi.fn(),
    usePullRequestDeployments: vi.fn(),
    usePullRequests: vi.fn(),
    useRejectPullRequest: vi.fn(),
}));

vi.mock("../hooks", () => ({
    useApprovePullRequest: hooks.useApprovePullRequest,
    useDeployDashboard: hooks.useDeployDashboard,
    useProductionCheckout: hooks.useProductionCheckout,
    usePullRequestDeployments: hooks.usePullRequestDeployments,
    usePullRequests: hooks.usePullRequests,
    useRejectPullRequest: hooks.useRejectPullRequest,
}));

vi.mock("../components/ui/ConfirmModal", () => ({
    ConfirmModal: ({
        confirmLabel,
        isOpen,
        message,
        onCancel,
        onConfirm,
        title,
    }: {
        confirmLabel: string;
        isOpen: boolean;
        message: string;
        onCancel: () => void;
        onConfirm: () => void;
        title: string;
    }) =>
        isOpen ? (
            <section data-testid="confirm-modal">
                <h2>{title}</h2>
                <p>{message}</p>
                <button type="button" onClick={onCancel}>
                    Cancel action
                </button>
                <button type="button" onClick={onConfirm}>
                    {confirmLabel}
                </button>
            </section>
        ) : null,
}));

function mockPullRequests(overrides = {}) {
    hooks.usePullRequests.mockReturnValue({
        data: hooks.pullRequests,
        error: null,
        isLoading: false,
        refetch: hooks.refetch,
    });
    hooks.usePullRequestDeployments.mockReturnValue({
        data: [
            {
                commit: "abc123",
                id: "deploy-1",
                note: "Service restart scheduled",
                status: "restart-scheduled",
                updatedAt: "2026-05-11T00:01:00.000Z",
            },
        ],
    });
    hooks.useProductionCheckout.mockReturnValue({
        data: hooks.productionCheckout,
        error: null,
    });
    hooks.useApprovePullRequest.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.approve,
    });
    hooks.useRejectPullRequest.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.reject,
    });
    hooks.useDeployDashboard.mockReturnValue({
        isPending: false,
        mutateAsync: hooks.deploy,
    });

    for (const [key, value] of Object.entries(overrides)) {
        if (key === "pullRequests") hooks.usePullRequests.mockReturnValue(value);
        if (key === "deployments") hooks.usePullRequestDeployments.mockReturnValue(value);
        if (key === "checkout") hooks.useProductionCheckout.mockReturnValue(value);
        if (key === "approve") hooks.useApprovePullRequest.mockReturnValue(value);
        if (key === "reject") hooks.useRejectPullRequest.mockReturnValue(value);
        if (key === "deploy") hooks.useDeployDashboard.mockReturnValue(value);
    }
}

describe("PullRequests page", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hooks.approve.mockResolvedValue({
            cleanup: { message: "Worktree cleaned" },
            deployment: { note: "Deploy scheduled" },
            message: "PR merged",
        });
        hooks.deploy.mockResolvedValue({
            deployment: { note: "Main deploy scheduled" },
        });
        hooks.refetch.mockResolvedValue(Promise.resolve());
        hooks.reject.mockResolvedValue({
            cleanup: { message: "Review worktree left intact" },
            message: "PR rejected",
        });
        hooks.useApprovePullRequest.mockReset();
        hooks.useDeployDashboard.mockReset();
        hooks.useProductionCheckout.mockReset();
        hooks.usePullRequestDeployments.mockReset();
        hooks.usePullRequests.mockReset();
        hooks.useRejectPullRequest.mockReset();
        mockPullRequests();
    });

    it("renders pull request, checkout, and deployment summaries", () => {
        render(<PullRequests />);

        expect(screen.getByText("Pull requests")).toBeInTheDocument();
        expect(screen.getByText("Add dashboard tests")).toBeInTheDocument();
        expect(screen.getByText("Checks passed")).toBeInTheDocument();
        expect(screen.getByText("Review approved")).toBeInTheDocument();
        expect(screen.getByText("Ready to deploy")).toBeInTheDocument();
        expect(screen.getByText("restart-scheduled")).toBeInTheDocument();
    });

    it("refreshes pull requests from the page action", async () => {
        const user = userEvent.setup();

        render(<PullRequests />);

        await user.click(screen.getByRole("button", { name: "Refresh" }));

        expect(hooks.refetch).toHaveBeenCalledTimes(1);
    });

    it("shows loading, error retry, and empty states", async () => {
        const user = userEvent.setup();
        const { rerender } = render(<PullRequests />);

        mockPullRequests({
            pullRequests: {
                data: [],
                error: null,
                isLoading: true,
                refetch: hooks.refetch,
            },
        });
        rerender(<PullRequests />);
        expect(document.querySelector(".animate-spin")).toBeInTheDocument();

        mockPullRequests({
            pullRequests: {
                data: [],
                error: new Error("GitHub unavailable"),
                isLoading: false,
                refetch: hooks.refetch,
            },
        });
        rerender(<PullRequests />);
        expect(screen.getByText("GitHub unavailable")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(hooks.refetch).toHaveBeenCalledTimes(1);

        mockPullRequests({
            pullRequests: {
                data: [],
                error: null,
                isLoading: false,
                refetch: hooks.refetch,
            },
        });
        rerender(<PullRequests />);
        expect(screen.getByText("No open PRs waiting")).toBeInTheDocument();
    });

    it("confirms merge, merge deploy, reject, and main deploy actions", async () => {
        const user = userEvent.setup();

        render(<PullRequests />);

        await user.click(screen.getByRole("button", { name: "Merge only" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent("Merge PR #10");
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        await waitFor(() => {
            expect(hooks.approve).toHaveBeenCalledWith({ number: 10, deploy: false });
        });
        expect(screen.getByText(/PR merged/)).toBeInTheDocument();
        expect(screen.getByText(/Worktree cleaned/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Merge + deploy" }));
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(hooks.approve).toHaveBeenCalledWith({ number: 10, deploy: true });
        expect(screen.getByText(/Deploy scheduled/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Reject" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent("Reject PR #10");
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(hooks.reject).toHaveBeenCalledWith({ number: 10 });
        expect(screen.getByText(/PR rejected/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Deploy latest main" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent(
            "Deploy latest main"
        );
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(hooks.deploy).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/Main deploy scheduled/)).toBeInTheDocument();
    });

    it("blocks production actions when checkout is dirty", () => {
        mockPullRequests({
            checkout: {
                data: {
                    ...hooks.productionCheckout,
                    isClean: false,
                    isSafeForDeploy: false,
                },
                error: null,
            },
        });

        render(<PullRequests />);

        expect(screen.getByText("Dirty checkout")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Deploy latest main" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Merge only" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Merge + deploy" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Reject" })).not.toBeDisabled();
    });

    it("blocks merge actions for draft Mira PRs", () => {
        mockPullRequests({
            pullRequests: {
                data: [
                    {
                        ...hooks.pullRequests[0],
                        isDraft: true,
                        reviewDecision: "REVIEW_REQUIRED",
                        title: "Draft dashboard change",
                    },
                ],
                error: null,
                isLoading: false,
                refetch: hooks.refetch,
            },
        });

        render(<PullRequests />);

        expect(screen.getByText("Draft")).toBeInTheDocument();
        expect(screen.getByText("Review required")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Merge + deploy" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Merge only" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Reject" })).not.toBeDisabled();
    });

    it("blocks production actions when checkout is off main", () => {
        mockPullRequests({
            checkout: {
                data: {
                    ...hooks.productionCheckout,
                    branch: "fix/gateway-v4-live-streaming",
                    isSafeForDeploy: false,
                },
                error: null,
            },
        });

        render(<PullRequests />);

        expect(screen.getByText("Off main")).toBeInTheDocument();
        expect(
            screen.getByText(/blocked until the production checkout is switched/)
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Deploy latest main" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Merge only" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Merge + deploy" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Reject" })).not.toBeDisabled();
    });

    it("shows action errors from failed mutations", async () => {
        const user = userEvent.setup();
        hooks.approve.mockRejectedValueOnce(new Error("Merge failed"));

        render(<PullRequests />);

        await user.click(screen.getByRole("button", { name: "Merge only" }));
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(await screen.findByText("Merge failed")).toBeInTheDocument();
    });

    it("summarizes checkout edge states, missing deploys, and check outcomes", () => {
        mockPullRequests({
            checkout: {
                data: {
                    ...hooks.productionCheckout,
                    branch: "feature-branch",
                    isSafeForDeploy: false,
                },
                error: null,
            },
            deployments: { data: [] },
            pullRequests: {
                data: [
                    {
                        ...hooks.pullRequests[0],
                        body: "",
                        mergeStateStatus: "BLOCKED",
                        mergeable: "CONFLICTING",
                        number: 11,
                        reviewDecision: "CHANGES_REQUESTED",
                        statusCheckRollup: [{ conclusion: "FAILURE", name: "ci" }],
                        title: "Needs work",
                    },
                    {
                        ...hooks.pullRequests[0],
                        mergeStateStatus: "UNKNOWN",
                        mergeable: "UNKNOWN",
                        number: 12,
                        reviewDecision: "REVIEW_REQUIRED",
                        statusCheckRollup: [{ status: "IN_PROGRESS", name: "ci" }],
                        title: "Still running",
                    },
                    {
                        ...hooks.pullRequests[0],
                        number: 13,
                        statusCheckRollup: [],
                        title: "No checks yet",
                    },
                ],
                error: null,
                isLoading: false,
                refetch: hooks.refetch,
            },
        });

        render(<PullRequests />);

        expect(screen.getByText("Off main")).toBeInTheDocument();
        expect(
            screen.getByText(/checkout is switched from feature-branch/)
        ).toBeInTheDocument();
        expect(
            screen.getByText("No dashboard deploy jobs recorded yet.")
        ).toBeInTheDocument();
        expect(screen.getByText("Checks failed")).toBeInTheDocument();
        expect(screen.getByText("Checks running")).toBeInTheDocument();
        expect(screen.getByText("No CI checks")).toBeInTheDocument();
        expect(screen.getByText("Changes requested")).toBeInTheDocument();
        expect(screen.getByText("Review required")).toBeInTheDocument();
        expect(screen.getByText("CONFLICTING")).toBeInTheDocument();
        expect(screen.getByText("BLOCKED")).toBeInTheDocument();
    });

    it("shows production checkout loading and wrong-root errors", () => {
        const { rerender } = render(<PullRequests />);

        mockPullRequests({
            checkout: { data: undefined, error: null },
        });
        rerender(<PullRequests />);
        expect(screen.getByText("Checking production checkout")).toBeInTheDocument();
        expect(screen.getByText("Loading checkout status…")).toBeInTheDocument();

        mockPullRequests({
            checkout: {
                data: {
                    ...hooks.productionCheckout,
                    isProductionRoot: false,
                    isSafeForDeploy: false,
                    root: "/tmp/wrong",
                },
                error: null,
            },
        });
        rerender(<PullRequests />);
        expect(screen.getByText("Wrong root")).toBeInTheDocument();
        expect(screen.getByText(/not operating on/)).toBeInTheDocument();

        mockPullRequests({
            checkout: { data: undefined, error: new Error("Checkout unavailable") },
        });
        rerender(<PullRequests />);
        expect(screen.getByText("Checkout unavailable")).toBeInTheDocument();
    });

    it("renders external PR author and fallback metadata states", () => {
        mockPullRequests({
            deployments: {
                data: [
                    {
                        commit: "",
                        id: "deploy-ok",
                        note: "",
                        status: "ok",
                        updatedAt: "2026-05-11T00:01:00.000Z",
                    },
                    {
                        commit: "badc0de",
                        id: "deploy-failed",
                        note: "Deploy failed",
                        status: "failed",
                        updatedAt: "2026-05-11T00:02:00.000Z",
                    },
                    {
                        commit: "running",
                        id: "deploy-running",
                        note: "Running deploy",
                        status: "running",
                        updatedAt: "2026-05-11T00:03:00.000Z",
                    },
                ],
            },
            pullRequests: {
                data: [
                    {
                        additions: null,
                        author: { login: "app/dependabot" },
                        baseRefName: "main",
                        body: String.raw`[Docs](https://example.com)\nLine two`,
                        changedFiles: null,
                        deletions: null,
                        headRefName: "deps/react",
                        mergeStateStatus: "UNSTABLE",
                        mergeable: "DIRTY",
                        number: 20,
                        statusCheckRollup: [null, "bad", { status: "QUEUED" }],
                        title: "Bump React",
                        updatedAt: "2026-05-11T00:00:00.000Z",
                        url: "https://github.com/rajohan/Mira-Dashboard/pull/20",
                    },
                    {
                        ...hooks.pullRequests[0],
                        author: null,
                        mergeStateStatus: "MYSTERY",
                        mergeable: undefined,
                        number: 21,
                        statusCheckRollup: undefined,
                        title: "External unknown author",
                    },
                ],
                error: null,
                isLoading: false,
                refetch: hooks.refetch,
            },
        });

        render(<PullRequests />);

        expect(screen.getByText("Dependency / external PRs")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
            "target",
            "_blank"
        );
        expect(screen.getByText("Line two")).toBeInTheDocument();
        expect(screen.getByText("Dependabot")).toBeInTheDocument();
        expect(screen.getByText("Unknown author")).toBeInTheDocument();
        expect(screen.getByText("DIRTY")).toBeInTheDocument();
        expect(screen.getByText("UNSTABLE")).toBeInTheDocument();
        expect(screen.getByText("mergeable unknown")).toBeInTheDocument();
        expect(screen.getByText("MYSTERY")).toBeInTheDocument();
        expect(screen.getByText("Checks running")).toBeInTheDocument();
        expect(screen.getByText("deploy-ok")).toBeInTheDocument();
        expect(screen.getByText("failed")).toBeInTheDocument();
        expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(1);
    });

    it("handles confirmation cancellation and non-Error mutation failures", async () => {
        const user = userEvent.setup();
        hooks.reject.mockRejectedValueOnce("nope");

        render(<PullRequests />);

        await user.click(screen.getByRole("button", { name: "Merge only" }));
        await user.click(screen.getByRole("button", { name: "Cancel action" }));
        expect(screen.queryByTestId("confirm-modal")).not.toBeInTheDocument();
        expect(hooks.approve).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Reject" }));
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(await screen.findByText("Action failed")).toBeInTheDocument();
    });

    it("uses action result fallbacks when cleanup or deploy notes are absent", async () => {
        const user = userEvent.setup();
        hooks.approve.mockResolvedValueOnce({ message: "Merged without cleanup" });
        hooks.approve.mockResolvedValueOnce({
            cleanup: undefined,
            deployment: undefined,
            message: "Merged and deployed fallback",
        });
        hooks.deploy.mockResolvedValueOnce({ deployment: {} });

        render(<PullRequests />);

        await user.click(screen.getByRole("button", { name: "Merge only" }));
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(await screen.findByText("Merged without cleanup")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Merge + deploy" }));
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(
            await screen.findByText("Merged and deployed fallback")
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Deploy latest main" }));
        await user.click(
            screen.getByTestId("confirm-modal").querySelector("button:last-child")!
        );
        expect(await screen.findByText("Deploy scheduled")).toBeInTheDocument();
    });

    it("keeps the confirmation modal open while mutations are pending", async () => {
        const user = userEvent.setup();
        const { rerender } = render(<PullRequests />);

        await user.click(screen.getByRole("button", { name: "Reject" }));
        expect(screen.getByTestId("confirm-modal")).toHaveTextContent("Reject PR #10");

        mockPullRequests({
            approve: { isPending: true, mutateAsync: hooks.approve },
        });
        rerender(<PullRequests />);

        await user.click(screen.getByRole("button", { name: "Cancel action" }));
        expect(screen.getByTestId("confirm-modal")).toBeInTheDocument();
    });
});
