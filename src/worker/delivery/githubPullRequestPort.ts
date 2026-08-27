import * as v from "valibot";

import {
    deliveryGitHubBaseBranch,
    deliveryGitHubAsyncMergeSchema,
    deliveryGitHubCommitShaSchema,
    deliveryGitHubExpectedHeadSchema,
    deliveryGitHubExpectedHeadsSchema,
    deliveryGitHubMiraLogin,
    deliveryGitHubPullRequestBodyMaximumBytes,
    deliveryGitHubPullRequestMaximum,
    deliveryGitHubPullRequestNumberSchema,
    deliveryGitHubPullRequestSchema,
    deliveryGitHubPublishedReleaseSchema,
    deliveryGitHubStackSchema,
    type DeliveryGitHubExpectedHead,
    type DeliveryGitHubMergeMutationOutcome,
    type DeliveryGitHubMutationOutcome,
    type DeliveryGitHubPullRequest,
    type DeliveryGitHubPullRequestMutationPort,
    type DeliveryGitHubPullRequestReadPort,
    type DeliveryGitHubPublishedRelease,
    type DeliveryGitHubStack,
} from "../../contracts/deliveryGithub.ts";
import { utf8ByteLength } from "../../shared/encoding.ts";
import {
    maximumProductionReleaseReceiptBytes,
    productionReleaseArtifactReceiptSchema,
} from "../../shared/productionReleaseArtifactReceipt.ts";
import {
    DeliveryGitHubError,
    type DeliveryGitHubHttpTransport,
} from "./githubHttpTransport.ts";
import {
    assertPullRequestMergeEligible,
    hasOpenDependentPullRequest,
} from "./pullRequestScope.ts";

// Bound request count without placing all 500 PRs in one provider response.
// The transport budget covers these bodies plus their bounded check contexts.
const pullRequestPageSize = 20;
const pullRequestPageMaximum = 25;
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
const rawMainRefSchema = v.object({
    object: v.object({ sha: v.string(), type: v.literal("commit") }),
    ref: v.optional(v.string()),
});
const rawLatestReleaseSchema = v.object({
    assets: v.array(
        v.object({
            digest: v.string(),
            id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
            name: v.string(),
            size: v.number(),
        })
    ),
    draft: v.boolean(),
    prerelease: v.boolean(),
    tag_name: v.string(),
    target_commitish: v.string(),
});
const rawReleaseCommitSchema = v.object({ sha: v.string() });
const rawMergeSchema = v.object({
    merged: v.boolean(),
    message: v.string(),
    sha: v.nullish(v.string()),
});
const rawUpdateBranchSchema = v.object({ message: v.string(), url: v.string() });
const rawAsyncMergeSchema = v.object({
    details: v.object({
        expected_head_sha: v.optional(deliveryGitHubCommitShaSchema),
        merge_action: v.optional(v.picklist(["default", "direct_merge", "merge_queue"])),
        merge_method: v.optional(v.picklist(["merge", "rebase", "squash"])),
        message: v.pipe(v.string(), v.maxLength(2048)),
        sha: v.optional(deliveryGitHubCommitShaSchema),
        uuid: v.optional(v.pipe(v.string(), v.maxLength(256))),
    }),
    status: v.picklist(["enqueued", "failed", "merged", "pending"]),
});

const nativeStackMergePollIntervalMs = 2000;
const nativeStackMergePollMaximum = 150;

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

