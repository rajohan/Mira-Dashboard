import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";
import { act } from "react";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import { stubGlobal } from "../test/testUtils";
import {
    pullRequestKeys,
    useApprovePullRequest,
    useApprovePullRequestReview,
    useDeployDashboard,
    useProductionCheckout,
    usePullRequestDeployments,
    usePullRequests,
    useRejectPullRequest,
    useUpdatePullRequestBranch,
} from "./usePullRequests";

describe("pull request hooks", () => {
    it("fetches PR, deployment and checkout queries", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ pullRequests: [{ number: 10, title: "Tests" }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ deployments: [{ id: "deploy-1" }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ checkout: { branch: "main" } }),
            });
        stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: prs } = renderHook(() => usePullRequests(), { wrapper });
        await waitFor(() => expect(prs.current.data?.[0]?.number).toBe(10));

        const { result: deployments } = renderHook(() => usePullRequestDeployments(), {
            wrapper,
        });
        await waitFor(() => expect(deployments.current.data?.[0]?.id).toBe("deploy-1"));

        const { result: checkout } = renderHook(() => useProductionCheckout(), {
            wrapper,
        });
        await waitFor(() => expect(checkout.current.data?.branch).toBe("main"));

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/pull-requests",
            expect.any(Object)
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/pull-requests/deployments",
            expect.any(Object)
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/pull-requests/production-checkout",
            expect.any(Object)
        );
    });

    it("posts PR actions and invalidates related queries", async () => {
        const fetchMock = jest
            .fn()
            .mockImplementation(async (input: RequestInfo | URL) => {
                const url = String(input);
                return {
                    ok: true,
                    status: 200,
                    json: async () =>
                        url.endsWith("/10/review-approval")
                            ? {
                                  ok: true,
                                  pullRequest: {
                                      number: 10,
                                      reviewDecision: "APPROVED",
                                      title: "Approved",
                                  },
                              }
                            : url.endsWith("/10/update-branch")
                              ? {
                                    ok: true,
                                    pullRequest: {
                                        number: 11,
                                        reviewDecision: "REVIEW_REQUIRED",
                                        title: "Updated branch",
                                    },
                                }
                              : { ok: true },
                };
            });
        stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);
        queryClient.setQueryData(pullRequestKeys.list(), [
            { number: 10, reviewDecision: "REVIEW_REQUIRED", title: "Old" },
            { number: 11, reviewDecision: "REVIEW_REQUIRED", title: "Unchanged" },
        ]);

        const { result: approve } = renderHook(() => useApprovePullRequest(), {
            wrapper,
        });
        const { result: reviewApprove } = renderHook(
            () => useApprovePullRequestReview(),
            {
                wrapper,
            }
        );
        const { result: updateBranch } = renderHook(() => useUpdatePullRequestBranch(), {
            wrapper,
        });
        const { result: reject } = renderHook(() => useRejectPullRequest(), { wrapper });
        const { result: deploy } = renderHook(() => useDeployDashboard(), { wrapper });

        await act(async () => {
            await approve.current.mutateAsync({ number: 10, deploy: true });
            await reviewApprove.current.mutateAsync({ number: 10 });
            await reviewApprove.current.mutateAsync({ number: 11 });
            await updateBranch.current.mutateAsync({ number: 10 });
            await reject.current.mutateAsync({ number: 10, comment: "Needs work" });
            await deploy.current.mutateAsync();
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/pull-requests/10/approve",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ deploy: true }),
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/pull-requests/10/review-approval",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({}),
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/pull-requests/11/review-approval",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({}),
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            4,
            "/api/pull-requests/10/update-branch",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({}),
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            5,
            "/api/pull-requests/10/reject",
            expect.objectContaining({ body: JSON.stringify({ comment: "Needs work" }) })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            6,
            "/api/pull-requests/deploy",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: pullRequestKeys.list() });
        expect(invalidateSpy).toHaveBeenCalledWith({
            queryKey: pullRequestKeys.deployments(),
        });
        expect(invalidateSpy).toHaveBeenCalledWith({
            queryKey: pullRequestKeys.productionCheckout(),
        });
        expect(queryClient.getQueryData<unknown>(pullRequestKeys.list())).toEqual([
            { number: 10, reviewDecision: "APPROVED", title: "Approved" },
            { number: 11, reviewDecision: "REVIEW_REQUIRED", title: "Updated branch" },
        ]);
    });

    it("updates a missing pull request cache when GitHub returns a branch result", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                ok: true,
                pullRequest: { number: 12, title: "Branch updated" },
            }),
        });
        stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const wrapper = createQueryWrapper(queryClient);
        const { result } = renderHook(() => useUpdatePullRequestBranch(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({ number: 12 });
        });

        expect(queryClient.getQueryData<unknown>(pullRequestKeys.list())).toEqual([]);
    });

    it("invalidates pull requests when branch updates return no pull request", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);
        queryClient.setQueryData(pullRequestKeys.list(), [
            { number: 12, title: "Existing branch" },
        ]);
        const { result } = renderHook(() => useUpdatePullRequestBranch(), { wrapper });

        await act(async () => {
            await result.current.mutateAsync({ number: 12 });
        });

        expect(queryClient.getQueryData<unknown>(pullRequestKeys.list())).toEqual([
            { number: 12, title: "Existing branch" },
        ]);
        expect(invalidateSpy).toHaveBeenCalledWith({
            queryKey: pullRequestKeys.list(),
        });
    });
});
