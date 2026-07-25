import type {
    DashboardReleaseManagerOptions,
    DashboardReleaseState,
} from "./releaseManager.ts";
import {
    activateDashboardRelease,
    readDashboardReleaseState,
    resolveDashboardReleasesRoot,
    rollbackDashboardRelease,
} from "./releaseManager.ts";

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
    if (extra.length > 0) {
        throw new TypeError("Release lifecycle command received unexpected arguments");
    }

    let state: DashboardReleaseState;
    switch (command) {
        case "activate": {
            if (!commitSha) {
                throw new TypeError("Release lifecycle activate requires a commit SHA");
            }
            state = await activateDashboardRelease(commitSha, releasesRoot, options);
            break;
        }
        case "rollback": {
            if (commitSha) {
                throw new TypeError("Release lifecycle rollback takes no commit SHA");
            }
            state = await rollbackDashboardRelease(releasesRoot, options);
            break;
        }
        case "status": {
            if (commitSha) {
                throw new TypeError("Release lifecycle status takes no commit SHA");
            }
            state = await readDashboardReleaseState(releasesRoot);
            break;
        }
        default: {
            throw new TypeError(
                "Usage: releaseLifecycle.js <status|activate COMMIT_SHA|rollback>"
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
