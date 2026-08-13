import * as v from "valibot";

import {
    deliveryGitHubAsyncMergeSchema,
    deliveryGitHubBaseBranch,
    deliveryGitHubCommitShaSchema,
    deliveryGitHubExpectedHeadSchema,
    deliveryGitHubExpectedHeadsSchema,
    deliveryGitHubMiraLogin,
    deliveryGitHubReviewerLogin,
    deliveryGitHubPullRequestBodyMaximumBytes,
    deliveryGitHubPullRequestMaximum,
    deliveryGitHubPullRequestNumberSchema,
    deliveryGitHubPullRequestSchema,
    deliveryGitHubStackSchema,
    type DeliveryGitHubAsyncMerge,
    type DeliveryGitHubExpectedHead,
    type DeliveryGitHubMergeMutationOutcome,
    type DeliveryGitHubMutationOutcome,
    type DeliveryGitHubPullRequest,
    type DeliveryGitHubPullRequestMutationPort,
    type DeliveryGitHubPullRequestReadPort,
    type DeliveryGitHubStack,
} from "../../contracts/deliveryGithub.ts";
import { utf8ByteLength } from "../../shared/encoding.ts";
import {
    DeliveryGitHubError,
    type DeliveryGitHubHttpTransport,
} from "./githubHttpTransport.ts";
import {
    assertExpectedPullRequestScope,
    assertPullRequestMergeEligible,
    hasOpenDependentPullRequest,
    resolvePullRequestScope,
} from "./pullRequestScope.ts";

// Bound request count without placing all 500 PRs in one provider response.
// The transport budget covers these bodies plus their bounded check contexts.
const pullRequestPageSize = 20;
const pullRequestPageMaximum = 25;
const nativeStackMergePollIntervalMs = 1000;
const nativeStackMergeDeadlineMs = 5 * 60_000;
const rejectComment = "Closed from Mira Dashboard after Rajohan rejected it." as const;
const trustedStackAuthors: ReadonlySet<string> = new Set([
    deliveryGitHubMiraLogin,
    deliveryGitHubReviewerLogin,
]);

const optionalDate = v.nullish(v.string());
const optionalText = v.nullish(v.string());
const optionalAuthor = v.nullish(v.object({ login: v.nullish(v.string()) }));
const optionalWorkflow = v.nullish(v.object({ name: v.nullish(v.string()) }));
const optionalWorkflowRun = v.nullish(v.object({ workflow: optionalWorkflow }));
const optionalCheckSuite = v.nullish(v.object({ workflowRun: optionalWorkflowRun }));

const rawCheckRunSchema = v.object({
    __typename: v.literal("CheckRun"),
    checkSuite: optionalCheckSuite,
    completedAt: optionalDate,
    conclusion: optionalText,
    name: v.string(),
    startedAt: optionalDate,
    status: v.string(),
});
const rawStatusContextSchema = v.object({
    __typename: v.literal("StatusContext"),
    context: v.string(),
    createdAt: optionalDate,
    state: v.string(),
});
const rawReviewSchema = v.object({
    author: optionalAuthor,
    state: v.string(),
    submittedAt: optionalDate,
});
const optionalRawReview = v.nullish(rawReviewSchema);
const optionalRawReviews = v.nullish(v.array(optionalRawReview));
const rawCheckContextSchema = v.union([rawCheckRunSchema, rawStatusContextSchema]);
const optionalRawCheckContext = v.nullish(rawCheckContextSchema);
const optionalRawCheckContexts = v.nullish(v.array(optionalRawCheckContext));
const rawPullRequestSchema = v.object({
    additions: v.number(),
    author: optionalAuthor,
    baseRefName: v.string(),
    body: v.nullish(v.string()),
    changedFiles: v.number(),
    createdAt: v.string(),
    deletions: v.number(),
    headRefName: v.string(),
    headRefOid: v.string(),
    isCrossRepository: v.boolean(),
    isDraft: v.boolean(),
    latestOpinionatedReviews: v.nullish(v.object({ nodes: optionalRawReviews })),
    mergeStateStatus: v.nullish(v.string()),
    mergeable: v.nullish(v.string()),
    mergeCommit: v.nullish(v.object({ oid: v.string() })),
    number: v.number(),
    reviewDecision: optionalText,
    stack: v.nullish(
        v.object({
            baseRefName: v.string(),
            number: v.number(),
            size: v.number(),
        })
    ),
    stackEntry: v.nullish(v.object({ position: v.number() })),
    state: v.picklist(["CLOSED", "MERGED", "OPEN"]),
    statusCheckRollup: v.nullish(
        v.object({
            contexts: v.object({
                nodes: optionalRawCheckContexts,
                pageInfo: v.object({ hasNextPage: v.boolean() }),
            }),
        })
    ),
    title: v.string(),
    updatedAt: v.string(),
    url: v.string(),
});

