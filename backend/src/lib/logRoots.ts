import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOGS_DIRECTORY = "/tmp/openclaw";

function invalidLogRoot(message: string): Error {
    return Object.assign(new Error(message), { code: "ERR_INVALID_ARG_VALUE" });
}

export function resolveRealLogsDirectory(): string {
    const configuredRoot =
        process.env.MIRA_DASHBOARD_LOGS_ROOT?.trim() || DEFAULT_LOGS_DIRECTORY;
    const resolvedRoot = path.resolve(configuredRoot);

    if (!path.isAbsolute(configuredRoot)) {
        throw invalidLogRoot("Log directory must be absolute");
    }
    if (resolvedRoot === path.parse(resolvedRoot).root) {
        throw invalidLogRoot("Log directory cannot be the filesystem root");
    }
    if (fs.lstatSync(resolvedRoot).isSymbolicLink()) {
        throw Object.assign(new Error("Log directory must not be a symlink"), {
            code: "ELOOP",
        });
    }

    const realRoot = fs.realpathSync(resolvedRoot);
    if (!path.isAbsolute(realRoot) || realRoot === path.parse(realRoot).root) {
        throw invalidLogRoot("Resolved log directory is unsafe");
    }
    return realRoot;
}
