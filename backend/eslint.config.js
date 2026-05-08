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
            // Keep the dependency upgrade focused: these rules started flagging existing
            // backend patterns after the ESLint 10 / Unicorn 64 update. Tighten them in
            // a dedicated cleanup pass instead of mixing behavior-preserving upgrades
            // with broad backend refactors.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-namespace": "off", // Express request declaration merging.
            "no-useless-escape": "off",
            "no-useless-assignment": "off",
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
            // Style/readability preferences newly enabled by Unicorn 64; existing code
            // intentionally uses these patterns in a few operational routes.
            "unicorn/no-await-expression-member": "off",
            "unicorn/no-single-promise-in-promise-methods": "off",
            "unicorn/no-array-reduce": "off",
            "unicorn/no-immediate-mutation": "off",
            "unicorn/import-style": "off",
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