function normalizeAsyncMerge(input: unknown) {
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
        fail("unknown-outcome");
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

export type DeliveryGitHubPullRequestPort = DeliveryGitHubPullRequestReadPort &
    DeliveryGitHubPullRequestMutationPort;

export interface DeliveryGitHubPullRequestPortOptions {
    readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
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
    const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
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

    async function readLatestPublishedRelease(
        signal?: AbortSignal
    ): Promise<DeliveryGitHubPublishedRelease> {
        try {
            const raw = v.parse(
                rawLatestReleaseSchema,
                await options.transport.requestJson({ kind: "latest-release" }, signal)
            );
            if (raw.draft || raw.prerelease) fail("conflict");
            const receiptAsset = raw.assets.find(({ name }) => name === "receipt.json");
            const archiveAsset = raw.assets.find(({ name }) => name === "release.tar");
            if (
                receiptAsset === undefined ||
                receiptAsset.size > maximumProductionReleaseReceiptBytes ||
                archiveAsset === undefined
            )
                fail("conflict");
            const releaseCommit = v.parse(
                rawReleaseCommitSchema,
                await options.transport.requestJson(
                    { kind: "release-tag-commit", tagName: raw.tag_name },
                    signal
                )
            );
            const receipt = v.parse(
                productionReleaseArtifactReceiptSchema,
                await options.transport.requestJson(
                    { assetId: receiptAsset.id, kind: "release-asset" },
                    signal
                )
            );
            if (
                receipt.releaseId !== releaseCommit.sha ||
                receipt.archive.bytes !== archiveAsset.size ||
                `sha256:${receipt.archive.sha256}` !== archiveAsset.digest
            ) {
                fail("conflict");
            }
            return v.parse(deliveryGitHubPublishedReleaseSchema, {
                assets: raw.assets.map(({ digest, name, size }) => ({
                    digest,
                    name,
                    size,
                })),
                releaseId: releaseCommit.sha,
                releaseManifestSha256: receipt.releaseManifestSha256,
                runtime: receipt.runtime,
                tagName: raw.tag_name,
            });
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
        await options.transport.verifyIdentity(signal);
        // GitHub's native-stack create request accepts PR numbers but no head set.
        // A post-write comparison cannot prevent stale reviewed heads from being linked.
        fail("capability-unavailable");
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
        // GitHub may apply its repository-owned auto-delete policy as part of the
        // merge. Never race that policy with an unguarded explicit DELETE; only
        // observe whether the branch is absent or retained after the merge.
        try {
            const branchResponse = await options.transport.requestJsonWithStatus(
                { branch: pullRequest.headRefName, kind: "branch-ref" },
                signal
            );
            if (branchResponse.status === 404) {
                return Object.freeze({
                    mainHeadSha: mergedMainHeadSha,
                    outcome: "completed",
                });
            }
            v.parse(rawMainRefSchema, branchResponse.body);
            return Object.freeze({
                mainHeadSha: mergedMainHeadSha,
                outcome: "partial-success",
                warning: "branch-retained",
            });
        } catch {
            return Object.freeze({
                mainHeadSha: mergedMainHeadSha,
                outcome: "partial-success",
                warning: "branch-cleanup-unconfirmed",
            });
        }
    }

    async function mergeNativeStack(
        input: readonly DeliveryGitHubExpectedHead[],
        signal?: AbortSignal
    ): Promise<DeliveryGitHubMergeMutationOutcome> {
        const expectedHeads = exactExpectedHeads(input);
        if (expectedHeads.length === 0) fail("invalid-input");
        await options.transport.verifyIdentity(signal);
        const selected = expectedHeads.at(-1)!;
        const stack = await findNativeStack(selected.number, signal);
        if (
            stack === undefined ||
            !stack.open ||
            stack.baseRefName !== deliveryGitHubBaseBranch
        ) {
            fail("conflict");
        }
        const selectedIndex = stack.pullRequests.findIndex(
            ({ number }) => number === selected.number
        );
        if (selectedIndex === -1) fail("conflict");
        const prefix = stack.pullRequests
            .slice(0, selectedIndex + 1)
            .filter(({ mergedAt }) => mergedAt === undefined);
        if (
            prefix.length !== expectedHeads.length ||
            prefix.some(
                (member, index) =>
                    member.number !== expectedHeads[index]?.number ||
                    member.headSha !== expectedHeads[index]?.headSha ||
                    member.state !== "open" ||
                    member.draft
            )
        ) {
            fail("conflict");
        }
        const current = await Promise.all(
            expectedHeads.map(({ number }) => getPullRequest(number, signal))
        );
        for (const [index, pullRequest] of current.entries()) {
            assertExactPullRequest(pullRequest, expectedHeads[index]!);
            assertPullRequestMergeEligible(pullRequest);
        }

        let merge;
        try {
            merge = normalizeAsyncMerge(
                await options.transport.requestJson(
                    {
                        expectedHeadSha: selected.headSha,
                        kind: "native-stack-merge-start",
                        pullRequestNumber: selected.number,
                    },
                    signal
                )
            );
        } catch (error) {
            if (error instanceof DeliveryGitHubError && error.reason === "conflict") {
                throw error;
            }
            fail("unknown-outcome");
        }
        if (
            merge.details.expectedHeadSha !== undefined &&
            merge.details.expectedHeadSha !== selected.headSha
        ) {
            fail("unknown-outcome");
        }
        for (let poll = 0; merge.status === "pending"; poll += 1) {
            if (
                poll >= nativeStackMergePollMaximum ||
                merge.details.uuid === undefined ||
                merge.details.expectedHeadSha !== selected.headSha ||
                merge.details.mergeAction !== "default" ||
                merge.details.mergeMethod !== "squash"
            ) {
                fail("unknown-outcome");
            }
            signal?.throwIfAborted();
            await sleep(nativeStackMergePollIntervalMs, signal);
            signal?.throwIfAborted();
            try {
                merge = normalizeAsyncMerge(
                    await options.transport.requestJson(
                        {
                            kind: "native-stack-merge-poll",
                            pullRequestNumber: selected.number,
                            uuid: merge.details.uuid,
                        },
                        signal
                    )
                );
            } catch {
                fail("unknown-outcome");
            }
        }
        if (merge.status === "failed") fail("conflict");
        if (merge.status === "enqueued") return Object.freeze({ outcome: "enqueued" });
        if (merge.status !== "merged" || merge.details.sha === undefined) {
            fail("unknown-outcome");
        }
        const confirmed = await Promise.all(
            expectedHeads.map(({ number }) =>
                getPullRequest(number, signal).catch(() => null)
            )
        );
        if (
            confirmed.some(
                (pullRequest, index) =>
                    pullRequest?.state !== "MERGED" ||
                    pullRequest.headSha !== expectedHeads[index]?.headSha
            ) ||
            confirmed.at(-1)?.mergeCommitSha !== merge.details.sha
        ) {
            fail("unknown-outcome");
        }
        return Object.freeze({ mainHeadSha: merge.details.sha, outcome: "completed" });
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
        exactExpectedHead(input);
        await options.transport.verifyIdentity(signal);
        // GitHub's close mutation accepts no expected head. Reopening after a
        // raced close would be another unguarded effect, so rejection fails closed.
        fail("capability-unavailable");
    }

    return Object.freeze({
        createNativeStack,
        findNativeStack,
        getPullRequest,
        listOpenPullRequests,
        mergeNativeStack,
        mergePullRequest,
        readLatestPublishedRelease,
        readMainRef,
        rejectPullRequest,
        supportsNativeStacks,
        updatePullRequestBranch,
    });
}
