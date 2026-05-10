import { describe, expect, it } from "vitest";

import {
    getFileExtension,
    getLanguage,
    getSyntaxClass,
    isBinaryFile,
    isCodeFile,
    isImageFile,
    isJsonFile,
    isMarkdownFile,
} from "./fileUtils";

describe("file utils", () => {
    it("extracts extensions safely", () => {
        expect(getFileExtension("README.md")).toBe("md");
        expect(getFileExtension("archive.TAR.GZ")).toBe("gz");
        expect(getFileExtension("Makefile")).toBe("");
    });

    it("classifies common file types", () => {
        expect(isMarkdownFile("README.md")).toBe(true);
        expect(isMarkdownFile("README.markdown")).toBe(true);
        expect(isJsonFile("config.json5")).toBe(true);
        expect(isCodeFile("server.ts")).toBe(true);
        expect(isCodeFile("schema.graphql")).toBe(true);
        expect(isImageFile("avatar.webp")).toBe(true);
        expect(isBinaryFile("backup.zip")).toBe(true);
        expect(isBinaryFile("song.mp3")).toBe(true);
        expect(isCodeFile("notes.txt")).toBe(false);
    });

    it("maps languages and syntax colors", () => {
        expect(getLanguage("component.tsx")).toBe("typescript");
        expect(getLanguage("script.py")).toBe("python");
        expect(getLanguage("config.yaml")).toBe("yaml");
        expect(getLanguage("unknown.filetype")).toBe("text");
        expect(getSyntaxClass("component.tsx")).toBe("text-blue-400");
        expect(getSyntaxClass("config.json")).toBe("text-green-400");
        expect(getSyntaxClass("unknown.filetype")).toBe("text-primary-300");
    });
});
