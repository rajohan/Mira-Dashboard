import eslintConfigs from "@eslint/js";
import { defineConfig } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tailwindcss from "eslint-plugin-tailwindcss";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tsEslint from "typescript-eslint";

const eslintConfig = defineConfig(
    {
        ignores: [
            "node_modules/**",
            ".vscode/**",
            ".git/**",
            "dist/**",
            "build/**",
            "coverage/**",
            "*.log",
            "*.tsbuildinfo",
            ".DS_Store",
            "backend/**", // CommonJS, separate tooling
        ],
    },
    eslintConfigs.configs.recommended,
    tsEslint.configs.recommended,
    reactPlugin.configs.flat["jsx-runtime"],
    {
        ...tailwindcss.configs.recommended,
        settings: {
            tailwindcss: {
                cssConfigPath: "src/index.css",
            },
        },
    },
    unicorn.configs.recommended,
    {
        files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
        ...jsxA11y.flatConfigs.recommended,
        languageOptions: {
            ...jsxA11y.flatConfigs.recommended.languageOptions,
            globals: {
                ...globals.browser,
            },
        },
    },
    {
        files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
        ...reactPlugin.configs.flat.recommended,
        ...reactHooks.configs.flat.recommended,
        languageOptions: {
            ...reactPlugin.configs.flat.recommended.languageOptions,
            globals: {
                ...globals.browser,
                ...globals.node,
                Bun: "readonly",
            },
        },
        plugins: {
            "simple-import-sort": simpleImportSort,
        },
        rules: {
            "simple-import-sort/imports": "error",
            "simple-import-sort/exports": "error",
            // Filename convention
            "unicorn/filename-case": [
                "error",
                {
                    cases: {
                        camelCase: true,
                        pascalCase: true,
                    },
                },
            ],
        },
    },
    {
        files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
        rules: {
            "tailwindcss/no-custom-classname": [
                "warn",
                {
                    whitelist: ["className", "classValues", "language-.*"],
                },
            ],
        },
    },
    eslintPluginPrettierRecommended
);

export default eslintConfig;
