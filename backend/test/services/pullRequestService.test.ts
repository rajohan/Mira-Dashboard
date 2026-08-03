import { describe, expect, it, jest } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { database } from "../../src/database/connection.ts";
import * as processModule from "../../src/lib/processes.ts";
import { apiErrorExpectation } from "../support/apiErrorExpectation.ts";
import { captureRejection } from "../support/rejections.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
describe("backend pull request services", () => {
    const {
        cleanupCallbacks,
        createTemporaryRoot,
        expectedStackHeadsThrough,
        readableUtf8Stream,
        rememberEnvironment,
        routeRequest,
        stackPullRequestSummary,
        startTestScheduledExecutor,
        writeFakeGh,
        writeFakeGhForNativeStackReviewApproval,
        writeFakeGhForPullRequestActions,
        writeFakeGhForPullRequestMerge,
        writeFakeGhForPullRequestStackCreation,
        writeFakeGhForPullRequestStackMerge,
        writeFakeGhForPullRequestValidation,
        writeFakeGhWithPaginatedPullRequests,
        writeFakeGhWithoutStackGraphqlFields,
        writeFakeGit,
        writeFakeGitForPullRequestStackMerge,
    } = createServiceBehaviorHarness();
    it("reports production checkout readiness through git command output", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-status-root-");
        const fakeBin = createTemporaryRoot("mira-pr-status-bin-");
        writeFakeGit(path.join(fakeBin, "git"), fakeRoot);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(fakeRoot, "worktrees");
        const { getProductionCheckoutStatus, ensureProductionReadyForDeploy } =
            await import("../../src/services/pullRequests/worktreeManager.ts");
        const status = await getProductionCheckoutStatus();
        expect(status).toMatchObject({
            root: fakeRoot,
            expectedRoot: fakeRoot,
            branch: "main",
            expectedBranch: "main",
            head: "abc1234a",
            headCommit: "abc1234abc1234abc1234abc1234abc1234abc12",
            upstream: "origin/main",
            isClean: true,
            isProductionRoot: true,
            isSafeForDeploy: true,
        });
        expect(ensureProductionReadyForDeploy()).resolves.toBeUndefined();
    });
    it("rejects unsafe production checkout states before deploy work starts", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-unsafe-root-");
        const actualRoot = path.join(fakeRoot, "actual");
        const expectedRoot = path.join(fakeRoot, "expected");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-unsafe-bin-");
        mkdirSync(expectedRoot, {
            recursive: true,
        });
        mkdirSync(worktreeRoot, {
            recursive: true,
        });
        writeFileSync(
            path.join(fakeBin, "git"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(actualRoot)}
elif [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'feature\n'
elif [[ "$*" == "rev-parse HEAD" ]]; then
  printf 'badc0debadc0debadc0debadc0debadc0debadc0\n'
elif [[ "$*" == "rev-parse --abbrev-ref --symbolic-full-name ${"@{u}"}" ]]; then
  exit 1
elif [[ "$1" == "status" ]]; then
  printf ' M backend/src/server.ts\n'
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
        );
        chmodSync(path.join(fakeBin, "git"), 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = expectedRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        const {
            ensureProductionCheckout,
            ensureProductionReadyForDeploy,
            getProductionCheckoutStatus,
        } = await import("../../src/services/pullRequests/worktreeManager.ts");
        expect(getProductionCheckoutStatus()).resolves.toMatchObject({
            branch: "feature",
            isClean: false,
            isProductionRoot: false,
            isSafeForDeploy: false,
            root: actualRoot,
            statusShort: "M backend/src/server.ts",
            upstream: undefined,
        });
        expect(ensureProductionCheckout()).rejects.toThrow(
            "Expected production checkout"
        );
        expect(ensureProductionReadyForDeploy()).rejects.toThrow(
            "Production checkout must be clean main before deploy"
        );
    });
    it("lists pull requests from GitHub JSON lines and refreshes blocked merge state", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-list-root-");
        const fakeBin = createTemporaryRoot("mira-pr-list-bin-");
        writeFakeGh(path.join(fakeBin, "gh"));
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        const {
            isDashboardPullRequestOpen,
            listDashboardPullRequests,
            validatePrNumber,
        } = await import("../../src/services/pullRequests/githubPullRequestListing.ts");
        const pullRequests = await listDashboardPullRequests();
        expect(pullRequests.map((pullRequest) => pullRequest.number)).toEqual([
            4, 3, 2, 1, 5,
        ]);
        expect(pullRequests[0]).toMatchObject({
            baseRefName: "ready",
            canReviewerApprove: true,
            number: 4,
            previewEligible: false,
            reviewerApproved: false,
            stack: {
                baseRefName: "main",
                number: 42,
                position: 2,
                size: 2,
            },
        });
        expect(pullRequests[1]?.author).toBeUndefined();
        expect(pullRequests[2]).toMatchObject({
            number: 2,
            title: "Blocked refreshed PR",
            headRefOid: "head2b",
            reviewerApproved: true,
            canReviewerApprove: false,
        });
        expect(pullRequests[3]).toMatchObject({
            number: 1,
            reviewerApproved: true,
            canReviewerApprove: false,
            stack: {
                baseRefName: "main",
                number: 42,
                position: 1,
                size: 2,
            },
        });
        expect(pullRequests[4]).toMatchObject({
            canReviewerApprove: true,
            isCrossRepository: true,
            number: 5,
            previewEligible: false,
            reviewerApproved: false,
        });
        expect(isDashboardPullRequestOpen(2)).resolves.toBe(true);
        expect(isDashboardPullRequestOpen(99)).resolves.toBe(false);
        expect(validatePrNumber("42")).toBe(42);
        for (const value of ["0", "-1", "1.5", "abc", 1]) {
            expect(() => validatePrNumber(value)).toThrow("Invalid pull request number");
        }
    });
    it("keeps ordinary Delivery PR listing available without preview stack fields", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-list-fallback-root-");
        const fakeBin = createTemporaryRoot("mira-pr-list-fallback-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        writeFakeGhWithoutStackGraphqlFields(path.join(fakeBin, "gh"), ghLog);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        const { listDashboardPullRequests } =
            await import("../../src/services/pullRequests/githubPullRequestListing.ts");
        const pullRequests = await listDashboardPullRequests();
        expect(pullRequests).toEqual([
            expect.objectContaining({
                number: 31,
                title: "Fallback PR",
            }),
        ]);
        expect(await listDashboardPullRequests()).toEqual(pullRequests);
        expect(pullRequests[0]?.stack).toBeUndefined();
        const ghCommands = await Bun.file(ghLog).text();
        expect(ghCommands.match(/api graphql/gu)).toHaveLength(3);
        expect(ghCommands.match(/__type\(name: "PullRequest"\)/gu)).toHaveLength(1);
        expect(ghCommands).toContain('__type(name: "PullRequest")');
        expect(ghCommands).not.toContain("stackEntry");
    });
    it("lists ordinary pull requests when the optional stack capability probe fails", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-list-probe-failure-root-");
        const fakeBin = createTemporaryRoot("mira-pr-list-probe-failure-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        writeFakeGhWithoutStackGraphqlFields(path.join(fakeBin, "gh"), ghLog, true);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        const { listDashboardPullRequests } =
            await import("../../src/services/pullRequests/githubPullRequestListing.ts");
        const pullRequests = await listDashboardPullRequests();
        expect(pullRequests).toEqual([
            expect.objectContaining({
                number: 31,
                title: "Fallback PR",
            }),
        ]);
        expect(await listDashboardPullRequests()).toEqual(pullRequests);
        expect(pullRequests[0]?.stack).toBeUndefined();
        const ghCommands = await Bun.file(ghLog).text();
        expect(ghCommands.match(/api graphql/gu)).toHaveLength(3);
        expect(ghCommands.match(/__type\(name: "PullRequest"\)/gu)).toHaveLength(1);
        expect(ghCommands).not.toContain("stackEntry");
    });
    it("paginates the bounded open pull request listing beyond 100 rows", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-list-pagination-root-");
        const fakeBin = createTemporaryRoot("mira-pr-list-pagination-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        writeFakeGhWithPaginatedPullRequests(path.join(fakeBin, "gh"), ghLog);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        const { listDashboardPullRequests } =
            await import("../../src/services/pullRequests/githubPullRequestListing.ts");
        const pullRequests = await listDashboardPullRequests();
        expect(pullRequests).toHaveLength(101);
        expect(pullRequests.map((pullRequest) => pullRequest.number)).toContain(101);
        const ghCommands = await Bun.file(ghLog).text();
        expect(ghCommands).toContain("-F endCursor=cursor-100");
        expect(ghCommands.match(/api graphql/gu)).toHaveLength(3);
    });
    it("creates a native GitHub stack only from an existing linear PR chain", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-stack-create-root-");
        const fakeBin = createTemporaryRoot("mira-pr-stack-create-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        writeFakeGhForPullRequestStackCreation(path.join(fakeBin, "gh"), ghLog);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        const { createPullRequestStack } =
            await import("../../src/services/pullRequests/githubStackClient.ts");
        const creation = await createPullRequestStack([21, 22]);
        expect(creation).toEqual({
            isOk: true,
            message: "GitHub stack #500 created with 2 PRs",
        });
        const ghCommands = await Bun.file(ghLog).text();
        expect(ghCommands).toContain("api -X POST repos/rajohan/Mira-Dashboard/stacks");
        expect(ghCommands).toContain("pull_requests[]=21");
        expect(ghCommands).toContain("pull_requests[]=22");
        expect(
            await captureRejection(() => createPullRequestStack([22, 21]))
        ).toMatchObject({
            message: "The bottom pull request must target main",
        });
        expect(
            await captureRejection(() => createPullRequestStack([21, 21]))
        ).toMatchObject({
            message: "A stack cannot contain duplicate pull requests",
        });
        expect(
            await captureRejection(() => createPullRequestStack([21, 23]))
        ).toMatchObject({
            message: "PR #23 is not an open pull request in this repository",
        });
        writeFakeGhForPullRequestStackCreation(path.join(fakeBin, "gh"), ghLog, {
            existingStackNumber: 499,
        });
        expect(
            await captureRejection(() => createPullRequestStack([21, 22]))
        ).toMatchObject({
            message: "PR #21 already belongs to GitHub stack #499",
        });
        writeFakeGhForPullRequestStackCreation(path.join(fakeBin, "gh"), ghLog, {
            topBaseRefName: "another-branch",
        });
        expect(
            await captureRejection(() => createPullRequestStack([21, 22]))
        ).toMatchObject({
            message: "PR #22 must target stack-create-bottom",
        });
        writeFakeGhForPullRequestStackCreation(path.join(fakeBin, "gh"), ghLog, {
            ambiguousChild: true,
        });
        expect(
            await captureRejection(() => createPullRequestStack([21, 22]))
        ).toMatchObject({
            message:
                "PR #21 has multiple open dependent pull requests; only a complete linear chain can become a GitHub stack",
            statusCode: 409,
        });
        writeFakeGhForPullRequestStackCreation(path.join(fakeBin, "gh"), ghLog, {
            continuation: true,
        });
        expect(
            await captureRejection(() => createPullRequestStack([21, 22]))
        ).toMatchObject({
            message: "PR #24 depends on PR #22 and must be included in the GitHub stack",
            statusCode: 409,
        });
        writeFakeGhForPullRequestStackCreation(path.join(fakeBin, "gh"), ghLog, {
            bottomIsCrossRepository: true,
        });
        expect(
            await captureRejection(() => createPullRequestStack([21, 22]))
        ).toMatchObject({
            message: "PR #21 is cross-repository and cannot join a GitHub stack",
            statusCode: 409,
        });
        writeFakeGhForPullRequestStackCreation(path.join(fakeBin, "gh"), ghLog, {
            apiUnavailable: true,
        });
        expect(
            await captureRejection(() => createPullRequestStack([21, 22]))
        ).toMatchObject({
            message: "GitHub stacks are not enabled for this repository or token",
        });
    });
    it("revalidates every native stack layer before starting its preview", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-stack-preview-scope-root-");
        const fakeBin = createTemporaryRoot("mira-pr-stack-preview-scope-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        writeFakeGhForPullRequestStackMerge(path.join(fakeBin, "gh"), ghLog, "merged");
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        const { validatePullRequestPreviewScope } =
            await import("../../src/services/pullRequests/githubStackClient.ts");
        const scope = [
            stackPullRequestSummary(11),
            stackPullRequestSummary(12),
            stackPullRequestSummary(13),
        ];
        expect(await validatePullRequestPreviewScope(scope[2]!, scope)).toBeUndefined();
        const draftScope = [
            scope[0]!,
            scope[1]!,
            {
                ...scope[2]!,
                isDraft: true,
            },
        ];
        expect(
            await validatePullRequestPreviewScope(draftScope[2]!, draftScope)
        ).toBeUndefined();
        expect(
            await validatePullRequestPreviewScope(
                {
                    ...scope[2]!,
                    stack: undefined,
                },
                scope
            )
        ).toBeUndefined();
        expect(
            await captureRejection(() =>
                validatePullRequestPreviewScope(scope[2]!, [
                    {
                        ...scope[0]!,
                        headRefOid: "9".repeat(40),
                    },
                    scope[1]!,
                    scope[2]!,
                ])
            )
        ).toMatchObject({
            message: "PR #11 changed while Delivery loaded the stack preview",
        });
        expect(
            await captureRejection(() =>
                validatePullRequestPreviewScope(scope[2]!, [scope[0]!, scope[2]!])
            )
        ).toMatchObject({
            message: "PR #12 changed while Delivery loaded the stack preview",
        });
        writeFakeGhForPullRequestStackMerge(
            path.join(fakeBin, "gh"),
            ghLog,
            "merged",
            13,
            {
                closedNumber: 12,
            }
        );
        expect(
            await captureRejection(() =>
                validatePullRequestPreviewScope(scope[2]!, scope)
            )
        ).toMatchObject({
            message: "PR #12 is closed and blocks this stack preview",
        });
    });
    it("excludes fork pull requests from inferred preview stack ancestry", async () => {
        const { pullRequestPreviewScope } =
            await import("../../src/services/pullRequests/reviewPolicy.ts");
        const forkBottom = stackPullRequestSummary(11, {
            headRefName: "shared-base",
            isCrossRepository: true,
            stack: undefined,
        });
        const child = stackPullRequestSummary(12, {
            baseRefName: "shared-base",
            headRefName: "same-repository-child",
            stack: undefined,
        });
        expect(pullRequestPreviewScope(child, [forkBottom, child])).toBeUndefined();
        expect(
            pullRequestPreviewScope(child, [
                {
                    ...forkBottom,
                    isCrossRepository: false,
                },
                child,
            ])?.map((pullRequest) => pullRequest.number)
        ).toEqual([11, 12]);
    });
    it("allows review approval on an upper linear stack candidate", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("RAJOHAN_GITHUB_TOKEN");
        const fakeRoot = createTemporaryRoot("mira-pr-candidate-review-root-");
        const fakeBin = createTemporaryRoot("mira-pr-candidate-review-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        writeFakeGhForPullRequestStackCreation(path.join(fakeBin, "gh"), ghLog);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.RAJOHAN_GITHUB_TOKEN = "test-review-token";
        const { approvePullRequestReview, listDashboardPullRequests } = await Promise.all(
            [
                import("../../src/services/pullRequests/actionService.ts"),
                import("../../src/services/pullRequests/githubPullRequestListing.ts"),
            ]
        ).then(([module0, module1]) => ({
            approvePullRequestReview: module0.approvePullRequestReview,
            listDashboardPullRequests: module1.listDashboardPullRequests,
        }));
        const pullRequests = await listDashboardPullRequests();
        const candidate = pullRequests.find((pullRequest) => pullRequest.number === 22);
        expect(candidate).toMatchObject({
            canReviewerApprove: true,
            previewEligible: true,
        });
        const result = await approvePullRequestReview(22);
        expect(result).toMatchObject({
            isOk: true,
            message: "PR #22 review approved",
            pullRequest: {
                number: 22,
                previewEligible: true,
            },
        });
        expect(await Bun.file(ghLog).text()).toContain(
            "pr review 22 --approve --repo rajohan/Mira-Dashboard"
        );
    });
    it("allows review approval on an upper native GitHub stack layer", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("RAJOHAN_GITHUB_TOKEN");
        const fakeRoot = createTemporaryRoot("mira-pr-native-stack-review-root-");
        const fakeBin = createTemporaryRoot("mira-pr-native-stack-review-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        writeFakeGhForNativeStackReviewApproval(path.join(fakeBin, "gh"), ghLog);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.RAJOHAN_GITHUB_TOKEN = "test-review-token";
        const { approvePullRequestReview } =
            await import("../../src/services/pullRequests/actionService.ts");
        const result = await approvePullRequestReview(12);
        expect(result).toMatchObject({
            isOk: true,
            message: "PR #12 review approved",
            pullRequest: {
                canReviewerApprove: false,
                number: 12,
                previewEligible: true,
                reviewerApproved: true,
                stack: {
                    number: 360,
                    position: 2,
                    size: 2,
                },
            },
        });
        expect(await Bun.file(ghLog).text()).toContain(
            "pr review 12 --approve --repo rajohan/Mira-Dashboard"
        );
    });
    it("drives pull request review, branch update, and reject actions through fake GitHub CLI", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        rememberEnvironment("RAJOHAN_GITHUB_TOKEN");
        const fakeRoot = createTemporaryRoot("mira-pr-actions-root-");
        const fakeBin = createTemporaryRoot("mira-pr-actions-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        writeFakeGhForPullRequestActions(path.join(fakeBin, "gh"), ghLog);
        writeFileSync(
            path.join(fakeBin, "git"),
            `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "worktree list --porcelain" ]]; then
  printf ''
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
        );
        chmodSync(path.join(fakeBin, "git"), 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(fakeRoot, "worktrees");
        process.env.RAJOHAN_GITHUB_TOKEN = "review-token";
        const {
            approvePullRequestReview,
            registerPullRequestExecutionActions,
            rejectPullRequest,
            updatePullRequestBranch,
        } = await Promise.all([
            import("../../src/services/pullRequests/actionService.ts"),
            import("../../src/services/pullRequests/executionActions.ts"),
        ]).then(([module0, module1]) => ({
            approvePullRequestReview: module0.approvePullRequestReview,
            registerPullRequestExecutionActions:
                module1.registerPullRequestExecutionActions,
            rejectPullRequest: module0.rejectPullRequest,
            updatePullRequestBranch: module0.updatePullRequestBranch,
        }));
        registerPullRequestExecutionActions();
        cleanupCallbacks.push(() => {
            database
                .prepare(`DELETE FROM job_executions
                     WHERE action_key IN (
                         'github.review-approval',
                         'github.update-branch',
                         'github.reject'
                     )`)
                .run();
        });
        await startTestScheduledExecutor();
        const { pullRequestRoutes } =
            await import("../../src/routes/pullRequestRoutes.ts");
        expect(approvePullRequestReview(3)).resolves.toMatchObject({
            isOk: true,
            message: "PR #3 review approved",
            pullRequest: {
                canReviewerApprove: true,
                number: 3,
                reviewerApproved: false,
            },
        });
        expect(updatePullRequestBranch(4)).resolves.toMatchObject({
            isOk: true,
            message: "PR #4 branch update started",
            pullRequest: {
                number: 4,
            },
        });
        expect(rejectPullRequest(5, "Not ready")).resolves.toMatchObject({
            cleanup: {
                branch: "close-branch",
                status: "skipped",
            },
            isOk: true,
            message: "PR #5 closed",
            previewCleanup: {
                number: 5,
                status: "skipped",
            },
        });
        const reviewRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/review-approval"
        ].POST(
            routeRequest("/api/pull-requests/3/review-approval", {
                number: "3",
            })
        );
        expect(reviewRoute.json()).resolves.toMatchObject({
            isOk: true,
            message: "PR #3 review approved",
        });
        const updateRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/update-branch"
        ].POST(
            routeRequest("/api/pull-requests/4/update-branch", {
                number: "4",
            })
        );
        expect(updateRoute.json()).resolves.toMatchObject({
            isOk: true,
            message: "PR #4 branch update started",
        });
        const rejectRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/reject"
        ].POST(
            routeRequest(
                "/api/pull-requests/5/reject",
                {
                    number: "5",
                },
                {
                    body: JSON.stringify({
                        comment: "Not ready",
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                }
            )
        );
        expect(rejectRoute.json()).resolves.toMatchObject({
            isOk: true,
            message: "PR #5 closed",
        });
        const defaultRejectRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/reject"
        ].POST(
            routeRequest("/api/pull-requests/5/reject", {
                number: "5",
            })
        );
        expect(defaultRejectRoute.json()).resolves.toMatchObject({
            isOk: true,
            message: "PR #5 closed",
        });
        const queuedMutations = database
            .prepare(`SELECT action_key AS actionKey, cancellable, status
                 FROM job_executions
                 WHERE action_key IN (
                     'github.review-approval',
                     'github.update-branch',
                     'github.reject'
                 )
                 ORDER BY action_key, id`)
            .all() as Array<{
            actionKey: string;
            cancellable: number;
            status: string;
        }>;
        expect(queuedMutations.map((execution) => execution.actionKey)).toEqual([
            "github.reject",
            "github.reject",
            "github.review-approval",
            "github.update-branch",
        ]);
        expect(
            queuedMutations.every(
                (execution) =>
                    execution.cancellable === 0 && execution.status === "success"
            )
        ).toBe(true);
        const malformedApproveRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/approve"
        ].POST(
            routeRequest(
                "/api/pull-requests/3/approve",
                {
                    number: "3",
                },
                {
                    body: "{",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                }
            )
        );
        expect(malformedApproveRoute.status).toBe(400);
        expect(malformedApproveRoute.json()).resolves.toMatchObject(
            apiErrorExpectation(expect.stringContaining("JSON"))
        );
        const missingApproveHeadRoute = await pullRequestRoutes[
            "/api/pull-requests/:number/approve"
        ].POST(
            routeRequest(
                "/api/pull-requests/3/approve",
                {
                    number: "3",
                },
                {
                    body: JSON.stringify({
                        deploy: false,
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "POST",
                }
            )
        );
        expect(missingApproveHeadRoute.status).toBe(400);
        expect(await missingApproveHeadRoute.json()).toMatchObject({
            error: {
                code: "invalid_request",
                details: {
                    issues: [
                        {
                            path: "body.expectedHeadSha",
                        },
                    ],
                },
            },
        });
        expect(Bun.file(ghLog).text()).resolves.toContain("pr review 3");
        expect(Bun.file(ghLog).text()).resolves.toContain(
            "repos/rajohan/Mira-Dashboard/pulls/4/update-branch"
        );
        expect(Bun.file(ghLog).text()).resolves.toContain("pr close 5");
        expect(Bun.file(ghLog).text()).resolves.toContain(
            "Closed from Mira Dashboard after Rajohan rejected it."
        );
    });
    it("merges an approved pull request and removes its clean local worktree safely", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-merge-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const localWorktree = path.join(worktreeRoot, "merge-branch");
        const fakeBin = createTemporaryRoot("mira-pr-merge-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        mkdirSync(localWorktree, {
            recursive: true,
        });
        writeFakeGhForPullRequestMerge(path.join(fakeBin, "gh"), ghLog);
        writeFileSync(
            path.join(fakeBin, "git"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(gitLog)}
if [[ "$*" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(fakeRoot)}
elif [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'main\n'
elif [[ "$*" == "rev-parse HEAD" ]]; then
  printf 'abc1234abc1234abc1234abc1234abc1234abc12\n'
elif [[ "$*" == "rev-parse --short HEAD" ]]; then
  printf 'abc1234\n'
elif [[ "$*" == "rev-parse --abbrev-ref --symbolic-full-name ${"@{u}"}" ]]; then
  printf 'origin/main\n'
elif [[ "$*" == "status --short" ]]; then
  printf ''
elif [[ "$*" == "worktree list --porcelain" ]]; then
  printf 'worktree %s\nHEAD abc1234\nbranch refs/heads/merge-branch\n\n' ${JSON.stringify(localWorktree)}
elif [[ "$*" == "-C ${localWorktree} status --short" ]]; then
  printf ''
elif [[ "$*" == "worktree remove ${localWorktree}" ]]; then
  rm -rf ${JSON.stringify(localWorktree)}
elif [[ "$*" == "fetch --prune origin" || "$*" == "checkout main" || "$*" == "pull --ff-only origin main" ]]; then
  printf ''
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
        );
        chmodSync(path.join(fakeBin, "git"), 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        try {
            const {
                approvePullRequest,
                registerPullRequestExecutionActions,
                runPullRequestApproval,
            } = await Promise.all([
                import("../../src/services/pullRequests/mergeService.ts"),
                import("../../src/services/pullRequests/executionActions.ts"),
            ]).then(([module0, module1]) => ({
                approvePullRequest: module0.approvePullRequest,
                registerPullRequestExecutionActions:
                    module1.registerPullRequestExecutionActions,
                runPullRequestApproval: module1.runPullRequestApproval,
            }));
            expect(
                await captureRejection(() =>
                    approvePullRequest(11, false, {
                        expectedHeadSha: "2".repeat(40),
                    })
                )
            ).toMatchObject({
                message:
                    "PR #11 changed after the Delivery page loaded. Refresh before merging",
            });
            registerPullRequestExecutionActions();
            await startTestScheduledExecutor();
            const result = await runPullRequestApproval(11, false, {
                expectedHeadSha: "1".repeat(40),
            });
            expect(result).toMatchObject({
                cleanup: {
                    branch: "merge-branch",
                    message: "Removed local worktree for merge-branch",
                    status: "removed",
                },
                isOk: true,
                message: "PR #11 merged",
                previewCleanup: {
                    number: 11,
                    status: "skipped",
                },
            });
            expect(await Bun.file(ghLog).text()).toContain(
                `pr merge 11 --squash --delete-branch --repo rajohan/Mira-Dashboard --match-head-commit ${"1".repeat(40)}`
            );
            expect(await Bun.file(gitLog).text()).toContain("worktree remove");
            expect(existsSync(localWorktree)).toBe(false);
            expect(
                database
                    .prepare(`SELECT cancellable, status
                         FROM job_executions
                         WHERE action_key = 'github.merge'
                           AND json_extract(payload_json, '$.number') = 11
                         ORDER BY queued_at DESC, id DESC
                         LIMIT 1`)
                    .get()
            ).toEqual({
                cancellable: 0,
                status: "success",
            });
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            database
                .prepare(`DELETE FROM job_executions
                     WHERE action_key = 'github.merge'
                       AND json_extract(payload_json, '$.number') = 11`)
                .run();
            database
                .prepare("DELETE FROM deployment_jobs WHERE id LIKE 'approve-%'")
                .run();
        }
    });
    it("merges a native stack and removes every worktree confirmed in that merge", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-stack-merge-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-stack-merge-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        const branches = ["stack-bottom", "stack-middle", "stack-top"];
        for (const branch of branches) {
            mkdirSync(path.join(worktreeRoot, branch), {
                recursive: true,
            });
        }
        writeFakeGhForPullRequestStackMerge(path.join(fakeBin, "gh"), ghLog, "merged");
        writeFakeGitForPullRequestStackMerge(
            path.join(fakeBin, "git"),
            fakeRoot,
            worktreeRoot,
            gitLog
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        const { approvePullRequest } =
            await import("../../src/services/pullRequests/mergeService.ts");
        expect(
            await captureRejection(() =>
                approvePullRequest(13, false, {
                    expectedHeadSha: "3".repeat(40),
                    mergeStack: true,
                })
            )
        ).toMatchObject({
            message:
                "Native stack merge requires the expected head of every included pull request",
            statusCode: 400,
        });
        const result = await approvePullRequest(13, false, {
            expectedHeadSha: "3".repeat(40),
            expectedStackHeads: expectedStackHeadsThrough(13),
            mergeStack: true,
        });
        expect(result).toMatchObject({
            cleanups: branches.map((branch) => ({
                branch,
                message: `Removed local worktree for ${branch}`,
                status: "removed",
            })),
            isOk: true,
            mergeStatus: "merged",
            message: "Stack #360 merged through PR #13 (3 PRs)",
            previewCleanups: [11, 12, 13].map((number) => ({
                number,
                status: "skipped",
            })),
        });
        for (const branch of branches) {
            expect(existsSync(path.join(worktreeRoot, branch))).toBe(false);
        }
        const ghCommands = await Bun.file(ghLog).text();
        expect(ghCommands).toContain(
            "api -X PUT repos/rajohan/Mira-Dashboard/pulls/13/merge-async"
        );
        expect(ghCommands).toContain("merge_action=default");
        expect(ghCommands).toContain(`sha=${"3".repeat(40)}`);
        const gitCommands = await Bun.file(gitLog).text();
        for (const branch of branches) {
            expect(gitCommands).toContain(
                `worktree remove ${path.join(worktreeRoot, branch)}`
            );
        }
    });
    it("polls pending stack merges and rejects inconsistent asynchronous results", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-stack-async-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-stack-async-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        for (const branch of ["stack-bottom", "stack-middle", "stack-top"]) {
            mkdirSync(path.join(worktreeRoot, branch), {
                recursive: true,
            });
        }
        writeFakeGhForPullRequestStackMerge(
            path.join(fakeBin, "gh"),
            ghLog,
            "pending-merged"
        );
        writeFakeGitForPullRequestStackMerge(
            path.join(fakeBin, "git"),
            fakeRoot,
            worktreeRoot,
            gitLog
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        const { approvePullRequest } =
            await import("../../src/services/pullRequests/mergeService.ts");
        const pendingResult = await approvePullRequest(13, false, {
            expectedHeadSha: "3".repeat(40),
            expectedStackHeads: expectedStackHeadsThrough(13),
            mergeStack: true,
        });
        expect(pendingResult).toMatchObject({
            isOk: true,
            mergeStatus: "merged",
        });
        const pendingCommands = await Bun.file(ghLog).text();
        expect(pendingCommands).toContain("pulls/13/merge-async/merge-uuid");
        writeFakeGhForPullRequestStackMerge(
            path.join(fakeBin, "gh"),
            ghLog,
            "head-mismatch"
        );
        expect(
            await captureRejection(() =>
                approvePullRequest(13, false, {
                    expectedHeadSha: "3".repeat(40),
                    expectedStackHeads: expectedStackHeadsThrough(13),
                    mergeStack: true,
                })
            )
        ).toMatchObject({
            message:
                "PR #13 changed while GitHub accepted the stack merge. Verify the stack state before retrying",
        });
        writeFakeGhForPullRequestStackMerge(
            path.join(fakeBin, "gh"),
            ghLog,
            "pending-missing-id"
        );
        expect(
            await captureRejection(() =>
                approvePullRequest(13, false, {
                    expectedHeadSha: "3".repeat(40),
                    expectedStackHeads: expectedStackHeadsThrough(13),
                    mergeStack: true,
                })
            )
        ).toMatchObject({
            message: "GitHub stack merge returned pending without a result id",
        });
        writeFakeGhForPullRequestStackMerge(
            path.join(fakeBin, "gh"),
            ghLog,
            "pending-options-mismatch"
        );
        expect(
            await captureRejection(() =>
                approvePullRequest(13, false, {
                    expectedHeadSha: "3".repeat(40),
                    expectedStackHeads: expectedStackHeadsThrough(13),
                    mergeStack: true,
                })
            )
        ).toMatchObject({
            message: "PR #13 already has an incompatible pending stack merge request",
        });
        writeFakeGhForPullRequestStackMerge(
            path.join(fakeBin, "gh"),
            ghLog,
            "request-error-merged"
        );
        writeFileSync(gitLog, "");
        for (const branch of ["stack-bottom", "stack-middle", "stack-top"]) {
            mkdirSync(path.join(worktreeRoot, branch), {
                recursive: true,
            });
        }
        expect(
            await captureRejection(() =>
                approvePullRequest(13, false, {
                    expectedHeadSha: "3".repeat(40),
                    expectedStackHeads: expectedStackHeadsThrough(13),
                    mergeStack: true,
                })
            )
        ).toMatchObject({
            message: expect.stringContaining("request interrupted"),
        });
        for (const branch of ["stack-bottom", "stack-middle", "stack-top"]) {
            expect(existsSync(path.join(worktreeRoot, branch))).toBe(true);
        }
        expect(await Bun.file(gitLog).text()).not.toContain("worktree remove");
        writeFileSync(ghLog, "");
        writeFakeGhForPullRequestStackMerge(
            path.join(fakeBin, "gh"),
            ghLog,
            "merged",
            13,
            {
                changedHeadNumber: 11,
            }
        );
        expect(
            await captureRejection(() =>
                approvePullRequest(13, false, {
                    expectedHeadSha: "3".repeat(40),
                    expectedStackHeads: expectedStackHeadsThrough(13),
                    mergeStack: true,
                })
            )
        ).toMatchObject({
            message:
                "PR #11 changed after the Delivery confirmation. Refresh before merging the stack",
        });
        expect(await Bun.file(ghLog).text()).not.toContain("merge-async");
    });
    it("blocks ordinary merge and reject actions for native stack members", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-stack-ordinary-guard-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-stack-ordinary-guard-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        writeFakeGhForPullRequestStackMerge(
            path.join(fakeBin, "gh"),
            ghLog,
            "merged",
            11
        );
        writeFakeGitForPullRequestStackMerge(
            path.join(fakeBin, "git"),
            fakeRoot,
            worktreeRoot,
            gitLog
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        const { approvePullRequest, rejectPullRequest } = await Promise.all([
            import("../../src/services/pullRequests/mergeService.ts"),
            import("../../src/services/pullRequests/actionService.ts"),
        ]).then(([module0, module1]) => ({
            approvePullRequest: module0.approvePullRequest,
            rejectPullRequest: module1.rejectPullRequest,
        }));
        expect(
            await captureRejection(() =>
                approvePullRequest(11, false, {
                    expectedHeadSha: "1".repeat(40),
                    mergeStack: false,
                })
            )
        ).toMatchObject({
            message:
                "PR #11 belongs to GitHub stack #360. Use the stack-aware merge flow",
        });
        expect(
            await captureRejection(() => rejectPullRequest(11, "Not this layer"))
        ).toMatchObject({
            message:
                "PR #11 belongs to GitHub stack #360. Use the stack-aware reject flow",
        });
        const ghCommands = await Bun.file(ghLog).text();
        expect(ghCommands).not.toContain("merge-async");
        expect(ghCommands).not.toContain("pr merge");
        expect(ghCommands).not.toContain("pr close");
    });
    it("blocks ordinary merge and reject actions for stack candidates", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-candidate-guard-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-candidate-guard-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        writeFakeGhForPullRequestMerge(path.join(fakeBin, "gh"), ghLog, [11]);
        writeFakeGitForPullRequestStackMerge(
            path.join(fakeBin, "git"),
            fakeRoot,
            worktreeRoot,
            gitLog
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        const { approvePullRequest, rejectPullRequest } = await Promise.all([
            import("../../src/services/pullRequests/mergeService.ts"),
            import("../../src/services/pullRequests/actionService.ts"),
        ]).then(([module0, module1]) => ({
            approvePullRequest: module0.approvePullRequest,
            rejectPullRequest: module1.rejectPullRequest,
        }));
        expect(
            await approvePullRequest(11, false, {
                expectedHeadSha: "1".repeat(40),
                mergeStack: false,
            })
        ).toMatchObject({
            isOk: true,
            message: "PR #11 merged",
        });
        expect(await Bun.file(ghLog).text()).toContain("pr merge 11");
        writeFileSync(ghLog, "");
        writeFakeGhForPullRequestMerge(path.join(fakeBin, "gh"), ghLog, [12]);
        expect(
            await captureRejection(() =>
                approvePullRequest(11, false, {
                    expectedHeadSha: "1".repeat(40),
                    mergeStack: false,
                })
            )
        ).toMatchObject({
            message:
                "PR #11 has an open dependent pull request. Create or restructure the stack before merge",
        });
        expect(
            await captureRejection(() => rejectPullRequest(11, "Not this chain"))
        ).toMatchObject({
            message:
                "PR #11 has an open dependent pull request. Create or restructure the stack before reject",
        });
        const ghCommands = await Bun.file(ghLog).text();
        expect(ghCommands).not.toContain("pr merge");
        expect(ghCommands).not.toContain("pr close");
    });
    it("does not treat main-targeted pull requests as dependents of a fork head", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-fork-guard-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-fork-guard-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        writeFakeGhForPullRequestMerge(path.join(fakeBin, "gh"), ghLog, [12], {
            headRefName: "main",
            isCrossRepository: true,
        });
        writeFakeGitForPullRequestStackMerge(
            path.join(fakeBin, "git"),
            fakeRoot,
            worktreeRoot,
            gitLog
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        const { approvePullRequest } =
            await import("../../src/services/pullRequests/mergeService.ts");
        expect(
            await approvePullRequest(11, false, {
                expectedHeadSha: "1".repeat(40),
                mergeStack: false,
            })
        ).toMatchObject({
            isOk: true,
            message: "PR #11 merged",
        });
        const ghCommands = await Bun.file(ghLog).text();
        expect(ghCommands).not.toContain("pr list");
        expect(ghCommands).toContain("pr merge 11");
    });
    it("merges from the middle of a native stack and retains worktrees above it", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-stack-middle-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-stack-middle-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        const branches = ["stack-bottom", "stack-middle", "stack-top"];
        for (const branch of branches) {
            mkdirSync(path.join(worktreeRoot, branch), {
                recursive: true,
            });
        }
        writeFakeGhForPullRequestStackMerge(
            path.join(fakeBin, "gh"),
            ghLog,
            "merged",
            12
        );
        writeFakeGitForPullRequestStackMerge(
            path.join(fakeBin, "git"),
            fakeRoot,
            worktreeRoot,
            gitLog
        );
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        const { approvePullRequest } =
            await import("../../src/services/pullRequests/mergeService.ts");
        const result = await approvePullRequest(12, false, {
            expectedHeadSha: "2".repeat(40),
            expectedStackHeads: expectedStackHeadsThrough(12),
            mergeStack: true,
        });
        expect(result).toMatchObject({
            cleanups: [
                {
                    branch: "stack-bottom",
                    status: "removed",
                },
                {
                    branch: "stack-middle",
                    status: "removed",
                },
            ],
            mergeStatus: "merged",
            message: "Stack #360 merged through PR #12 (2 PRs)",
            previewCleanups: [
                {
                    number: 11,
                    status: "skipped",
                },
                {
                    number: 12,
                    status: "skipped",
                },
            ],
        });
        expect(existsSync(path.join(worktreeRoot, "stack-bottom"))).toBe(false);
        expect(existsSync(path.join(worktreeRoot, "stack-middle"))).toBe(false);
        expect(existsSync(path.join(worktreeRoot, "stack-top"))).toBe(true);
        expect(await Bun.file(ghLog).text()).toContain(
            "repos/rajohan/Mira-Dashboard/pulls/12/merge-async"
        );
        expect(await Bun.file(gitLog).text()).not.toContain(
            `worktree remove ${path.join(worktreeRoot, "stack-top")}`
        );
    });
    it("retains every worktree for closed blockers and unconfirmed merge results", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const { approvePullRequest } =
            await import("../../src/services/pullRequests/mergeService.ts");
        for (const scenario of ["closed", "head-mismatch", "unconfirmed"] as const) {
            const fakeRoot = createTemporaryRoot(`mira-pr-stack-${scenario}-guard-root-`);
            const worktreeRoot = path.join(fakeRoot, "worktrees");
            const fakeBin = createTemporaryRoot(`mira-pr-stack-${scenario}-guard-bin-`);
            const ghLog = path.join(fakeRoot, "gh.log");
            const gitLog = path.join(fakeRoot, "git.log");
            const branches = ["stack-bottom", "stack-middle", "stack-top"];
            for (const branch of branches) {
                mkdirSync(path.join(worktreeRoot, branch), {
                    recursive: true,
                });
            }
            const mergeOptions: Parameters<
                typeof writeFakeGhForPullRequestStackMerge
            >[4] = {};
            if (scenario === "closed") {
                mergeOptions.closedNumber = 12;
            } else if (scenario === "head-mismatch") {
                mergeOptions.mismatchedConfirmedHeadNumber = 12;
            } else {
                mergeOptions.unconfirmedNumber = 12;
            }
            writeFakeGhForPullRequestStackMerge(
                path.join(fakeBin, "gh"),
                ghLog,
                "merged",
                13,
                mergeOptions
            );
            writeFakeGitForPullRequestStackMerge(
                path.join(fakeBin, "git"),
                fakeRoot,
                worktreeRoot,
                gitLog
            );
            process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
            process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
            process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
            const action = approvePullRequest(13, false, {
                expectedHeadSha: "3".repeat(40),
                expectedStackHeads: expectedStackHeadsThrough(13),
                mergeStack: true,
            });
            expect(await captureRejection(() => action)).toMatchObject({
                message:
                    scenario === "closed"
                        ? "PR #12 is closed and blocks merging through PR #13"
                        : "GitHub reported the stack merged, but PR #12 did not confirm as merged. Worktrees were retained; verify GitHub, then run production sync before deploying",
            });
            for (const branch of branches) {
                expect(existsSync(path.join(worktreeRoot, branch))).toBe(true);
            }
            expect(await Bun.file(gitLog).text()).not.toContain("worktree remove");
        }
    });
    it("keeps every stack worktree when GitHub queues or rejects the atomic merge", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const { approvePullRequest } =
            await import("../../src/services/pullRequests/mergeService.ts");
        for (const status of ["enqueued", "failed"] as const) {
            const fakeRoot = createTemporaryRoot(`mira-pr-stack-${status}-root-`);
            const worktreeRoot = path.join(fakeRoot, "worktrees");
            const fakeBin = createTemporaryRoot(`mira-pr-stack-${status}-bin-`);
            const ghLog = path.join(fakeRoot, "gh.log");
            const gitLog = path.join(fakeRoot, "git.log");
            const branches = ["stack-bottom", "stack-middle", "stack-top"];
            for (const branch of branches) {
                mkdirSync(path.join(worktreeRoot, branch), {
                    recursive: true,
                });
            }
            writeFakeGhForPullRequestStackMerge(path.join(fakeBin, "gh"), ghLog, status);
            writeFakeGitForPullRequestStackMerge(
                path.join(fakeBin, "git"),
                fakeRoot,
                worktreeRoot,
                gitLog
            );
            process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
            process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
            process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
            const action = approvePullRequest(13, true, {
                expectedHeadSha: "3".repeat(40),
                expectedStackHeads: expectedStackHeadsThrough(13),
                mergeStack: true,
            });
            const outcome = await action.then(
                (result) => ({
                    kind: "resolved" as const,
                    result,
                }),
                (error: unknown) => ({
                    error,
                    kind: "rejected" as const,
                })
            );
            expect(outcome).toMatchObject(
                status === "enqueued"
                    ? {
                          kind: "resolved",
                          result: {
                              isOk: true,
                              mergeStatus: "enqueued",
                              message:
                                  "Stack #360 queued through PR #13 (3 PRs). Delivery retained every worktree and will not auto-deploy; deploy latest main after GitHub finishes the queue",
                          },
                      }
                    : {
                          error: {
                              message: "Required check failed.",
                          },
                          kind: "rejected",
                      }
            );
            for (const branch of branches) {
                expect(existsSync(path.join(worktreeRoot, branch))).toBe(true);
            }
            const gitCommands = await Bun.file(gitLog).text();
            expect(gitCommands).not.toContain("worktree remove");
            expect(gitCommands).not.toContain("fetch --prune origin");
        }
    });
    it("reports a successful merge separately from a failed production sync", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        const fakeRoot = createTemporaryRoot("mira-pr-sync-fail-root-");
        const worktreeRoot = path.join(fakeRoot, "worktrees");
        const fakeBin = createTemporaryRoot("mira-pr-sync-fail-bin-");
        const ghLog = path.join(fakeRoot, "gh.log");
        const gitLog = path.join(fakeRoot, "git.log");
        writeFakeGhForPullRequestMerge(path.join(fakeBin, "gh"), ghLog);
        writeFileSync(
            path.join(fakeBin, "git"),
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(gitLog)}
if [[ "$*" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(fakeRoot)}
elif [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'main\n'
elif [[ "$*" == "rev-parse HEAD" ]]; then
  printf 'abc1234abc1234abc1234abc1234abc1234abc12\n'
elif [[ "$*" == "rev-parse --short HEAD" ]]; then
  printf 'abc1234\n'
elif [[ "$*" == "rev-parse --abbrev-ref --symbolic-full-name ${"@{u}"}" ]]; then
  printf 'origin/main\n'
elif [[ "$*" == "status --short" ]]; then
  printf ''
elif [[ "$*" == "worktree list --porcelain" ]]; then
  printf ''
elif [[ "$*" == "fetch --prune origin" || "$*" == "checkout main" ]]; then
  printf ''
elif [[ "$*" == "pull --ff-only origin main" ]]; then
  echo 'remote moved unexpectedly' >&2
  exit 1
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
        );
        chmodSync(path.join(fakeBin, "git"), 0o755);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = worktreeRoot;
        try {
            const { approvePullRequest } =
                await import("../../src/services/pullRequests/mergeService.ts");
            const result = await approvePullRequest(11, true, {
                expectedHeadSha: "1".repeat(40),
            });
            expect(result).toMatchObject({
                cleanup: {
                    branch: "merge-branch",
                    status: "skipped",
                },
                deployment: undefined,
                deployError: undefined,
                isOk: true,
                message: "PR #11 merged. Production sync failed",
                previewCleanup: {
                    number: 11,
                    status: "skipped",
                },
                syncError: expect.stringContaining("remote moved unexpectedly"),
            });
            expect(Bun.file(ghLog).text()).resolves.toContain("pr merge 11");
            expect(Bun.file(gitLog).text()).resolves.toContain(
                "pull --ff-only origin main"
            );
        } finally {
            database.prepare("DELETE FROM deployment_lock WHERE id = 1").run();
            database
                .prepare("DELETE FROM deployment_jobs WHERE id LIKE 'approve-%'")
                .run();
        }
    });
    it("rejects oversized GitHub JSON stream rows when listing pull requests", async () => {
        const spawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation((_executable, arguments_) => {
                const isPullRequestList = arguments_.includes("limit=100");
                return {
                    exited: Promise.resolve(0),
                    kill: () => {},
                    pid: 12_345,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(
                        isPullRequestList
                            ? `${"x".repeat(1024 * 1024 + 1)}\n`
                            : '{"data":{"__type":{"fields":[{"name":"stack"},{"name":"stackEntry"}]}}}\n'
                    ),
                } as unknown as processModule.BunProcess;
            });
        const killSpy = jest
            .spyOn(processModule, "killProcessGroup")
            .mockImplementation(() => {});
        try {
            const { listDashboardPullRequests } =
                await import("../../src/services/pullRequests/githubPullRequestListing.ts");
            expect(
                await captureRejection(() => listDashboardPullRequests())
            ).toMatchObject({
                message: "GitHub CLI JSON line was too large",
            });
            expect(killSpy).toHaveBeenCalledWith(expect.any(Object), "SIGTERM");
        } finally {
            spawnSpy.mockRestore();
            killSpy.mockRestore();
        }
    });
    it("maps pull request route validation and GitHub list failures to JSON errors", async () => {
        const { pullRequestRoutes } =
            await import("../../src/routes/pullRequestRoutes.ts");
        const invalidNumber = await pullRequestRoutes[
            "/api/pull-requests/:number/review-approval"
        ].POST(
            routeRequest("/api/pull-requests/nope/review-approval", {
                number: "nope",
            })
        );
        expect(invalidNumber.status).toBe(400);
        expect(invalidNumber.json()).resolves.toEqual(
            apiErrorExpectation("Invalid pull request number")
        );
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve(2),
                    kill: () => {},
                    pid: 12_345,
                    stderr: readableUtf8Stream("graphql unavailable\n"),
                    stdout: readableUtf8Stream(""),
                }) as unknown as processModule.BunProcess
        );
        try {
            const listResponse = await pullRequestRoutes["/api/pull-requests"].GET();
            expect(listResponse.status).toBe(500);
            expect(listResponse.json()).resolves.toEqual(
                apiErrorExpectation("Pull request route failed", "pull_request_failed")
            );
        } finally {
            spawnSpy.mockRestore();
        }
    });
    it("rejects unsafe pull request actions before invoking mutating GitHub commands", async () => {
        rememberEnvironment("PATH");
        rememberEnvironment("MIRA_DASHBOARD_ROOT");
        rememberEnvironment("MIRA_DASHBOARD_WORKTREE_ROOT");
        rememberEnvironment("RAJOHAN_GITHUB_TOKEN");
        const fakeRoot = createTemporaryRoot("mira-pr-validation-root-");
        const fakeBin = createTemporaryRoot("mira-pr-validation-bin-");
        writeFakeGhForPullRequestValidation(path.join(fakeBin, "gh"));
        writeFakeGit(path.join(fakeBin, "git"), fakeRoot);
        process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
        process.env.MIRA_DASHBOARD_ROOT = fakeRoot;
        process.env.MIRA_DASHBOARD_WORKTREE_ROOT = path.join(fakeRoot, "worktrees");
        delete process.env.RAJOHAN_GITHUB_TOKEN;
        const {
            approvePullRequest,
            approvePullRequestReview,
            rejectPullRequest,
            updatePullRequestBranch,
        } = await Promise.all([
            import("../../src/services/pullRequests/mergeService.ts"),
            import("../../src/services/pullRequests/actionService.ts"),
        ]).then(([module0, module1]) => ({
            approvePullRequest: module0.approvePullRequest,
            approvePullRequestReview: module1.approvePullRequestReview,
            rejectPullRequest: module1.rejectPullRequest,
            updatePullRequestBranch: module1.updatePullRequestBranch,
        }));
        expect(
            await captureRejection(() =>
                approvePullRequest(6, false, {
                    expectedHeadSha: "6".repeat(40),
                })
            )
        ).toMatchObject({
            message: "Draft pull requests cannot be approved from the dashboard",
        });
        expect(
            await captureRejection(() => rejectPullRequest(7, "Wrong base"))
        ).toMatchObject({
            message: "Only main-targeted pull requests can be managed here",
        });
        expect(await captureRejection(() => updatePullRequestBranch(8))).toMatchObject({
            message: "Pull request branch is not behind the base branch",
        });
        expect(await captureRejection(() => updatePullRequestBranch(9))).toMatchObject({
            message: "Pull request branch has merge conflicts",
        });
        expect(await captureRejection(() => approvePullRequestReview(10))).toMatchObject({
            message: "Rajohan cannot approve his own pull request",
        });
        expect(await captureRejection(() => approvePullRequestReview(6))).toMatchObject({
            message: "Draft pull requests cannot be approved from the dashboard",
        });
    });
});