const pageInfoSchema = v.object({
    endCursor: v.nullish(v.string()),
    hasNextPage: v.boolean(),
});
const listEnvelopeSchema = v.object({
    data: v.object({
        repository: v.object({
            pullRequests: v.object({
                nodes: v.array(v.nullish(rawPullRequestSchema)),
                pageInfo: pageInfoSchema,
            }),
        }),
    }),
    errors: v.optional(v.array(v.unknown())),
});
const detailEnvelopeSchema = v.object({
    data: v.object({
        repository: v.object({ pullRequest: v.nullish(rawPullRequestSchema) }),
    }),
    errors: v.optional(v.array(v.unknown())),
});
const capabilityFieldSchema = v.object({ name: v.string() });
const capabilityTypeSchema = v.object({ fields: v.array(capabilityFieldSchema) });
const capabilityEnvelopeSchema = v.object({
    data: v.object({
        __type: v.nullish(capabilityTypeSchema),
    }),
    errors: v.optional(v.array(v.unknown())),
});

const rawStackSchema = v.object({
    base: v.object({ ref: v.string() }),
    id: v.number(),
    number: v.number(),
    open: v.boolean(),
    pull_requests: v.array(
        v.object({
            draft: v.boolean(),
            head: v.object({ ref: v.string(), sha: v.string() }),
            merged_at: optionalDate,
            number: v.number(),
            state: v.picklist(["closed", "open"]),
        })
    ),
});
const rawAsyncMergeSchema = v.object({
    details: v.object({
        expected_head_sha: v.optional(v.string()),
        merge_action: v.optional(v.string()),
        merge_method: v.optional(v.string()),
        message: v.string(),
        sha: v.optional(v.string()),
        uuid: v.optional(v.string()),
    }),
    status: v.string(),
});
const rawMainRefSchema = v.object({
    object: v.object({ sha: v.string(), type: v.literal("commit") }),
    ref: v.optional(v.string()),
});
const rawMergeSchema = v.object({
    merged: v.boolean(),
    message: v.string(),
    sha: v.nullish(v.string()),
});
const rawClosedPullRequestSchema = v.object({
    base: v.object({ ref: v.string() }),
    head: v.object({ sha: v.string() }),
    number: v.number(),
    state: v.literal("closed"),
});
const rawUpdateBranchSchema = v.object({ message: v.string(), url: v.string() });
const rawCommentSchema = v.object({
    body: v.string(),
    created_at: v.string(),
    html_url: v.string(),
    id: v.number(),
    user: v.object({ login: v.string() }),
});

const capabilityQuery = `query DeliveryStackCapability {
  __type(name: "PullRequest") { fields { name } }
}`;

function pullRequestSelection(includeStack: boolean): string {
    return `
      number title body url headRefName headRefOid isCrossRepository baseRefName
      author { login } createdAt updatedAt isDraft state mergeable mergeStateStatus
      mergeCommit { oid } reviewDecision additions deletions changedFiles
      latestOpinionatedReviews(first: 20) { nodes { state submittedAt author { login } } }
      statusCheckRollup {
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun {
              name status conclusion startedAt completedAt
              checkSuite { workflowRun { workflow { name } } }
            }
            ... on StatusContext { context state createdAt }
          }
          pageInfo { hasNextPage }
        }
      }
      ${includeStack ? "stack { baseRefName number size } stackEntry { position }" : ""}
    `;
}

function listQuery(includeStack: boolean): string {
    return `query DeliveryPullRequests($owner: String!, $name: String!, $limit: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: $limit, after: $cursor, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ${pullRequestSelection(includeStack)} }
          pageInfo { endCursor hasNextPage }
        }
      }
    }`;
}

