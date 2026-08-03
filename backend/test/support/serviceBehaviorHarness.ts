import { afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PullRequestSummary } from "../../../contracts/delivery/pullRequests.ts";
import { database } from "../../src/database/connection.ts";
import { resolveDashboardProjectPaths } from "../../src/lib/dashboardPaths.ts";
import { installManagedBunRuntime } from "../../src/services/releases/managedRuntimeStore.ts";
import { currentBunRuntimeIdentity } from "../../src/services/releases/runtime.ts";
import { startTestScheduledJobExecutor as startFastScheduledJobExecutor } from "./scheduledJobExecutor.ts";
function countRollbackExecutions(): number {
    return (
        database
            .prepare(`SELECT COUNT(*) AS count
             FROM job_executions
             WHERE action_key = 'dashboard.rollback'`)
            .get() as {
            count: number;
        }
    ).count;
}

async function installCurrentTestRuntime(projectRoot: string): Promise<void> {
    await installManagedBunRuntime(process.execPath, currentBunRuntimeIdentity(), {
        runtimeRoot: resolveDashboardProjectPaths({
            MIRA_DASHBOARD_PROJECT_ROOT: projectRoot,
        }).productionBunRuntimeRoot,
    });
}

async function executeSuccessfulGuardianPath(script: string): Promise<void> {
    const lifecycleBranches = [
        script.indexOf("\nif stop_services; then"),
        script.indexOf("\nif MIRA_DASHBOARD_PROJECT_ROOT="),
    ].filter((index) => index >= 0);
    const firstLifecycleBranch =
        lifecycleBranches.length > 0 ? Math.min(...lifecycleBranches) : undefined;
    if (firstLifecycleBranch === undefined) {
        throw new Error("Guardian fixture is missing its lifecycle branch");
    }
    const executableScript = [
        "restart_services() { return 0; }",
        "ready_for_commit() { return 0; }",
        "stop_services() { return 0; }",
        script.slice(firstLifecycleBranch + 1),
    ].join("\n");
    const child = Bun.spawn(["/bin/bash", "-lc", executableScript], {
        env: process.env,
        stderr: "pipe",
        stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(
            `Guardian fixture failed with exit code ${exitCode}: ${stderr.trim() || stdout.trim()}`
        );
    }
}

async function executeSuccessfulGuardianHandoff(script: string): Promise<void> {
    const handoffStart = script.indexOf("\nMIRA_DEPLOYMENT_DB=");
    const serviceStopBranch = script.indexOf("\nif stop_services; then", handoffStart);
    if (handoffStart === -1 || serviceStopBranch === -1) {
        throw new Error("Guardian fixture is missing its durable handoff");
    }
    const child = Bun.spawn(
        [
            "/usr/bin/timeout",
            "5",
            "/bin/bash",
            "-lc",
            script.slice(handoffStart + 1, serviceStopBranch),
        ],
        {
            stderr: "pipe",
            stdout: "pipe",
        }
    );
    const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
        throw new Error(
            `Guardian handoff fixture failed with exit ${exitCode}: ${stderr.trim()}`
        );
    }
}

function readableUtf8Stream(value: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(value));
            controller.close();
        },
    });
}

function routeRequest<T extends string>(
    route: string,
    parameters: Record<T, string>,
    init?: RequestInit
): Request & {
    params: Record<T, string>;
} {
    return Object.assign(new Request(`https://test.local${route}`, init), {
        params: parameters,
    });
}

function rollbackRouteRequest(targetCommit?: unknown): Request {
    return new Request("https://dashboard.test/api/pull-requests/releases/rollback", {
        body: JSON.stringify({
            targetCommit,
        }),
        headers: {
            "Content-Type": "application/json",
        },
        method: "POST",
    });
}

