import {
    assertContractKeys,
    contractRecord,
    contractString,
    invalidContract,
    optionalContractString,
    requiresContractBoolean,
} from "./runtime";

export interface TerminalCompletionRequest {
    cwd?: string;
    partial: string;
}

export interface TerminalCompletionItem {
    completion: string;
    display: string;
    type: "directory" | "executable" | "file";
}

export interface TerminalCompletionResponse {
    commonPrefix: string;
    completions: TerminalCompletionItem[];
}

export interface TerminalCdRequest {
    cwd: string;
    path: string;
}

export interface TerminalCdResponse {
    error?: string;
    isSuccess: boolean;
    newCwd: string;
}

export function parseTerminalCompletionRequest(
    value: unknown
): TerminalCompletionRequest {
    const input = contractRecord(value);
    assertContractKeys(input, ["cwd", "partial"], "body");
    const cwd = optionalContractString(input.cwd, "body.cwd");
    return {
        partial: contractString(input.partial, "body.partial", {
            allowEmpty: true,
            trim: false,
        }),
        ...(cwd !== undefined && { cwd }),
    };
}

export function parseTerminalCdRequest(value: unknown): TerminalCdRequest {
    const input = contractRecord(value);
    assertContractKeys(input, ["cwd", "path"], "body");
    return {
        cwd: contractString(input.cwd, "body.cwd"),
        path: contractString(input.path, "body.path", {
            allowEmpty: true,
            trim: false,
        }),
    };
}

export function parseTerminalCompletionResponse(
    value: unknown
): TerminalCompletionResponse {
    const input = contractRecord(value, "response");
    if (!Array.isArray(input.completions)) {
        return invalidContract("response.completions", "must be an array");
    }
    return {
        commonPrefix: contractString(input.commonPrefix, "response.commonPrefix", {
            allowEmpty: true,
            trim: false,
        }),
        completions: input.completions.map((completion, index) => {
            const entry = contractRecord(completion, `response.completions[${index}]`);
            const type = entry.type;
            if (type !== "directory" && type !== "executable" && type !== "file") {
                return invalidContract(
                    `response.completions[${index}].type`,
                    "must be one of: directory, executable, file"
                );
            }
            return {
                completion: contractString(
                    entry.completion,
                    `response.completions[${index}].completion`,
                    { allowEmpty: true, trim: false }
                ),
                display: contractString(
                    entry.display,
                    `response.completions[${index}].display`,
                    { allowEmpty: true, trim: false }
                ),
                type,
            };
        }),
    };
}

export function parseTerminalCdResponse(value: unknown): TerminalCdResponse {
    const input = contractRecord(value, "response");
    const error = optionalContractString(input.error, "response.error", {
        allowEmpty: true,
        trim: false,
    });
    return {
        isSuccess: requiresContractBoolean(input.isSuccess, "response.isSuccess"),
        newCwd: contractString(input.newCwd, "response.newCwd", {
            allowEmpty: true,
            trim: false,
        }),
        ...(error !== undefined && { error }),
    };
}
