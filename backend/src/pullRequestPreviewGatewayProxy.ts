import { runPullRequestPreviewGatewayProxyEntrypoint } from "./services/pullRequestPreviews/gatewayProxy.ts";

export * from "./services/pullRequestPreviews/gatewayProxy.ts";

if (import.meta.main) {
    await runPullRequestPreviewGatewayProxyEntrypoint();
}
