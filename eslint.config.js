import eslintConfigs from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import simpleImportSort from "eslint-plugin-simple-import-sort";
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
    unicorn.configs.recommended,
    {
        files: ["**/*.{js,mjs,cjs,jsx,ts,tsx}"],
        ...reactPlugin.configs.flat.recommended,
        ...reactHooks.configs.flat.recommended,
        languageOptions: {
            ...reactPlugin.configs.flat.recommended.languageOptions,
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        plugins: {
            "simple-import-sort": simpleImportSort,
        },
        rules: {
            "arrow-body-style": ["error", "as-needed"],
            "simple-import-sort/imports": "error",
            "simple-import-sort/exports": "error",
            // Unicorn rules - relax some aggressive defaults
            "unicorn/prevent-abbreviations": "off",
            "unicorn/no-null": "off",
            "unicorn/prefer-global-this": "off",
            "unicorn/prefer-at": "off",
            "unicorn/no-array-callback-reference": "off",
            "unicorn/consistent-function-scoping": "off",
            "unicorn/no-array-sort": "off",
            "unicorn/no-array-reverse": "off",
            "unicorn/prefer-add-event-listener": "off",
            "unicorn/switch-case-braces": "off",
            "unicorn/numeric-separators-style": "off",
            "unicorn/prefer-node-protocol": "off",
            // TypeScript
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unsafe-function-type": "warn",
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
    eslintPluginPrettierRecommended
);

export default eslintConfig;
