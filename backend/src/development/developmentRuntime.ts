import path from "node:path";

import { createStructuredLogger } from "../lib/structuredLogger.ts";
import {
    developmentBackendEnvironment,
    frontendEnvironment,
} from "./developmentEnvironment.ts";
import {
    appendDevelopmentLogEntry,
    DEVELOPMENT_LOG_FIXTURE_INTERVAL_MS,
    DEVELOPMENT_LOG_FIXTURES,
    prepareDevelopmentLog,
} from "./developmentLogs.ts";
import type { DevelopmentStackConfig } from "./developmentStackConfig.ts";
import { prepareDevelopmentState } from "./developmentState.ts";

const logger = createStructuredLogger("development-stack");

type DevelopmentChild = ReturnType<typeof Bun.spawn>;

async function developmentChildExit(
    child: DevelopmentChild,
    processName: "backend" | "frontend"
): Promise<{ code: number; process: "backend" | "frontend" }> {
    return { code: await child.exited, process: processName };
}

function stopChild(child: DevelopmentChild): void {
    if (child.exitCode === null) {
        child.kill("SIGTERM");
    }
}

/**
 * Starts frontend/backend children and keeps their lifecycle coupled.
 * @returns Promise resolving to the run development stack result.
 */
export async function runDevelopmentStack(
    config: DevelopmentStackConfig
): Promise<number> {
    const state = prepareDevelopmentState(config);
    prepareDevelopmentLog(config);
    const bun = Bun.which("bun") || process.execPath;
    const watchArguments = config.hotReload ? ["--watch"] : [];
    const backend = Bun.spawn([bun, ...watchArguments, "src/serverStart.ts"], {
        cwd: path.join(config.repositoryRoot, "backend"),
        env: developmentBackendEnvironment(config),
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
    });
    const frontend = Bun.spawn(
        [bun, ...watchArguments, "scripts/developmentFrontend.ts"],
        {
            cwd: config.repositoryRoot,
            env: frontendEnvironment(config),
            stderr: "inherit",
            stdin: "inherit",
            stdout: "inherit",
        }
    );
    let developmentLogFixtureIndex = 0;
    const developmentLogFixtureTimer =
        config.openClawLogMode === "host-read-only"
            ? undefined
            : setInterval(() => {
                  try {
                      const entry =
                          DEVELOPMENT_LOG_FIXTURES[
                              developmentLogFixtureIndex % DEVELOPMENT_LOG_FIXTURES.length
                          ]!;
                      developmentLogFixtureIndex += 1;
                      appendDevelopmentLogEntry(config, entry);
                  } catch (error) {
                      logger.error("development.log_fixture_append_failed", { error });
                  }
              }, DEVELOPMENT_LOG_FIXTURE_INTERVAL_MS);
    let isStopRequested = false;
    let isChildrenStopping = false;
    const stopChildren = () => {
        if (isChildrenStopping) return;
        isChildrenStopping = true;
        stopChild(frontend);
        stopChild(backend);
    };
    const handleSignal = () => {
        isStopRequested = true;
        stopChildren();
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);

    logger.info("development.started", {
        backendHost: config.backendHost,
        backendPort: config.backendPort,
        frontendHost: config.frontendHost,
        frontendPort: config.frontendPort,
        gatewayUrl: config.gatewayUrl,
        hotReload: config.hotReload,
        logs: {
            application: "development-file",
            openClaw: config.openClawLogMode,
        },
        publicOrigin: config.publicOrigin,
        state: {
            database: state.database,
            releases: state.releases,
            root: config.stateRoot,
            workspace: state.workspace,
        },
        workerEnabled: true,
    });

    const childExits = [
        developmentChildExit(backend, "backend"),
        developmentChildExit(frontend, "frontend"),
    ];
    const exited = await Promise.race(childExits);
    if (developmentLogFixtureTimer) {
        clearInterval(developmentLogFixtureTimer);
    }
    stopChildren();
    await Promise.allSettled([backend.exited, frontend.exited]);
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    if (isStopRequested) {
        return 0;
    }
    logger.error("development.process_exited", {
        exitCode: exited.code,
        process: exited.process,
    });
    return exited.code || 1;
}
