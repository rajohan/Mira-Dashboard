import * as v from "valibot";

import { lowercaseSha256Schema } from "../../shared/validation.ts";

const terminalDockerContainerIdSchema = lowercaseSha256Schema(
    "Docker container id is invalid"
);

const terminalRouteSearchSchema = v.strictObject({
    dockerContainerId: v.optional(terminalDockerContainerIdSchema),
});

/** Validated optional Docker-to-Terminal handoff owned by the Terminal route. */
export type TerminalRouteSearch = v.InferOutput<typeof terminalRouteSearchSchema>;

/**
 * Drops malformed or unrelated search state before it can influence terminal input.
 * @param search Untrusted route search input.
 * @returns One optional exact Engine container ID.
 */
export function parseTerminalRouteSearch(search: unknown): TerminalRouteSearch {
    const candidate =
        typeof search === "object" &&
        search !== null &&
        !Array.isArray(search) &&
        "dockerContainerId" in search
            ? search.dockerContainerId
            : undefined;
    const containerId = v.safeParse(terminalDockerContainerIdSchema, candidate);
    return v.parse(
        terminalRouteSearchSchema,
        containerId.success ? { dockerContainerId: containerId.output } : {}
    );
}