function writeFakeGit(binaryPath: string, repoRoot: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(repoRoot)}
elif [[ "$args" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'main\n'
elif [[ "$args" == "rev-parse HEAD" ]]; then
  printf 'abc1234abc1234abc1234abc1234abc1234abc12\n'
elif [[ "$args" == "rev-parse --abbrev-ref --symbolic-full-name @{u}" ]]; then
  printf 'origin/main\n'
elif [[ "$1" == "status" ]]; then
  printf ''
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGh(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" && "$2" == "graphql" && "$*" != *"-F limit=100"* ]]; then
  printf '%s\n' '{"data":{"__type":{"fields":[{"name":"stack"},{"name":"stackEntry"}]}}}'
elif [[ "$1" == "api" && "$2" == "graphql" && "$*" == *"-F limit=100"* && "$*" == *"-F owner=rajohan"* && "$*" == *"-F name=Mira-Dashboard"* && "$*" == *"-f query="* && "$*" == *"--jq"* ]]; then
  if [[ "$*" == *'baseRefName: "main"'* ]]; then
echo "pull request list unexpectedly filtered to main" >&2
exit 2
  fi
  printf '%s\n' '{"number":1,"title":"Ready PR","body":"","url":"https://github.test/pr/1","headRefName":"ready","headRefOid":"head1","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T08:00:00.000Z","updatedAt":"2026-06-24T09:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"latestOpinionatedReviews":{"nodes":[{"state":"APPROVED","submittedAt":"2026-06-24T08:30:00.000Z","author":{"login":"rajohan"}}]},"additions":1,"deletions":0,"changedFiles":1,"stack":{"baseRefName":"main","number":42,"position":1,"size":2},"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T08:45:00.000Z"}]}'
  printf '%s\n' '{"number":2,"title":"Blocked cached PR","body":"","url":"https://github.test/pr/2","headRefName":"blocked","headRefOid":"head2","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","reviewDecision":"APPROVED","latestOpinionatedReviews":{"nodes":[]},"additions":2,"deletions":1,"changedFiles":2,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T10:45:00.000Z"}]}'
  printf '%s\n' '{"number":3,"title":"Ghost-authored PR","body":"","url":"https://github.test/pr/3","headRefName":"ghost","headRefOid":"head3","baseRefName":"main","author":null,"createdAt":"2026-06-24T11:00:00.000Z","updatedAt":"2026-06-24T12:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"latestOpinionatedReviews":{"nodes":[{"state":"APPROVED","submittedAt":"2026-06-24T11:30:00.000Z","author":null}]},"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[]}'
  printf '%s\n' '{"number":4,"title":"Stacked PR","body":"","url":"https://github.test/pr/4","headRefName":"stacked","headRefOid":"head4","baseRefName":"ready","author":{"login":"mira-2026"},"createdAt":"2026-06-24T12:00:00.000Z","updatedAt":"2026-06-24T13:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"latestOpinionatedReviews":{"nodes":[]},"additions":4,"deletions":1,"changedFiles":2,"stack":{"baseRefName":"main","number":42,"position":2,"size":2},"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T12:45:00.000Z"}]}'
  printf '%s\n' '{"number":5,"title":"Fork PR","body":"","url":"https://github.test/pr/5","headRefName":"main","headRefOid":"head5","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T06:00:00.000Z","updatedAt":"2026-06-24T07:00:00.000Z","isCrossRepository":true,"isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"latestOpinionatedReviews":{"nodes":[]},"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T06:45:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 2" && "$*" == *"--json state"* ]]; then
  printf '%s\n' '{"state":"OPEN"}'
elif [[ "$1 $2 $3" == "pr view 99" && "$*" == *"--json state"* ]]; then
  printf '%s\n' '{"state":"CLOSED"}'
elif [[ "$1 $2 $3" == "pr view 2" ]]; then
  printf '%s\n' '{"number":2,"title":"Blocked refreshed PR","body":"","url":"https://github.test/pr/2","headRefName":"blocked","headRefOid":"head2b","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:30:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","reviews":[],"additions":3,"deletions":1,"changedFiles":2,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:15:00.000Z"}]}'
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGhWithoutStackGraphqlFields(
    binaryPath: string,
    logPath: string,
    probeFails = false
): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "api" && "$2" == "graphql" && "$*" != *"-F limit=100"* ]]; then
  ${probeFails ? "printf 'stack metadata probe unavailable\\n' >&2\n  exit 2" : `printf '%s\\n' '{"data":{"__type":{"fields":[{"name":"number"}]}}}'`}
elif [[ "$1" == "api" && "$2" == "graphql" && "$*" == *"-F limit=100"* ]]; then
  printf '%s\n' '{"number":31,"title":"Fallback PR","body":"","url":"https://github.test/pr/31","headRefName":"fallback","headRefOid":"head31","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-07-30T08:00:00.000Z","updatedAt":"2026-07-30T09:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"latestOpinionatedReviews":{"nodes":[]},"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[]}'
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGhWithPaginatedPullRequests(binaryPath: string, logPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "api" && "$2" == "graphql" && "$*" != *"-F limit=100"* ]]; then
  printf '%s\n' '{"data":{"__type":{"fields":[{"name":"number"}]}}}'
elif [[ "$1" == "api" && "$2" == "graphql" && "$*" == *"-F limit=100"* ]]; then
  if [[ "$*" == *"-F endCursor=cursor-100"* ]]; then
printf '%s\n' '{"number":101,"title":"PR 101","body":"","url":"https://github.test/pr/101","headRefName":"branch-101","headRefOid":"head101","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-07-30T08:00:00.000Z","updatedAt":"2026-07-30T09:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"latestOpinionatedReviews":{"nodes":[]},"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[]}'
printf '%s\n' '{"__miraPageInfo":{"endCursor":null,"hasNextPage":false}}'
  else
for number in $(seq 1 100); do
  printf '{"number":%s,"title":"PR %s","body":"","url":"https://github.test/pr/%s","headRefName":"branch-%s","headRefOid":"head%s","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-07-30T08:00:00.000Z","updatedAt":"2026-07-30T09:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"latestOpinionatedReviews":{"nodes":[]},"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[]}\n' "$number" "$number" "$number" "$number" "$number"
