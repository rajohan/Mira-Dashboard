import { runPullRequestPreviewGatewayProxyEntrypoint } from "./services/pullRequestPreviews/gatewayProxy.ts";

export {
    MAX_CLIENT_PENDING_REQUESTS,
    runPullRequestPreviewGatewayProxyEntrypoint,
    startPullRequestPreviewGatewayProxy,
} from "./services/pullRequestPreviews/gatewayProxy.ts";
export type {
    PullRequestPreviewGatewayProxy,
    PullRequestPreviewGatewayProxyOptions,
} from "./services/pullRequestPreviews/gatewayProxy.ts";

if (import.meta.main) {
    await runPullRequestPreviewGatewayProxyEntrypoint();
}
