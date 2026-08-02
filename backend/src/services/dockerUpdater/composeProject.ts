import fs from "node:fs";
import path from "node:path";

import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";
import {
    composeCommandPath,
    composeFilesForCommand,
    isParentComposePath,
} from "./composeIncludes.ts";
import { getDockerBin } from "./support.ts";

function getDockerComposeWrapper(): string {
    const dockerRoot = getDockerRoot();
    return nonEmptyEnvironmentFallback(
        "MIRA_DOCKER_COMPOSE_WRAPPER",
        `${dockerRoot}/bin/docker-compose-doppler`
    );
}

function getDockerRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_ROOT", "/opt/docker");
}

export function getDockerAppsRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_APPS_ROOT", "/opt/docker/apps");
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalDockerRoots(): string[] {
    return [...new Set([getDockerAppsRoot(), getDockerRoot()])]
        .map((root) => {
            try {
                const canonicalRoot = fs.realpathSync(root);
                return fs.statSync(canonicalRoot).isDirectory()
                    ? canonicalRoot
                    : undefined;
            } catch {
                return;
            }
        })
        .filter((root): root is string => root !== undefined);
}

export function managedComposePath(composePath: string): string {
    const absolutePath = path.resolve(composePath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new TypeError("Managed compose paths must be single-link regular files");
    }
    const canonicalPath = fs.realpathSync(absolutePath);
    if (!canonicalDockerRoots().some((root) => isPathWithinRoot(canonicalPath, root))) {
        throw new TypeError(
            "Managed compose path must stay within a configured Docker root"
        );
    }
    return canonicalPath;
}

function composeFileArguments(composePaths: string[]): string[] {
    return composePaths.flatMap((composePath) => ["-f", composePath]);
}

export function getComposeCommand(
    configuredComposePath: string,
    serviceName: string,
    verifiedComposePaths?: string[]
) {
    const dockerRoot = getDockerRoot();
    const wrapper = getDockerComposeWrapper();
    const projectComposePath =
        verifiedComposePaths?.[0] ?? composeCommandPath(configuredComposePath);
    const composePaths =
        verifiedComposePaths ??
        composeFilesForCommand(
            projectComposePath,
            isParentComposePath(projectComposePath, configuredComposePath)
        );
    const isManagedDockerPath = path
        .resolve(projectComposePath)
        .startsWith(`${path.resolve(dockerRoot)}${path.sep}`);
    const composeArgs = [
        ...composeFileArguments(composePaths),
        "up",
        "-d",
        "--pull",
        "always",
        serviceName,
    ];
    const cwd = path.dirname(projectComposePath);
    if (
        process.env.MIRA_DOCKER_COMPOSE_WRAPPER ||
        (isManagedDockerPath && fs.existsSync(wrapper))
    ) {
        return {
            file: wrapper,
            args: composeArgs,
            cwd,
        };
    }
    return {
        file: getDockerBin(),
        args: ["compose", ...composeArgs],
        cwd,
    };
}

export function getComposeCommandPaths(configuredComposePath: string): string[] {
    const projectComposePath = composeCommandPath(configuredComposePath);
    return composeFilesForCommand(
        projectComposePath,
        isParentComposePath(projectComposePath, configuredComposePath)
    );
}