done
printf '%s\n' '{"__miraPageInfo":{"endCursor":"cursor-100","hasNextPage":true}}'
  fi
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGhForPullRequestActions(binaryPath: string, logPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
set -- "$@" "" "" "" ""
if [[ "$1 $2 $3" == "pr view 3" ]]; then
  printf '%s\n' '{"number":3,"title":"Needs review","body":"","url":"https://github.test/pr/3","headRefName":"review-branch","headRefOid":"head3","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 4" ]]; then
  printf '%s\n' '{"number":4,"title":"Behind branch","body":"","url":"https://github.test/pr/4","headRefName":"behind-branch","headRefOid":"head4","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BEHIND","reviewDecision":"APPROVED","reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 5" ]]; then
  printf '%s\n' '{"number":5,"title":"Close me","body":"","url":"https://github.test/pr/5","headRefName":"close-branch","headRefOid":"head5","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr review 3" ]]; then
  printf 'review ok\n'
elif [[ "$1 $2" == "api -X" && "$*" == *"repos/rajohan/Mira-Dashboard/pulls/4/update-branch"* ]]; then
  printf '{}\n'
elif [[ "$1 $2 $3" == "pr close 5" ]]; then
  printf 'closed\n'
elif [[ "$1" == "api" && "$2" == repos/rajohan/Mira-Dashboard/stacks?pull_request=* ]]; then
  printf '[]\n'
elif [[ "$1 $2" == "pr list" ]]; then
  printf '[]\n'
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGhForPullRequestValidation(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2 $3" == "pr view 6" ]]; then
  printf '%s\n' '{"number":6,"title":"Draft","body":"","url":"https://github.test/pr/6","headRefName":"draft-branch","headRefOid":"6666666666666666666666666666666666666666","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":true,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 7" ]]; then
  printf '%s\n' '{"number":7,"title":"Wrong base","body":"","url":"https://github.test/pr/7","headRefName":"feature","headRefOid":"head7","baseRefName":"develop","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 8" ]]; then
  printf '%s\n' '{"number":8,"title":"Not behind","body":"","url":"https://github.test/pr/8","headRefName":"current","headRefOid":"head8","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 9" ]]; then
  printf '%s\n' '{"number":9,"title":"Conflict","body":"","url":"https://github.test/pr/9","headRefName":"conflict","headRefOid":"head9","baseRefName":"main","author":{"login":"mira-2026"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"DIRTY","mergeStateStatus":"BEHIND","reviewDecision":"APPROVED","reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
elif [[ "$1 $2 $3" == "pr view 10" ]]; then
  printf '%s\n' '{"number":10,"title":"Own PR","body":"","url":"https://github.test/pr/10","headRefName":"own","headRefOid":"head10","baseRefName":"main","author":{"login":"rajohan"},"createdAt":"2026-06-24T10:00:00.000Z","updatedAt":"2026-06-24T11:00:00.000Z","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,"reviews":[],"additions":1,"deletions":0,"changedFiles":1,"statusCheckRollup":[{"name":"ci","conclusion":"success","completedAt":"2026-06-24T11:00:00.000Z"}]}'
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGhForPullRequestMerge(
    binaryPath: string,
    logPath: string,
    dependentPullRequestNumbers: number[] = [],
    options: {
        headRefName?: string;
        isCrossRepository?: boolean;
    } = {}
): void {
    const headSha = "1".repeat(40);
    const dependentPullRequestsJson = JSON.stringify(
        dependentPullRequestNumbers.map((number) => ({
            number,
        }))
    );
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
set -- "$@" "" "" "" ""
if [[ "$1 $2 $3" == "pr view 11" ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          additions: 1,
          author: {
              login: "mira-2026",
          },
          baseRefName: "main",
          body: "",
          changedFiles: 1,
          createdAt: "2026-06-24T10:00:00.000Z",
          deletions: 0,
          headRefName: options.headRefName ?? "merge-branch",
          headRefOid: headSha,
          isCrossRepository: options.isCrossRepository ?? false,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          number: 11,
          reviewDecision: "APPROVED",
          reviews: [],
          statusCheckRollup: [
              {
                  completedAt: "2026-06-24T11:00:00.000Z",
                  conclusion: "success",
                  name: "ci",
              },
          ],
          title: "Merge me",
          updatedAt: "2026-06-24T11:00:00.000Z",
          url: "https://github.test/pr/11",
      })
  )}
elif [[ "$1 $2 $3" == "pr merge 11" ]]; then
  printf 'merged\n'
elif [[ "$1" == "api" && "$2" == "repos/rajohan/Mira-Dashboard/stacks?pull_request=11&per_page=2" ]]; then
  printf '[]\n'
elif [[ "$1 $2" == "pr list" ]]; then
  printf '%s\n' ${JSON.stringify(dependentPullRequestsJson)}
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGhForPullRequestStackMerge(
    binaryPath: string,
    logPath: string,
    status:
        | "enqueued"
        | "failed"
        | "head-mismatch"
        | "merged"
        | "pending-merged"
        | "pending-missing-id"
        | "pending-options-mismatch"
        | "request-error-merged",
    targetNumber: 11 | 12 | 13 = 13,
    options: {
        changedHeadNumber?: 11 | 12 | 13;
        closedNumber?: 11 | 12 | 13;
        mismatchedConfirmedHeadNumber?: 11 | 12 | 13;
        unconfirmedNumber?: 11 | 12 | 13;
    } = {}
): void {
    const pullRequestHeadShas = {
        11: "1".repeat(40),
        12: "2".repeat(40),
        13: "3".repeat(40),
    };
    const currentPullRequestHeadShas = {
        ...pullRequestHeadShas,
    };
    if (options.changedHeadNumber) {
        currentPullRequestHeadShas[options.changedHeadNumber] = "9".repeat(40);
    }
    const confirmedPullRequestHeadShas = {
        ...currentPullRequestHeadShas,
    };
    if (options.mismatchedConfirmedHeadNumber) {
        confirmedPullRequestHeadShas[options.mismatchedConfirmedHeadNumber] = "8".repeat(
            40
        );
    }
    const defaultPullRequestState =
        status === "pending-missing-id" || status === "pending-options-mismatch"
            ? "OPEN"
            : "MERGED";
    let asyncResult: Record<string, unknown>;
    if (status.startsWith("pending")) {
        asyncResult = {
            details: {
                expected_head_sha: pullRequestHeadShas[targetNumber],
                merge_action: "default",
                merge_method: status === "pending-options-mismatch" ? "merge" : "squash",
                message: "Stack merge is pending.",
                ...(status === "pending-merged"
                    ? {
                          uuid: "merge-uuid",
                      }
                    : {}),
            },
            status: "pending",
        };
    } else if (status === "head-mismatch") {
        asyncResult = {
            details: {
                expected_head_sha: "9".repeat(40),
                message: "The pull request head changed.",
            },
            status: "merged",
        };
    } else if (status === "merged") {
        asyncResult = {
            details: {
                message: "Pull request was merged.",
                sha: "a".repeat(40),
            },
            status,
        };
    } else {
        asyncResult = {
            details: {
                message:
                    status === "enqueued"
                        ? "Pull request was added to the merge queue."
                        : "Required check failed.",
            },
            status,
        };
    }
    const polledMergeResult = JSON.stringify({
        details: {
            message: "Pull request was merged.",
            sha: "a".repeat(40),
        },
        status: "merged",
    });
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
set -- "$@" "" "" "" ""
if [[ "$1 $2 $3" == "pr view 11" && "$*" == *"--json state"* ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          headRefOid: confirmedPullRequestHeadShas[11],
          state: options.unconfirmedNumber === 11 ? "CLOSED" : defaultPullRequestState,
      })
  )}
