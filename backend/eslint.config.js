import eslintConfigs from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tsEslint from "typescript-eslint";

const eslintConfig = defineConfig(
    {
        ignores: ["node_modules/**", "dist/**", "eslint.config.js"],
    },
    eslintConfigs.configs.recommended,
    tsEslint.configs.recommended,
    unicorn.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            globals: {
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
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            // Unicorn rules - relax aggressive defaults
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