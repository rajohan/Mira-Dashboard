import * as v from "valibot";

import {
    finiteNumberSchema,
    nonNegativeIntegerSchema,
    parseContract,
    strictJsonObjectSchema,
    successLiteralSchema,
} from "./runtime";

export const fileWriteRequestSchema = strictJsonObjectSchema({
    content: v.string(),
});

export const fileEntrySchema = v.strictObject({
    error: v.optional(v.boolean()),
    modified: v.optional(v.string()),
    name: v.pipe(v.string(), v.nonEmpty()),
    path: v.pipe(v.string(), v.nonEmpty()),
    relativePath: v.optional(v.string()),
    size: v.optional(nonNegativeIntegerSchema),
    type: v.picklist(["directory", "file"]),
});

export const fileContentSchema = v.strictObject({
    content: v.string(),
    isBinary: v.boolean(),
    isImage: v.optional(v.boolean()),
    masked: v.optional(v.boolean()),
    maskingError: v.optional(v.picklist(["invalid_json", "truncated_json"])),
    mimeType: v.optional(v.string()),
    modified: v.string(),
    path: v.string(),
    relativePath: v.optional(v.string()),
    size: finiteNumberSchema,
    truncated: v.optional(v.boolean()),
});

export const filesResponseSchema = v.strictObject({
    files: v.array(fileEntrySchema),
    root: v.optional(v.string()),
});

export const fileWriteResponseSchema = v.strictObject({
    isSuccess: successLiteralSchema,
    modified: v.string(),
    path: v.string(),
    relativePath: v.optional(v.string()),
    size: finiteNumberSchema,
});

export type FileWriteRequest = v.InferOutput<typeof fileWriteRequestSchema>;
export type FileEntry = v.InferOutput<typeof fileEntrySchema>;
export type FileContent = v.InferOutput<typeof fileContentSchema>;
export type FilesResponse = v.InferOutput<typeof filesResponseSchema>;
export type FileWriteResponse = v.InferOutput<typeof fileWriteResponseSchema>;

/**
 * Parses a file-write request before any filesystem access.
 * @param value Value to process.
 * @returns Parsed file-write request.
 */
export function parseFileWriteRequest(value: unknown): FileWriteRequest {
    return parseContract(fileWriteRequestSchema, value);
}

/**
 * Parses a workspace directory listing at the browser HTTP trust boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed a workspace directory listing at the browser HTTP trust boundary.
 */
export function parseFilesResponse(
    value: unknown,
    path = "filesResponse"
): FilesResponse {
    return parseContract(filesResponseSchema, value, path);
}

/**
 * Parses file or masked config-file content at the browser HTTP trust boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed file or masked config-file content at the browser HTTP trust boundary.
 */
export function parseFileContent(value: unknown, path = "fileContent"): FileContent {
    return parseContract(fileContentSchema, value, path);
}

/**
 * Parses a successful file-write response.
 * @param value Value to process.
 * @returns Parsed file-write response.
 */
export function parseFileWriteResponse(value: unknown): FileWriteResponse {
    return parseContract(fileWriteResponseSchema, value, "fileWrite");
}