elif [[ "$1 $2 $3" == "pr view 12" && "$*" == *"--json state"* ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          headRefOid: confirmedPullRequestHeadShas[12],
          state: options.unconfirmedNumber === 12 ? "CLOSED" : defaultPullRequestState,
      })
  )}
elif [[ "$1 $2 $3" == "pr view 13" && "$*" == *"--json state"* ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          headRefOid: confirmedPullRequestHeadShas[13],
          state: options.unconfirmedNumber === 13 ? "CLOSED" : defaultPullRequestState,
      })
  )}
elif [[ "$1 $2 $3" == "pr view 11" ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          additions: 1,
          author: {
              login: "mira-2026",
          },
          baseRefName: "main",
          body: "",
          changedFiles: 1,
          createdAt: "2026-07-30T10:00:00.000Z",
          deletions: 0,
          headRefName: "stack-bottom",
          headRefOid: currentPullRequestHeadShas[11],
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          number: 11,
          reviewDecision: "APPROVED",
          reviews: [],
          statusCheckRollup: [
              {
                  conclusion: "success",
                  name: "ci",
              },
          ],
          title: "Stack bottom",
          updatedAt: "2026-07-30T11:00:00.000Z",
          url: "https://github.test/pr/11",
      })
  )}
elif [[ "$1 $2 $3" == "pr view 12" ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          additions: 1,
          author: {
              login: "mira-2026",
          },
          baseRefName: "stack-bottom",
          body: "",
          changedFiles: 1,
          createdAt: "2026-07-30T10:01:00.000Z",
          deletions: 0,
          headRefName: "stack-middle",
          headRefOid: currentPullRequestHeadShas[12],
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          number: 12,
          reviewDecision: "APPROVED",
          reviews: [],
          statusCheckRollup: [
              {
                  conclusion: "success",
                  name: "ci",
              },
          ],
          title: "Stack middle",
          updatedAt: "2026-07-30T11:01:00.000Z",
          url: "https://github.test/pr/12",
      })
  )}
elif [[ "$1 $2 $3" == "pr view 13" ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          additions: 1,
          author: {
              login: "mira-2026",
          },
          baseRefName: "stack-middle",
          body: "",
          changedFiles: 1,
          createdAt: "2026-07-30T10:02:00.000Z",
          deletions: 0,
          headRefName: "stack-top",
          headRefOid: currentPullRequestHeadShas[13],
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          number: 13,
          reviewDecision: "APPROVED",
          reviews: [],
          statusCheckRollup: [
              {
                  conclusion: "success",
                  name: "ci",
              },
          ],
          title: "Stack top",
          updatedAt: "2026-07-30T11:02:00.000Z",
          url: "https://github.test/pr/13",
      })
  )}
