import { defineConfig } from "oxfmt";

export default defineConfig({
    endOfLine: "lf",
    ignorePatterns: [
        "CHANGELOG.md",
        "**/coverage/**",
        "data/**",
        "**/dist/**",
        "docs/generated/**",
        "migrations/**",
        "**/node_modules/**",
        "**/*.min.css",
        "**/*.min.js",
    ],
    printWidth: 90,
    semi: true,
    singleQuote: false,
    sortImports: true,
    sortPackageJson: true,
    sortTailwindcss: {
        functions: ["clsx", "cn", "twMerge"],
    },
    tabWidth: 4,
    trailingComma: "es5",
    useTabs: false,
});
