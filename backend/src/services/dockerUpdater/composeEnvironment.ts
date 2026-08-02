import fs from "node:fs";
import path from "node:path";

export type ComposeEnvironment = Record<string, string>;

function stripEnvironmentComment(line: string): string {
    let quote: string | undefined;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"' || character === "'") {
            let backslashCount = 0;
            for (
                let slashIndex = index - 1;
                slashIndex >= 0 && line[slashIndex] === "\\";
                slashIndex -= 1
            ) {
                backslashCount += 1;
            }
            if (backslashCount % 2 === 1) continue;
            quote = quote === character ? undefined : (quote ?? character);
            continue;
        }
        // Compose treats inline comments as comments only when the # follows whitespace.
        if (
            character === "#" &&
            quote === undefined &&
            (index === 0 || /\s/u.test(line[index - 1] ?? ""))
        ) {
            return line.slice(0, index).trimEnd();
        }
    }
    return line;
}

function unescapeDoubleQuotedEnvironmentValue(value: string): string {
    return value.replaceAll(/\\([\\"nrt])/gu, (_match, escaped: string) => {
        if (escaped === "n") return "\n";
        if (escaped === "r") return "\r";
        if (escaped === "t") return "\t";
        return escaped;
    });
}

function parseComposeEnvironmentFile(content: string): ComposeEnvironment {
    const environment: ComposeEnvironment = {};
    for (const rawLine of content.split(/\r?\n/u)) {
        const line = stripEnvironmentComment(rawLine.trim());
        if (!line || line.startsWith("#")) continue;
        const withoutExport = line.startsWith("export ")
            ? line.slice(7).trimStart()
            : line;
        const separatorIndex = withoutExport.indexOf("=");
        if (separatorIndex <= 0) continue;
        const key = withoutExport.slice(0, separatorIndex).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
        let value = withoutExport.slice(separatorIndex + 1).trim();
        const isDoubleQuoted =
            value.length >= 2 && value.startsWith('"') && value.endsWith('"');
        const isSingleQuoted =
            value.length >= 2 && value.startsWith("'") && value.endsWith("'");
        if (isDoubleQuoted || isSingleQuoted) {
            value = value.slice(1, -1);
            if (isDoubleQuoted) {
                value = unescapeDoubleQuotedEnvironmentValue(value);
            }
        }
        environment[key] = value;
    }
    return environment;
}

function readComposeEnvironmentFile(environmentPath: string): ComposeEnvironment {
    try {
        if (!fs.existsSync(environmentPath)) return {};
        return parseComposeEnvironmentFile(fs.readFileSync(environmentPath, "utf8"));
    } catch {
        return {};
    }
}

function composeEnvironmentFilePaths(
    projectDirectory: string,
    environmentFileValue: unknown,
    composeEnvironment: ComposeEnvironment = {}
): string[] {
    return (
        Array.isArray(environmentFileValue)
            ? environmentFileValue
            : [environmentFileValue]
    )
        .filter((item): item is string => typeof item === "string")
        .map((rawEnvironmentFilePath) => {
            const environmentFilePath = interpolateComposePath(
                rawEnvironmentFilePath,
                composeEnvironment
            );
            return path.isAbsolute(environmentFilePath)
                ? environmentFilePath
                : path.resolve(projectDirectory, environmentFilePath);
        });
}

export function loadComposeEnvironmentFiles(
    projectDirectory: string,
    environmentFileValue: unknown,
    composeEnvironment: ComposeEnvironment = {}
): ComposeEnvironment {
    return Object.assign(
        {},
        ...composeEnvironmentFilePaths(
            projectDirectory,
            environmentFileValue,
            composeEnvironment
        ).map((environmentPath) => readComposeEnvironmentFile(environmentPath))
    ) as ComposeEnvironment;
}

export function loadComposeProjectEnvironment(
    projectDirectory: string,
    environmentFileValue?: unknown
): ComposeEnvironment {
    const defaultEnvironment = readComposeEnvironmentFile(
        path.join(projectDirectory, ".env")
    );
    return {
        ...defaultEnvironment,
        ...loadComposeEnvironmentFiles(
            projectDirectory,
            environmentFileValue,
            defaultEnvironment
        ),
    };
}

function resolveComposeEnvironmentValue(
    name: string,
    composeEnvironment: ComposeEnvironment
): string | undefined {
    return process.env[name] ?? composeEnvironment[name];
}

export function interpolateComposePath(
    value: string,
    composeEnvironment: ComposeEnvironment = {}
): string {
    let interpolated = value;
    for (let index = 0; index < 8; index += 1) {
        const next = interpolateComposePathOnce(interpolated, composeEnvironment);
        if (next === interpolated) return next;
        interpolated = next;
    }
    return interpolated;
}

function interpolateComposePathOnce(
    value: string,
    composeEnvironment: ComposeEnvironment = {}
): string {
    const braced = value.replaceAll(
        /\$\{([^}:?+-]+)(?:(:?[-?+])([^}]*))?\}/gu,
        (match, rawName, op, fallback) => {
            const environmentName = String(rawName);
            const environmentValue = resolveComposeEnvironmentValue(
                environmentName,
                composeEnvironment
            );
            if (!op) return environmentValue ?? match;
            const hasValue = environmentValue !== undefined && environmentValue !== "";
            if (op === ":-" || op === "-") {
                return hasValue || (op === "-" && environmentValue !== undefined)
                    ? environmentValue
                    : String(fallback);
            }
            if (op === ":+" || op === "+") {
                return hasValue || (op === "+" && environmentValue !== undefined)
                    ? String(fallback)
                    : "";
            }
            return hasValue ? environmentValue : match;
        }
    );
    return braced.replaceAll(/\$([_a-z]\w*)/giu, (match, rawName) => {
        const environmentValue = resolveComposeEnvironmentValue(
            String(rawName),
            composeEnvironment
        );
        return environmentValue ?? match;
    });
}

export function resolveComposeRelativePath(
    baseDirectory: string,
    includePath: string,
    composeEnvironment: ComposeEnvironment = {}
): string {
    const interpolatedPath = interpolateComposePath(includePath, composeEnvironment);
    return path.isAbsolute(interpolatedPath)
        ? interpolatedPath
        : path.resolve(baseDirectory, interpolatedPath);
}