elif [[ "$1" == "api" && "$2" == ${JSON.stringify(`repos/rajohan/Mira-Dashboard/stacks?pull_request=${targetNumber}&per_page=2`)} ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify([
          {
              base: {
                  ref: "main",
              },
              created_at: "2026-07-30T10:05:00.000Z",
              id: 360,
              node_id: "S_stack360",
              number: 360,
              open: true,
              pull_requests: [
                  {
                      draft: false,
                      head: {
                          ref: "stack-bottom",
                          sha: currentPullRequestHeadShas[11],
                      },
                      merged_at: null,
                      number: 11,
                      state: options.closedNumber === 11 ? "closed" : "open",
                  },
                  {
                      draft: false,
                      head: {
                          ref: "stack-middle",
                          sha: currentPullRequestHeadShas[12],
                      },
                      merged_at: null,
                      number: 12,
                      state: options.closedNumber === 12 ? "closed" : "open",
                  },
                  {
                      draft: false,
                      head: {
                          ref: "stack-top",
                          sha: currentPullRequestHeadShas[13],
                      },
                      merged_at: null,
                      number: 13,
                      state: options.closedNumber === 13 ? "closed" : "open",
                  },
              ],
              url: "https://api.github.test/stacks/360",
          },
      ])
  )}
elif [[ "$1 $2 $3" == "api -X PUT" && "$4" == ${JSON.stringify(`repos/rajohan/Mira-Dashboard/pulls/${targetNumber}/merge-async`)} ]]; then
  ${
      status === "request-error-merged"
          ? "echo 'request interrupted' >&2\n  exit 1"
          : `printf '%s\\n' ${JSON.stringify(JSON.stringify(asyncResult))}
  ${status === "failed" ? "exit 1" : "exit 0"}`
  }
elif [[ "$1" == "api" && "$2" == ${JSON.stringify(`repos/rajohan/Mira-Dashboard/pulls/${targetNumber}/merge-async/merge-uuid`)} ]]; then
  printf '%s\n' ${JSON.stringify(polledMergeResult)}
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGitForPullRequestStackMerge(
    binaryPath: string,
    repoRoot: string,
    worktreeRoot: string,
    logPath: string
): void {
    const branches = ["stack-bottom", "stack-middle", "stack-top"];
    const worktrees = branches.map((branch) => ({
        branch,
        worktreePath: path.join(worktreeRoot, branch),
    }));
    const worktreeList = worktrees
        .map(
            ({
                branch,
                worktreePath,
            }) => String.raw`if [[ -d ${JSON.stringify(worktreePath)} ]]; then
  printf 'worktree %s\nHEAD abc1234\nbranch refs/heads/%s\n\n' ${JSON.stringify(worktreePath)} ${JSON.stringify(branch)}
fi`
        )
        .join("\n");
    const worktreeStatus = worktrees
        .map(
            ({
                worktreePath,
            }) => String.raw`elif [[ "$*" == "-C ${worktreePath} status --short" ]]; then
  printf ''`
        )
        .join("\n");
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "rev-parse --show-toplevel" ]]; then
  printf '%s\n' ${JSON.stringify(repoRoot)}
elif [[ "$*" == "rev-parse --abbrev-ref HEAD" ]]; then
  printf 'main\n'
elif [[ "$*" == "rev-parse HEAD" ]]; then
  printf 'abc1234abc1234abc1234abc1234abc1234abc12\n'
elif [[ "$*" == "rev-parse --abbrev-ref --symbolic-full-name ${"@{u}"}" ]]; then
  printf 'origin/main\n'
elif [[ "$*" == "status --short" ]]; then
  printf ''
elif [[ "$*" == "worktree list --porcelain" ]]; then
${worktreeList}
${worktreeStatus}
elif [[ "$1 $2" == "worktree remove" ]]; then
  rmdir "$3"
elif [[ "$*" == "fetch --prune origin" || "$*" == "checkout main" || "$*" == "pull --ff-only origin main" ]]; then
  printf ''
else
  echo "unexpected git args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeGhForPullRequestStackCreation(
    binaryPath: string,
    logPath: string,
    options: {
        ambiguousChild?: boolean;
        apiUnavailable?: boolean;
        bottomIsCrossRepository?: boolean;
        continuation?: boolean;
        existingStackNumber?: number;
        topBaseRefName?: string;
    } = {}
): void {
    const bottomSha = "4".repeat(40);
    const topSha = "5".repeat(40);
    const ambiguousChildSha = "6".repeat(40);
    const continuationSha = "7".repeat(40);
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "api" && "$2" == "graphql" && "$*" != *"-F limit=100"* ]]; then
  printf '%s\n' '{"data":{"__type":{"fields":[{"name":"stack"},{"name":"stackEntry"}]}}}'