function detailQuery(includeStack: boolean): string {
    return `query DeliveryPullRequest($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) { ${pullRequestSelection(includeStack)} }
      }
    }`;
}

function fail(reason: ConstructorParameters<typeof DeliveryGitHubError>[0]): never {
    throw new DeliveryGitHubError(reason);
}

function parseGraphql<
    TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: TSchema, input: unknown): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, input);
    if (!parsed.success) fail("unavailable");
    const envelope = parsed.output as { readonly errors?: readonly unknown[] };
    if ((envelope.errors?.length ?? 0) > 0) fail("unavailable");
    return parsed.output;
}

function truncateUtf8(value: string, maximumBytes: number): string {
    if (utf8ByteLength(value) <= maximumBytes) return value;
    let bytes = 0;
    let result = "";
    for (const character of value) {
        const next = utf8ByteLength(character);
        if (bytes + next > maximumBytes) break;
        result += character;
        bytes += next;
    }
    return result;
}

function normalizePullRequest(input: unknown): DeliveryGitHubPullRequest {
    let raw: v.InferOutput<typeof rawPullRequestSchema>;
    try {
        raw = v.parse(rawPullRequestSchema, input);
    } catch {
        fail("unavailable");
    }
    const checks = (raw.statusCheckRollup?.contexts.nodes ?? []).flatMap((check) => {
        if (check === null || check === undefined) return [];
        if (check.__typename === "CheckRun") {
            const workflow = check.checkSuite?.workflowRun?.workflow?.name;
            return [
                {
                    ...(check.completedAt === null || check.completedAt === undefined
                        ? {}
                        : { completedAt: check.completedAt }),
                    ...(check.conclusion === null || check.conclusion === undefined
                        ? {}
                        : { conclusion: check.conclusion }),
                    identity: `check:${workflow ?? ""}:${check.name}`,
                    ...(check.startedAt === null || check.startedAt === undefined
                        ? {}
                        : { startedAt: check.startedAt }),
                    status: check.status,
                },
            ];
        }
        return [
            {
                ...(check.createdAt === null || check.createdAt === undefined
                    ? {}
                    : { createdAt: check.createdAt }),
                identity: `status:${check.context}`,
                status: check.state,
            },
        ];
    });
    try {
        return v.parse(deliveryGitHubPullRequestSchema, {
            additions: raw.additions,
            ...(raw.author?.login === null || raw.author?.login === undefined
                ? {}
                : { authorLogin: raw.author.login }),
            baseRefName: raw.baseRefName,
            body: truncateUtf8(raw.body ?? "", deliveryGitHubPullRequestBodyMaximumBytes),
            changedFiles: raw.changedFiles,
            checks,
            checksComplete: !(
                raw.statusCheckRollup?.contexts.pageInfo.hasNextPage ?? false
            ),
            createdAt: raw.createdAt,
            deletions: raw.deletions,
            headRefName: raw.headRefName,
            headSha: raw.headRefOid,
            isCrossRepository: raw.isCrossRepository,
            isDraft: raw.isDraft,
            mergeable: raw.mergeable ?? "UNKNOWN",
            ...(raw.mergeCommit === null || raw.mergeCommit === undefined
                ? {}
                : { mergeCommitSha: raw.mergeCommit.oid }),
            mergeStateStatus: raw.mergeStateStatus ?? "UNKNOWN",
            number: raw.number,
            ...(raw.reviewDecision === null || raw.reviewDecision === undefined
                ? {}
                : { reviewDecision: raw.reviewDecision }),
            reviews: (raw.latestOpinionatedReviews?.nodes ?? []).flatMap((review) =>
                review === null || review === undefined
                    ? []
                    : [
                          {
                              ...(review.author?.login === null ||
                              review.author?.login === undefined
                                  ? {}
                                  : { authorLogin: review.author.login }),
                              state: review.state,
                              ...(review.submittedAt === null ||
                              review.submittedAt === undefined
                                  ? {}
                                  : { submittedAt: review.submittedAt }),
                          },
                      ]
            ),
            ...(raw.stack === null ||
            raw.stack === undefined ||
            raw.stackEntry === null ||
            raw.stackEntry === undefined
                ? {}
                : {
                      stack: {
                          baseRefName: raw.stack.baseRefName,
                          number: raw.stack.number,
                          position: raw.stackEntry.position,
                          size: raw.stack.size,
                      },
                  }),
            state: raw.state,
            title: raw.title,
            updatedAt: raw.updatedAt,
            url: raw.url,
        });
    } catch {
        fail("unavailable");
    }
}

