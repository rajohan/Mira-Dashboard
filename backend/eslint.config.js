import eslintConfigs from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";

export default defineConfig(
    {
        ignores: ["node_modules/**", "eslint.config.js"],
    },
    eslintConfigs.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
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
            "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
        },
    },
    eslintPluginPrettierRecommended
);