elif [[ "$1" == "api" && "$2" == "graphql" && "$*" == *"-F limit=100"* ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          additions: 1,
          author: {
              login: "mira-2026",
          },
          baseRefName: "main",
          body: "",
          changedFiles: 1,
          createdAt: "2026-07-30T10:00:00.000Z",
          deletions: 0,
          headRefName: "stack-create-bottom",
          headRefOid: bottomSha,
          isCrossRepository: options.bottomIsCrossRepository ?? false,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          number: 21,
          reviewDecision: "APPROVED",
          statusCheckRollup: [
              {
                  conclusion: "success",
                  name: "ci",
              },
          ],
          title: "Create bottom",
          updatedAt: "2026-07-30T11:00:00.000Z",
          url: "https://github.test/pr/21",
          ...(options.existingStackNumber
              ? {
                    stack: {
                        baseRefName: "main",
                        number: options.existingStackNumber,
                        position: 1,
                        size: 2,
                    },
                }
              : {}),
      })
  )}
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          additions: 1,
          author: {
              login: "mira-2026",
          },
          baseRefName: options.topBaseRefName ?? "stack-create-bottom",
          body: "",
          changedFiles: 1,
          createdAt: "2026-07-30T10:01:00.000Z",
          deletions: 0,
          headRefName: "stack-create-top",
          headRefOid: topSha,
          isCrossRepository: false,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          number: 22,
          reviewDecision: null,
          statusCheckRollup: [
              {
                  conclusion: "success",
                  name: "ci",
              },
          ],
          title: "Create top",
          updatedAt: "2026-07-30T11:01:00.000Z",
          url: "https://github.test/pr/22",
      })
  )}
  ${
      options.ambiguousChild
          ? `printf '%s\\n' ${JSON.stringify(
                JSON.stringify({
                    additions: 1,
                    author: {
                        login: "mira-2026",
                    },
                    baseRefName: "stack-create-bottom",
                    body: "",
                    changedFiles: 1,
                    createdAt: "2026-07-30T10:02:00.000Z",
                    deletions: 0,
                    headRefName: "stack-create-parallel",
                    headRefOid: ambiguousChildSha,
                    isCrossRepository: false,
                    isDraft: false,
                    mergeable: "MERGEABLE",
                    mergeStateStatus: "CLEAN",
                    number: 23,
                    reviewDecision: null,
                    statusCheckRollup: [
                        {
                            conclusion: "success",
                            name: "ci",
                        },
                    ],
                    title: "Create parallel child",
                    updatedAt: "2026-07-30T11:02:00.000Z",
                    url: "https://github.test/pr/23",
                })
            )}`
          : ""
  }
  ${
      options.continuation
          ? `printf '%s\\n' ${JSON.stringify(
                JSON.stringify({
                    additions: 1,
                    author: {
                        login: "mira-2026",
                    },
                    baseRefName: "stack-create-top",
                    body: "",
                    changedFiles: 1,
                    createdAt: "2026-07-30T10:03:00.000Z",
                    deletions: 0,
                    headRefName: "stack-create-continuation",
                    headRefOid: continuationSha,
                    isCrossRepository: false,
                    isDraft: false,
                    mergeable: "MERGEABLE",
                    mergeStateStatus: "CLEAN",
                    number: 24,
                    reviewDecision: null,
                    statusCheckRollup: [
                        {
                            conclusion: "success",
                            name: "ci",
                        },
                    ],
                    title: "Create continuation",
                    updatedAt: "2026-07-30T11:03:00.000Z",
                    url: "https://github.test/pr/24",
                })
            )}`
          : ""
  }
elif [[ "$1 $2 $3" == "pr view 22" ]]; then
  printf '%s\n' ${JSON.stringify(
      JSON.stringify({
          additions: 1,
          author: {
              login: "mira-2026",
          },
          baseRefName: "stack-create-bottom",
          body: "",
          changedFiles: 1,
          createdAt: "2026-07-30T10:01:00.000Z",
          deletions: 0,
          headRefName: "stack-create-top",
          headRefOid: topSha,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          number: 22,
          reviewDecision: null,
          reviews: [],
          statusCheckRollup: [
              {
                  conclusion: "success",
                  name: "ci",
              },
          ],
          title: "Create top",
          updatedAt: "2026-07-30T11:01:00.000Z",
          url: "https://github.test/pr/22",
      })
  )}
elif [[ "$1" == "api" && "$2" == "repos/rajohan/Mira-Dashboard/stacks?pull_request=22&per_page=2" ]]; then
  printf '[]\n'
elif [[ "$1 $2 $3" == "pr review 22" ]]; then
  printf 'review ok\n'
elif [[ "$1 $2 $3" == "api -X POST" && "$4" == "repos/rajohan/Mira-Dashboard/stacks" ]]; then
  ${
      options.apiUnavailable
          ? 'printf \'HTTP/2 404 Not Found\\ncontent-type: application/json\\n\\n{"message":"Not Found"}\\n\'\n  exit 1'
          : `printf '%s\\n' ${JSON.stringify(
                JSON.stringify({
                    base: {
                        ref: "main",
                    },
                    created_at: "2026-07-30T12:00:00.000Z",
                    id: 500,
                    node_id: "S_stack500",
                    number: 500,
                    open: true,
                    pull_requests: [
                        {
                            draft: false,
                            head: {
                                ref: "stack-create-bottom",
                                sha: bottomSha,
                            },
                            merged_at: null,
                            number: 21,
                            state: "open",
                        },
                        {
                            draft: false,
                            head: {
                                ref: "stack-create-top",
                                sha: topSha,
                            },
                            merged_at: null,
                            number: 22,
                            state: "open",
                        },
                    ],
                    url: "https://api.github.test/stacks/500",
                })
            )}`
  }
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
    );
    chmodSync(binaryPath, 0o755);
}