function normalizeStack(input: unknown): DeliveryGitHubStack {
    let raw: v.InferOutput<typeof rawStackSchema>;
    try {
        raw = v.parse(rawStackSchema, input);
        return v.parse(deliveryGitHubStackSchema, {
            baseRefName: raw.base.ref,
            id: raw.id,
            number: raw.number,
            open: raw.open,
            pullRequests: raw.pull_requests.map((pullRequest) => ({
                draft: pullRequest.draft,
                headRefName: pullRequest.head.ref,
                headSha: pullRequest.head.sha,
                ...(pullRequest.merged_at === null || pullRequest.merged_at === undefined
                    ? {}
                    : { mergedAt: pullRequest.merged_at }),
                number: pullRequest.number,
                state: pullRequest.state,
            })),
        });
    } catch {
        fail("unavailable");
    }
}

function normalizeAsyncMerge(input: unknown): DeliveryGitHubAsyncMerge {
    try {
        const raw = v.parse(rawAsyncMergeSchema, input);
        return v.parse(deliveryGitHubAsyncMergeSchema, {
            details: {
                ...(raw.details.expected_head_sha === undefined
                    ? {}
                    : { expectedHeadSha: raw.details.expected_head_sha }),
                ...(raw.details.merge_action === undefined
                    ? {}
                    : { mergeAction: raw.details.merge_action }),
                ...(raw.details.merge_method === undefined
                    ? {}
                    : { mergeMethod: raw.details.merge_method }),
                message: raw.details.message,
                ...(raw.details.sha === undefined ? {} : { sha: raw.details.sha }),
                ...(raw.details.uuid === undefined ? {} : { uuid: raw.details.uuid }),
            },
            status: raw.status,
        });
    } catch {
        fail("unavailable");
    }
}

function exactExpectedHead(
    input: DeliveryGitHubExpectedHead
): DeliveryGitHubExpectedHead {
    try {
        return v.parse(deliveryGitHubExpectedHeadSchema, input);
    } catch {
        fail("invalid-input");
    }
}

function exactExpectedHeads(
    input: readonly DeliveryGitHubExpectedHead[]
): readonly DeliveryGitHubExpectedHead[] {
    try {
        return v.parse(deliveryGitHubExpectedHeadsSchema, input);
    } catch {
        fail("invalid-input");
    }
}

function assertExactPullRequest(
    pullRequest: DeliveryGitHubPullRequest,
    expected: DeliveryGitHubExpectedHead
): void {
    if (
        pullRequest.number !== expected.number ||
        pullRequest.headSha !== expected.headSha ||
        pullRequest.state !== "OPEN"
    ) {
        fail("conflict");
    }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) fail("unavailable");
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timeout);
            reject(new DeliveryGitHubError("unavailable"));
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

export type DeliveryGitHubPullRequestPort = DeliveryGitHubPullRequestReadPort &
    DeliveryGitHubPullRequestMutationPort;

export interface DeliveryGitHubPullRequestPortOptions {
    readonly now?: () => number;
    readonly pollIntervalMs?: number;
    readonly transport: DeliveryGitHubHttpTransport;
}

/**
 * Creates the fixed-repository Mira GitHub PR and native-stack adapter.
 * @returns Credential-isolated PR and stack port.
 */
