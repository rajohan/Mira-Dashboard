import type {
    DashboardReleaseManagerOptions,
    DashboardReleaseState,
} from "./releaseManager.ts";
import {
    activateDashboardRelease,
    pruneDashboardReleases,
    readDashboardReleaseState,
    resolveDashboardReleasesRoot,
    rollbackDashboardRelease,
} from "./releaseManager.ts";

const COORDINATED_SCHEMA_CUTOVER_FLAG = "--coordinated-schema-cutover";
const RELEASE_TRANSITION_LOCK_WAIT_MS = 30_000;

function releaseSummary(state: DashboardReleaseState) {
    const summarize = (release: DashboardReleaseState["current"]) =>
        release
            ? {
                  commitSha: release.commitSha,
                  commitTitle: release.manifest.commitTitle,
                  path: release.path,
                  schema: release.manifest.schema,
              }
            : undefined;
    return {
        current: summarize(state.current),
        previous: summarize(state.previous),
        root: state.root,
    };
}

export async function runReleaseLifecycleCommand(
    arguments_: string[],
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseManagerOptions = {}
) {
    const [command, commitSha, ...extra] = arguments_;
    const isCoordinatedSchemaCutover =
        command === "activate" &&
        extra.length === 1 &&
        extra[0] === COORDINATED_SCHEMA_CUTOVER_FLAG;
    if (!isCoordinatedSchemaCutover && extra.length > 0) {
        throw new TypeError("Release lifecycle command received unexpected arguments");
    }

    let state: DashboardReleaseState;
    const transitionOptions: DashboardReleaseManagerOptions = {
        ...options,
        transitionLockWaitMs:
            options.transitionLockWaitMs ?? RELEASE_TRANSITION_LOCK_WAIT_MS,
    };
    switch (command) {
        case "activate": {
            if (!commitSha) {
                throw new TypeError("Release lifecycle activate requires a commit SHA");
            }
            state = await activateDashboardRelease(commitSha, releasesRoot, {
                ...transitionOptions,
                ...(isCoordinatedSchemaCutover && {
                    schemaCutoverMode: "coordinated" as const,
                }),
            });
            break;
        }
        case "rollback": {
            if (commitSha !== undefined) {
                throw new TypeError("Release lifecycle rollback takes no commit SHA");
            }
            state = await rollbackDashboardRelease(releasesRoot, transitionOptions);
            break;
        }
        case "status": {
            if (commitSha !== undefined) {
                throw new TypeError("Release lifecycle status takes no commit SHA");
            }
            state = await readDashboardReleaseState(releasesRoot);
            break;
        }
        case "prune": {
            const retainCount = commitSha === undefined ? 3 : Number(commitSha);
            return pruneDashboardReleases(retainCount, releasesRoot);
        }
        default: {
            throw new TypeError(
                "Usage: releaseLifecycle.js <status|activate COMMIT_SHA [--coordinated-schema-cutover]|rollback|prune [RETAIN_COUNT]>"
            );
        }
    }
    return releaseSummary(state);
}

if (import.meta.main) {
    try {
        const result = await runReleaseLifecycleCommand(Bun.argv.slice(2));
        console.log(JSON.stringify(result));
    } catch (error) {
        console.error(
            error instanceof Error ? error.message : "Release lifecycle failed"
        );
        process.exitCode = 1;
    }
}