function stackPullRequestSummary(
    number: 11 | 12 | 13,
    overrides: Partial<PullRequestSummary> = {}
): PullRequestSummary {
    const position = number - 10;
    const headRefNames = {
        11: "stack-bottom",
        12: "stack-middle",
        13: "stack-top",
    } as const;
    const baseRefNames = {
        11: "main",
        12: "stack-bottom",
        13: "stack-middle",
    } as const;
    return {
        additions: 1,
        author: {
            login: "mira-2026",
        },
        baseRefName: baseRefNames[number],
        body: "",
        changedFiles: 1,
        createdAt: `2026-07-30T10:0${position}:00.000Z`,
        deletions: 0,
        headRefName: headRefNames[number],
        headRefOid: String(position).repeat(40),
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        number,
        reviewDecision: "APPROVED",
        stack: {
            baseRefName: "main",
            number: 360,
            position,
            size: 3,
        },
        statusCheckRollup: [
            {
                conclusion: "success",
                name: "ci",
            },
        ],
        title: `Stack PR ${number}`,
        updatedAt: `2026-07-30T11:0${position}:00.000Z`,
        url: `https://github.test/pr/${number}`,
        ...overrides,
    };
}

function expectedStackHeadsThrough(number: 11 | 12 | 13) {
    return ([11, 12, 13] as const)
        .filter((pullRequestNumber) => pullRequestNumber <= number)
        .map((pullRequestNumber) => ({
            headSha: String(pullRequestNumber - 10).repeat(40),
            number: pullRequestNumber,
        }));
}

function writeFakeDocker(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pgrep -f"* ]]; then
  printf '%s\n' "__MIRA_CONTAINER_PGREP_NO_MATCH__"
  exit 1
fi
if [[ "$*" == "exec kopia kopia snapshot list --all --json-verbose --json" ]]; then
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  cat <<JSON
[
  {"id":"snap-docker","source":{"path":"/source/docker"},"stats":{"fileCount":2,"totalSize":200,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]},
  {"id":"snap-openclaw","source":{"path":"/source/openclaw"},"stats":{"fileCount":3,"totalSize":300,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]},
  {"id":"snap-projects","source":{"path":"/source/projects"},"stats":{"fileCount":4,"totalSize":400,"errorCount":0,"ignoredErrorCount":0},"startTime":"$now","endTime":"$now","retentionReason":["latest"]}
]
JSON
  exit 0
fi
if [[ "$*" == "exec walg wal-g backup-list --detail --json" ]]; then
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  cat <<JSON
[
  {"backup_name":"base_0001","finish_time":"$now","start_time":"$now","wal_file_name":"000000010000000000000001","storage_name":"default"}
]
JSON
  exit 0
fi
if [[ "$*" == "exec walg /bin/sh /usr/local/bin/backup-push.sh" ]]; then
  printf '%s\n' "backup ok"
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 2
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakePgrep(binaryPath: string, logPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == "-f /opt/docker/apps/kopia/backup.sh" ]]; then
  printf '12345\n'
  exit 0
fi
exit 1
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFailingWalgPreflightDocker(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"pgrep -f"* ]]; then
  printf '%s\n' "pgrep failed" >&2
  exit 2
fi
if [[ "$*" == "exec walg wal-g backup-list --detail --json" ]]; then
  printf '[]\n'
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 2
`
    );
    chmodSync(binaryPath, 0o755);
}

function writeFakeOpenClaw(binaryPath: string): void {
    writeFileSync(
        binaryPath,
        String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "gateway restart" ]]; then
  printf '%s\n' "restart ok"
  exit 0
fi
echo "unexpected openclaw args: $*" >&2
exit 2
`
    );
    chmodSync(binaryPath, 0o755);
}

function waitFor(isReady: () => boolean, timeoutMilliseconds = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    return new Promise((resolve, reject) => {
        const tick = () => {
            try {
                if (isReady()) {
                    resolve();
                    return;
                }
            } catch (error) {
                reject(
                    error instanceof Error
                        ? error
                        : new Error("Test condition failed", {
                              cause: error,
                          })
                );
                return;
            }
            if (Date.now() > deadline) {
                reject(new Error("Timed out waiting for test condition"));
                return;
            }
            setTimeout(tick, 10);
        };
        tick();
    });
}