export function createDeliveryGitHubPullRequestPort(
    options: DeliveryGitHubPullRequestPortOptions
): DeliveryGitHubPullRequestPort {
    if (options.transport.actor !== deliveryGitHubMiraLogin) {
        fail("authentication");
    }
    const now = options.now ?? Date.now;
    const pollIntervalMs = options.pollIntervalMs ?? nativeStackMergePollIntervalMs;
    if (
        !Number.isSafeInteger(pollIntervalMs) ||
        pollIntervalMs < 1 ||
        pollIntervalMs > 10_000
    ) {
        fail("invalid-input");
    }

    async function supportsNativeStacks(signal?: AbortSignal): Promise<boolean> {
        await options.transport.verifyIdentity(signal);
        let parsed: v.InferOutput<typeof capabilityEnvelopeSchema>;
        try {
            parsed = parseGraphql(
                capabilityEnvelopeSchema,
                await options.transport.requestJson(
                    {
                        document: capabilityQuery,
                        kind: "graphql",
                        variables: {},
                    },
                    signal
                )
            );
        } catch (error) {
            if (
                error instanceof DeliveryGitHubError &&
                error.reason === "authentication"
            ) {
                throw error;
            }
            return false;
        }
        const fields = parsed.data.__type?.fields.map(({ name }) => name) ?? [];
        return fields.includes("stack") && fields.includes("stackEntry");
    }

    async function listOpenPullRequests(
        signal?: AbortSignal
    ): Promise<readonly DeliveryGitHubPullRequest[]> {
        const includeStack = await supportsNativeStacks(signal);
        const pullRequests: DeliveryGitHubPullRequest[] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        for (let page = 0; page < pullRequestPageMaximum; page += 1) {
            const envelope: v.InferOutput<typeof listEnvelopeSchema> = parseGraphql(
                listEnvelopeSchema,
                await options.transport.requestJson(
                    {
                        document: listQuery(includeStack),
                        kind: "graphql",
                        variables: {
                            cursor,
                            limit: pullRequestPageSize,
                            name: "Mira-Dashboard",
                            owner: "rajohan",
                        },
                    },
                    signal
                )
            );
            pullRequests.push(
                ...envelope.data.repository.pullRequests.nodes.flatMap((row) =>
                    row === null || row === undefined ? [] : [normalizePullRequest(row)]
                )
            );
            if (pullRequests.length > deliveryGitHubPullRequestMaximum) {
                fail("limit-exceeded");
            }
            const pageInfo = envelope.data.repository.pullRequests.pageInfo;
            if (!pageInfo.hasNextPage) {
                return Object.freeze(
                    pullRequests.toSorted((left, right) =>
                        right.updatedAt.localeCompare(left.updatedAt)
                    )
                );
            }
            if (
                pageInfo.endCursor === null ||
                pageInfo.endCursor === undefined ||
                pageInfo.endCursor.length === 0 ||
                cursors.has(pageInfo.endCursor)
            ) {
                fail("unavailable");
            }
            cursors.add(pageInfo.endCursor);
            cursor = pageInfo.endCursor;
        }
        fail("limit-exceeded");
    }

    async function getPullRequest(
        number: number,
        signal?: AbortSignal
    ): Promise<DeliveryGitHubPullRequest> {
        if (!v.safeParse(deliveryGitHubPullRequestNumberSchema, number).success) {
            fail("invalid-input");
        }
        const includeStack = await supportsNativeStacks(signal);
        const envelope = parseGraphql(
            detailEnvelopeSchema,
            await options.transport.requestJson(
                {
                    document: detailQuery(includeStack),
                    kind: "graphql",
                    variables: {
                        name: "Mira-Dashboard",
                        number,
                        owner: "rajohan",
                    },
                },
                signal
            )
        );
        const pullRequest = envelope.data.repository.pullRequest;
        if (pullRequest === null || pullRequest === undefined) fail("conflict");
        return normalizePullRequest(pullRequest);
    }

    async function readMainRef(signal?: AbortSignal): Promise<string> {
        let parsed: v.InferOutput<typeof rawMainRefSchema>;
        try {
            parsed = v.parse(
                rawMainRefSchema,
                await options.transport.requestJson({ kind: "main-ref" }, signal)
            );
            return v.parse(deliveryGitHubCommitShaSchema, parsed.object.sha);
        } catch (error) {
            if (error instanceof DeliveryGitHubError) throw error;
            fail("unavailable");
        }
    }

    async function findNativeStack(
        number: number,
        signal?: AbortSignal
    ): Promise<DeliveryGitHubStack | undefined> {
        if (!v.safeParse(deliveryGitHubPullRequestNumberSchema, number).success) {
            fail("invalid-input");
        }
        if (!(await supportsNativeStacks(signal))) fail("capability-unavailable");
        let rows: unknown;
        try {
            rows = await options.transport.requestJson(
                { kind: "native-stack-find", pullRequestNumber: number },
                signal
            );
        } catch (error) {
            throw error instanceof DeliveryGitHubError
                ? error
                : new DeliveryGitHubError("unavailable");
        }
        if (!Array.isArray(rows) || rows.length > 1) fail("unavailable");
        return rows.length === 0 ? undefined : normalizeStack(rows[0]);
    }

    async function assertOrdinary(
        expected: DeliveryGitHubExpectedHead,
        signal?: AbortSignal
    ): Promise<DeliveryGitHubPullRequest> {
        const pullRequest = await getPullRequest(expected.number, signal);
        assertExactPullRequest(pullRequest, expected);
        if (pullRequest.baseRefName !== deliveryGitHubBaseBranch) fail("conflict");
        if ((await findNativeStack(expected.number, signal)) !== undefined) {
            fail("conflict");
        }
        const all = await listOpenPullRequests(signal);
        if (hasOpenDependentPullRequest(pullRequest, all)) fail("conflict");
        return pullRequest;
    }

    async function createNativeStack(
        input: readonly DeliveryGitHubExpectedHead[],
        signal?: AbortSignal
    ): Promise<DeliveryGitHubStack> {
        const expectedHeads = exactExpectedHeads(input);
        if (expectedHeads.length < 2) fail("invalid-input");
        if (!(await supportsNativeStacks(signal))) fail("capability-unavailable");
        const pullRequests = await listOpenPullRequests(signal);
        const selected = pullRequests.find(
            ({ number }) => number === expectedHeads.at(-1)?.number
        );
        if (selected === undefined) fail("conflict");
        const scope = resolvePullRequestScope(selected.number, pullRequests);
        if (scope?.kind !== "inferred") fail("conflict");
        assertExpectedPullRequestScope(scope, expectedHeads);
        if (
            scope.members[0]?.baseRefName !== deliveryGitHubBaseBranch ||
            scope.members.some(
                (member, index) =>
                    member.stack !== undefined ||
                    member.isCrossRepository ||
                    (index > 0 &&
                        member.baseRefName !== scope.members[index - 1]?.headRefName)
            )
        ) {
            fail("conflict");
        }
        let createdRaw: unknown;
        try {
            createdRaw = await options.transport.requestJson(
                {
                    kind: "native-stack-create",
                    pullRequestNumbers: expectedHeads.map(({ number }) => number),
                },
                signal
            );
        } catch (error) {
            throw error instanceof DeliveryGitHubError
                ? error
                : new DeliveryGitHubError("unknown-outcome");
        }
        let created: DeliveryGitHubStack;
        try {
            created = normalizeStack(createdRaw);
        } catch {
            fail("unknown-outcome");
        }
        if (
            created.baseRefName !== deliveryGitHubBaseBranch ||
            created.pullRequests.length !== expectedHeads.length ||
            created.pullRequests.some(
                (member, index) =>
                    member.number !== expectedHeads[index]?.number ||
                    member.headSha !== expectedHeads[index]?.headSha
            )
        ) {
            fail("unknown-outcome");
        }
        for (const expected of expectedHeads) {
            const current = await getPullRequest(expected.number, signal).catch(() => {
                fail("unknown-outcome");
            });
            if (current.headSha !== expected.headSha || current.state !== "OPEN") {
                fail("unknown-outcome");
            }
        }
        return created;
    }

    async function mergePullRequest(
        input: DeliveryGitHubExpectedHead,
        signal?: AbortSignal
    ): Promise<DeliveryGitHubMergeMutationOutcome> {
        const expected = exactExpectedHead(input);
        const pullRequest = await assertOrdinary(expected, signal);
        assertPullRequestMergeEligible(pullRequest);
        let merged: v.InferOutput<typeof rawMergeSchema>;
        try {
            merged = v.parse(
                rawMergeSchema,
                await options.transport.requestJson(
                    {
                        expectedHeadSha: expected.headSha,
                        kind: "pull-request-merge",
                        pullRequestNumber: expected.number,
                    },
                    signal
                )
            );
        } catch (error) {
            if (error instanceof DeliveryGitHubError) throw error;
            fail("unknown-outcome");
        }
        if (!merged.merged) fail("conflict");
        let mergedMainHeadSha: string;
        try {
            mergedMainHeadSha = v.parse(deliveryGitHubCommitShaSchema, merged.sha);
        } catch {
            fail("unknown-outcome");
        }
        const current = await getPullRequest(expected.number, signal).catch(() => {
            fail("unknown-outcome");
        });
        if (
            current.state !== "MERGED" ||
            current.headSha !== expected.headSha ||
            current.mergeCommitSha !== mergedMainHeadSha
        ) {
            fail("unknown-outcome");
        }
        if (
            pullRequest.isCrossRepository ||
            pullRequest.headRefName === deliveryGitHubBaseBranch
        ) {
            return Object.freeze({
                mainHeadSha: mergedMainHeadSha,
                outcome: "completed",
            });
        }
        try {
            const rawReference = await options.transport.requestJson(
                { branch: pullRequest.headRefName, kind: "branch-ref" },
                signal
            );
            if (rawReference === null) {
                return Object.freeze({
                    mainHeadSha: mergedMainHeadSha,
                    outcome: "completed",
                });
            }
            const reference = v.parse(rawMainRefSchema, rawReference);
            if (reference.object.sha !== expected.headSha) {
                return Object.freeze({
                    mainHeadSha: mergedMainHeadSha,
                    outcome: "partial-success",
                    warning: "branch-retained",
                });
            }
            await options.transport.requestJson(
                { branch: pullRequest.headRefName, kind: "branch-delete" },
                signal
            );
        } catch {
            return Object.freeze({
                mainHeadSha: mergedMainHeadSha,
                outcome: "partial-success",
                warning: "branch-retained",
            });
        }
        return Object.freeze({
            mainHeadSha: mergedMainHeadSha,
            outcome: "completed",
        });
    }

    async function mergeNativeStack(
        input: readonly DeliveryGitHubExpectedHead[],
        signal?: AbortSignal
    ): Promise<DeliveryGitHubMergeMutationOutcome> {
        const expectedHeads = exactExpectedHeads(input);
        const selected = expectedHeads.at(-1);
        if (selected === undefined) fail("invalid-input");
        const stack = await findNativeStack(selected.number, signal);
        if (stack === undefined || stack.baseRefName !== deliveryGitHubBaseBranch) {
            fail("conflict");
        }
        const selectedIndex = stack.pullRequests.findIndex(
            ({ number }) => number === selected.number
        );
        if (selectedIndex === -1) fail("conflict");
        const openPrefix: DeliveryGitHubStack["pullRequests"][number][] = [];
        for (const member of stack.pullRequests.slice(0, selectedIndex + 1)) {
            if (member.mergedAt !== undefined) continue;
            if (member.state !== "open") fail("conflict");
            openPrefix.push(member);
        }
        if (
            openPrefix.length !== expectedHeads.length ||
            openPrefix.some(
                (member, index) =>
                    member.number !== expectedHeads[index]?.number ||
                    member.headSha !== expectedHeads[index]?.headSha
            ) ||
            openPrefix.at(-1)?.number !== selected.number
        ) {
            fail("conflict");
        }
        for (const expected of expectedHeads) {
            const pullRequest = await getPullRequest(expected.number, signal);
            assertExactPullRequest(pullRequest, expected);
            if (
                pullRequest.authorLogin === undefined ||
                !trustedStackAuthors.has(pullRequest.authorLogin)
            ) {
                fail("conflict");
            }
            assertPullRequestMergeEligible(pullRequest);
        }
        let startedRaw: unknown;
        try {
            startedRaw = await options.transport.requestJson(
                {
                    expectedHeadSha: selected.headSha,
                    kind: "native-stack-merge-start",
                    pullRequestNumber: selected.number,
                },
                signal
            );
        } catch (error) {
            throw error instanceof DeliveryGitHubError
                ? error
                : new DeliveryGitHubError("unknown-outcome");
        }
        let result: DeliveryGitHubAsyncMerge;
        try {
            result = normalizeAsyncMerge(startedRaw);
        } catch {
            fail("unknown-outcome");
        }
        if (
            result.details.expectedHeadSha !== undefined &&
            result.details.expectedHeadSha !== selected.headSha
        ) {
            fail("conflict");
        }
        const deadline = now() + nativeStackMergeDeadlineMs;
        while (result.status === "pending") {
            if (
                result.details.expectedHeadSha !== selected.headSha ||
                result.details.mergeAction !== "default" ||
                result.details.mergeMethod !== "squash" ||
                result.details.uuid === undefined
            ) {
                fail("conflict");
            }
            if (now() >= deadline) fail("unknown-outcome");
            await wait(pollIntervalMs, signal).catch(() => fail("unknown-outcome"));
            try {
                result = normalizeAsyncMerge(
                    await options.transport.requestJson(
                        {
                            kind: "native-stack-merge-poll",
                            pullRequestNumber: selected.number,
                            uuid: result.details.uuid,
                        },
                        signal
                    )
                );
            } catch {
                fail("unknown-outcome");
            }
        }
        if (result.status === "failed") fail("conflict");
        if (result.status === "enqueued") {
            return Object.freeze({ outcome: "enqueued" });
        }
        let selectedMergeCommitSha: string | undefined;
        for (const expected of expectedHeads) {
            const pullRequest = await getPullRequest(expected.number, signal).catch(() =>
                fail("unknown-outcome")
            );
            if (
                pullRequest.state !== "MERGED" ||
                pullRequest.headSha !== expected.headSha
            ) {
                fail("unknown-outcome");
            }
            if (expected.number === selected.number) {
                selectedMergeCommitSha = pullRequest.mergeCommitSha;
            }
        }
        if (
            result.details.sha === undefined ||
            selectedMergeCommitSha !== result.details.sha
        ) {
            fail("unknown-outcome");
        }
        return Object.freeze({
            mainHeadSha: result.details.sha,
            outcome: "completed",
        });
    }

    async function updatePullRequestBranch(
        input: DeliveryGitHubExpectedHead,
        signal?: AbortSignal
    ): Promise<DeliveryGitHubMutationOutcome> {
        const expected = exactExpectedHead(input);
        const pullRequest = await assertOrdinary(expected, signal);
        if (
            pullRequest.mergeStateStatus.toUpperCase() !== "BEHIND" ||
            ["CONFLICTING", "DIRTY"].includes(pullRequest.mergeable.toUpperCase())
        ) {
            fail("conflict");
        }
        try {
            const response = await options.transport.requestJsonWithStatus(
                {
                    expectedHeadSha: expected.headSha,
                    kind: "pull-request-update-branch",
                    pullRequestNumber: expected.number,
                },
                signal
            );
            v.parse(rawUpdateBranchSchema, response.body);
            if (response.status !== 202) fail("unknown-outcome");
        } catch (error) {
            if (error instanceof DeliveryGitHubError) throw error;
            fail("unknown-outcome");
        }
        return Object.freeze({ outcome: "enqueued" });
    }

    async function rejectPullRequest(
        input: DeliveryGitHubExpectedHead,
        signal?: AbortSignal
    ): Promise<DeliveryGitHubMutationOutcome> {
        const expected = exactExpectedHead(input);
        const pullRequest = await assertOrdinary(expected, signal);
        if (pullRequest.isDraft) fail("conflict");
        let closed: v.InferOutput<typeof rawClosedPullRequestSchema>;
        try {
            closed = v.parse(
                rawClosedPullRequestSchema,
                await options.transport.requestJson(
                    { kind: "pull-request-close", pullRequestNumber: expected.number },
                    signal
                )
            );
        } catch (error) {
            if (error instanceof DeliveryGitHubError) throw error;
            fail("unknown-outcome");
        }
        if (
            closed.number !== expected.number ||
            closed.head.sha !== expected.headSha ||
            closed.base.ref !== deliveryGitHubBaseBranch
        ) {
            fail("unknown-outcome");
        }
        try {
            v.parse(
                rawCommentSchema,
                await options.transport.requestJson(
                    {
                        body: rejectComment,
                        kind: "pull-request-comment",
                        pullRequestNumber: expected.number,
                    },
                    signal
                )
            );
        } catch {
            return Object.freeze({
                outcome: "partial-success",
                warning: "comment-failed",
            });
        }
        return Object.freeze({ outcome: "completed" });
    }

    return Object.freeze({
        createNativeStack,
        findNativeStack,
        getPullRequest,
        listOpenPullRequests,
        mergeNativeStack,
        mergePullRequest,
        readMainRef,
        rejectPullRequest,
        supportsNativeStacks,
        updatePullRequestBranch,
    });
}
