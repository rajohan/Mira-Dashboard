import fs from "node:fs";
import path from "node:path";

import type { ExecRequest } from "../../../../contracts/exec.ts";
import { ApiRouteError } from "../../http/apiErrors.ts";
import { hasLineBreakOrNullByte } from "../../lib/values.ts";

const OPS_SHELL_COMMANDS = new Set([
    "__mira_dashboard_shell_smoke_test__",
    "sudo reboot",
    "sudo apt-get autoremove -y && sudo apt-get autoclean -y && sudo journalctl --vacuum-time=14d && sudo docker system prune -af",
    "bash -lc 'sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y; apt_status=$?; sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a; dpkg_status=$?; if [ $apt_status -ne 0 ]; then exit $apt_status; fi; exit $dpkg_status'",
    "export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}; $HOME/.local/bin/openclaw gateway restart",
    "find $HOME/.openclaw/agents -type f -path '*/sessions/*' -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/agents -type d -path '*/sessions/*' -empty -delete 2>/dev/null || true; find $HOME/.openclaw/media -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/workspace/images -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/tmp -type f -mtime +7 -delete 2>/dev/null || true; find $HOME/.openclaw/delivery-queue/failed -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/completions -type f -mtime +14 -delete 2>/dev/null || true; find $HOME/.openclaw/cron/runs -type f -mtime +30 -delete 2>/dev/null || true; find $HOME/.openclaw/logs -type f -mtime +14 -delete 2>/dev/null || true",
    "$HOME/.local/bin/openclaw update --yes",
]);

export type ExecRequestMode = "once" | "start";

export class ExecValidationError extends ApiRouteError {
    constructor(message: string) {
        super("exec_invalid_request", message, 400);
        this.name = "ExecValidationError";
    }
}

const MAX_COMMAND_LENGTH = 4096;
const EXECUTABLE_RE = /^(?:[\w./-]+)$/u;
const ALLOWED_DIRECT_EXECUTABLES = new Set<string>(["bash"]);
const BASH_LOGIN_COMMAND_ARGUMENTS = 2;

function validateBashArguments(arguments_: string[]): void {
    if (
        arguments_.length !== BASH_LOGIN_COMMAND_ARGUMENTS ||
        arguments_[0] !== "-lc" ||
        typeof arguments_[1] !== "string" ||
        arguments_[1].length === 0
    ) {
        throw new ExecValidationError("bash args must be exactly: -lc <command>");
    }
    if (arguments_[1].length > MAX_COMMAND_LENGTH) {
        throw new ExecValidationError(
            `command exceeds maximum length of ${MAX_COMMAND_LENGTH}`
        );
    }
    if (hasLineBreakOrNullByte(arguments_[1])) {
        throw new ExecValidationError("command contains disallowed control characters");
    }
}

export function validateExecRequest(
    payload: unknown,
    mode: ExecRequestMode
): ExecRequest {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new ExecValidationError("request body must be a JSON object");
    }

    const { args, command, cwd, shell } = payload as ExecRequest;
    if (!command || typeof command !== "string") {
        throw new ExecValidationError("command must be a non-empty string");
    }
    if (command.length > MAX_COMMAND_LENGTH) {
        throw new ExecValidationError(
            `command exceeds maximum length of ${MAX_COMMAND_LENGTH}`
        );
    }
    if (hasLineBreakOrNullByte(command)) {
        throw new ExecValidationError("command contains disallowed control characters");
    }
    if (shell !== undefined && typeof shell !== "boolean") {
        throw new ExecValidationError("shell must be a boolean");
    }
    if (args !== undefined && shell) {
        throw new ExecValidationError("args cannot be combined with shell mode");
    }
    if (shell && !OPS_SHELL_COMMANDS.has(command)) {
        throw new ExecValidationError(
            "shell mode is only available for approved ops commands"
        );
    }
    if (!shell && args === undefined) {
        throw new ExecValidationError("args are required unless shell mode is enabled");
    }
    if (args !== undefined && !EXECUTABLE_RE.test(command)) {
        throw new ExecValidationError(
            "command must be an executable name when args are provided"
        );
    }
    if (args !== undefined && path.basename(command) !== command) {
        throw new ExecValidationError("command must be an approved executable name");
    }
    if (args !== undefined && !Array.isArray(args)) {
        throw new ExecValidationError("args must be an array");
    }
    if (args) {
        for (const argument of args) {
            if (typeof argument !== "string") {
                throw new ExecValidationError("all args must be strings");
            }
            if (argument.includes("\0")) {
                throw new ExecValidationError("args cannot contain null bytes");
            }
        }
    }
    const executable = path.basename(command);
    if (args !== undefined && !ALLOWED_DIRECT_EXECUTABLES.has(executable)) {
        throw new ExecValidationError("command executable is not approved");
    }
    if (args !== undefined && executable === "bash") {
        if (mode !== "start") {
            throw new ExecValidationError("bash argv execution requires job tracking");
        }
        validateBashArguments(args);
    }
    if (cwd !== undefined && typeof cwd !== "string") {
        throw new ExecValidationError("cwd must be a string");
    }
    return { args, command, cwd: resolveExecCwd(cwd), shell };
}

export function resolveExecCwd(cwd: string | undefined): string {
    if (!cwd) return process.cwd();
    if (cwd.includes("\0") || !path.isAbsolute(cwd)) {
        throw new ExecValidationError("cwd must be an absolute path");
    }
    try {
        const resolvedCwd = fs.realpathSync(cwd);
        if (!fs.statSync(resolvedCwd).isDirectory()) {
            throw new ExecValidationError("cwd must be a directory");
        }
        return resolvedCwd;
    } catch (error) {
        if (error instanceof ExecValidationError) {
            throw error;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new ExecValidationError("cwd does not exist");
        }
        throw error;
    }
}

export function requireApprovedShellCommand(command: string): string {
    if (!OPS_SHELL_COMMANDS.has(command)) {
        throw new ExecValidationError(
            "shell mode is only available for approved ops commands"
        );
    }
    return command;
}