export function createServiceBehaviorHarness() {
    const cleanupCallbacks: Array<() => Promise<void> | void> = [];
    function rememberEnvironment(key: string): void {
        const originalValue = process.env[key];
        cleanupCallbacks.push(() => {
            if (originalValue === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = originalValue;
            }
        });
    }
    function createTemporaryRoot(prefix: string): string {
        const root = mkdtempSync(path.join(tmpdir(), prefix));
        cleanupCallbacks.push(() => {
            rmSync(root, {
                force: true,
                recursive: true,
            });
        });
        return root;
    }
    function writeFakeGhForNativeStackReviewApproval(
        binaryPath: string,
        logPath: string
    ): void {
        const reviewedPath = `${logPath}.reviewed`;
        const bottomSha = "1".repeat(40);
        const middleSha = "2".repeat(40);
        const bottom = stackPullRequestSummary(11, {
            stack: {
                baseRefName: "main",
                number: 360,
                position: 1,
                size: 2,
            },
        });
        const middle = stackPullRequestSummary(12, {
            reviewDecision: undefined,
            stack: {
                baseRefName: "main",
                number: 360,
                position: 2,
                size: 2,
            },
        });
        const { stack: _stack, ...directMiddle } = middle;
        const directMiddleBeforeReview = JSON.stringify({
            ...directMiddle,
            reviews: [],
        });
        const directMiddleAfterReview = JSON.stringify({
            ...directMiddle,
            reviewDecision: "APPROVED",
            reviews: [],
        });
        const nativeStack = JSON.stringify([
            {
                base: {
                    ref: "main",
                },
                created_at: "2026-07-30T10:05:00.000Z",
                id: 360,
                node_id: "S_stack360",
                number: 360,
                open: true,
                pull_requests: [
                    {
                        draft: false,
                        head: {
                            ref: "stack-bottom",
                            sha: bottomSha,
                        },
                        merged_at: null,
                        number: 11,
                        state: "open",
                    },
                    {
                        draft: false,
                        head: {
                            ref: "stack-middle",
                            sha: middleSha,
                        },
                        merged_at: null,
                        number: 12,
                        state: "open",
                    },
                ],
                url: "https://api.github.test/stacks/360",
            },
        ]);
        const bottomRow = JSON.stringify(bottom);
        const approvedMiddleRow = JSON.stringify({
            ...middle,
            reviewDecision: "APPROVED",
        });
        writeFileSync(
            binaryPath,
            String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
set -- "$@" "" "" "" ""
if [[ "$1 $2 $3" == "pr view 12" ]]; then
  if [[ -f ${JSON.stringify(reviewedPath)} ]]; then
    printf '%s\n' ${JSON.stringify(directMiddleAfterReview)}
  else
    printf '%s\n' ${JSON.stringify(directMiddleBeforeReview)}
  fi
elif [[ "$1" == "api" && "$2" == "repos/rajohan/Mira-Dashboard/stacks?pull_request=12&per_page=2" ]]; then
  printf '%s\n' ${JSON.stringify(nativeStack)}
elif [[ "$1 $2 $3" == "pr review 12" ]]; then
  touch ${JSON.stringify(reviewedPath)}
  printf 'review ok\n'
elif [[ "$1" == "api" && "$2" == "graphql" && "$*" != *"-F limit=100"* ]]; then
  printf '%s\n' '{"data":{"__type":{"fields":[{"name":"stack"},{"name":"stackEntry"}]}}}'
elif [[ "$1" == "api" && "$2" == "graphql" && "$*" == *"-F limit=100"* ]]; then
  printf '%s\n' ${JSON.stringify(bottomRow)}
  printf '%s\n' ${JSON.stringify(approvedMiddleRow)}
else
  echo "unexpected gh args: $*" >&2
  exit 2
fi
`
        );
        chmodSync(binaryPath, 0o755);
    }
    class FakeGatewayWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        static instances: FakeGatewayWebSocket[] = [];
        binaryType = "";
        readyState = FakeGatewayWebSocket.CONNECTING;
        readonly sent: string[] = [];
        closeCode: number | undefined;
        closeReason = "";
        sendError: Error | undefined;
        readonly url: string;
        constructor(url: string) {
            super();
            this.url = url;
            FakeGatewayWebSocket.instances.push(this);
        }
        open(): void {
            this.readyState = FakeGatewayWebSocket.OPEN;
            this.dispatchEvent(new Event("open"));
        }
        message(data: unknown): void {
            this.dispatchEvent(
                new MessageEvent("message", {
                    data,
                })
            );
        }
        send(data: string): void {
            if (this.sendError) {
                throw this.sendError;
            }
            this.sent.push(data);
        }
        close(code = 1000, reason = ""): void {
            this.readyState = FakeGatewayWebSocket.CLOSED;
            this.closeCode = code;
            this.closeReason = reason;
            this.dispatchEvent(
                new CloseEvent("close", {
                    code,
                    reason,
                })
            );
        }
    }
    async function startTestScheduledExecutor(): Promise<void> {
        const { stopScheduledJobExecutor } =
            await import("../../src/services/scheduledJobs/runtime.ts");
        startFastScheduledJobExecutor();
        cleanupCallbacks.push(stopScheduledJobExecutor);
    }
    afterEach(async () => {
        const errors: unknown[] = [];
        while (cleanupCallbacks.length > 0) {
            try {
                await cleanupCallbacks.pop()?.();
            } catch (error) {
                errors.push(error);
            }
        }
        database
            .prepare(`DELETE FROM job_executions
             WHERE scheduled_job_id LIKE 'backup.%'
                OR action_key = 'backup.clear-attention'`)
            .run();
        if (errors.length > 0) {
            throw new AggregateError(errors, "Test cleanup failed");
        }
    });
    return {
        FakeGatewayWebSocket,
        cleanupCallbacks,
        countRollbackExecutions,
        createTemporaryRoot,
        executeSuccessfulGuardianHandoff,
        executeSuccessfulGuardianPath,
        expectedStackHeadsThrough,
        installCurrentTestRuntime,
        readableUtf8Stream,
        rememberEnvironment,
        rollbackRouteRequest,
        routeRequest,
        stackPullRequestSummary,
        startTestScheduledExecutor,
        waitFor,
        writeFailingWalgPreflightDocker,
        writeFakeDocker,
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
        writeFakeOpenClaw,
        writeFakePgrep,
    };
}
