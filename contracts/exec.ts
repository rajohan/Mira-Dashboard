import {
    assertContractKeys,
    contractEnum,
    contractFiniteNumber,
    contractRecord,
    contractString,
    invalidContract,
    optionalContractBoolean,
    optionalContractString,
    requiresContractBoolean,
} from "./runtime";

export interface ExecRequest {
    args?: string[];
    command: string;
    cwd?: string;
    shell?: boolean;
}

export interface ExecResponse {
    code: number | undefined;
    stderr: string;
    stdout: string;
}

export interface ExecStartResponse {
    jobId: string;
}

export type ExecJobStatus = "done" | "running" | "signaled";

const EXEC_JOB_STATUSES = ["done", "running", "signaled"] as const;

export interface ExecJobResponse extends ExecResponse {
    endedAt: number | undefined;
    jobId: string;
    startedAt: number;
    status: ExecJobStatus;
}

export interface ExecStopResponse {
    isSuccess: boolean;
    message: string;
}

/** Parses the transport shape before service-level command authorization. */
export function parseExecRequest(value: unknown): ExecRequest {
    const input = contractRecord(value);
    assertContractKeys(input, ["args", "command", "cwd", "shell"], "body");
    let arguments_: string[] | undefined;
    if (input.args !== undefined) {
        if (!Array.isArray(input.args)) {
            return invalidContract("body.args", "must be an array of strings");
        }
        arguments_ = input.args.map((argument, index) =>
            contractString(argument, `body.args[${index}]`, {
                allowEmpty: true,
                trim: false,
            })
        );
    }
    const cwd = optionalContractString(input.cwd, "body.cwd", {
        allowEmpty: true,
        trim: false,
    });
    const shell = optionalContractBoolean(input.shell, "body.shell");
    return {
        command: contractString(input.command, "body.command", { trim: false }),
        ...(arguments_ !== undefined && { args: arguments_ }),
        ...(cwd !== undefined && { cwd }),
        ...(shell !== undefined && { shell }),
    };
}

export function parseExecResponse(value: unknown): ExecResponse {
    const input = contractRecord(value, "response");
    return {
        code:
            input.code === undefined
                ? undefined
                : contractFiniteNumber(input.code, "response.code"),
        stderr: contractString(input.stderr, "response.stderr", {
            allowEmpty: true,
            trim: false,
        }),
        stdout: contractString(input.stdout, "response.stdout", {
            allowEmpty: true,
            trim: false,
        }),
    };
}

export function parseExecStartResponse(value: unknown): ExecStartResponse {
    const input = contractRecord(value, "response");
    return { jobId: contractString(input.jobId, "response.jobId") };
}

export function parseExecJobResponse(value: unknown): ExecJobResponse {
    const input = contractRecord(value, "response");
    const base = parseExecResponse(input);
    return {
        ...base,
        endedAt:
            input.endedAt === undefined
                ? undefined
                : contractFiniteNumber(input.endedAt, "response.endedAt"),
        jobId: contractString(input.jobId, "response.jobId"),
        startedAt: contractFiniteNumber(input.startedAt, "response.startedAt"),
        status: contractEnum(input.status, EXEC_JOB_STATUSES, "response.status"),
    };
}

export function parseExecStopResponse(value: unknown): ExecStopResponse {
    const input = contractRecord(value, "response");
    return {
        isSuccess: requiresContractBoolean(input.isSuccess, "response.isSuccess"),
        message: contractString(input.message, "response.message", {
            allowEmpty: true,
            trim: false,
        }),
    };
}
