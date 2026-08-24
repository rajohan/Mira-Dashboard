import { describe, expect, test } from "bun:test";

import { type ConfigurationDocumentationInput, renderConfiguration } from "./markdown.ts";

const completeEntry = {
    allowedValues: ["alpha", "beta"],
    browserExposure: "none",
    defaultValue: "alpha",
    description: "Selects the documented behavior.",
    environmentName: "MIRA_EXAMPLE",
    field: "example",
    operationalEffect: "Changes the documented behavior.",
    overridePolicy: {
        development: true,
        test: false,
    },
    restartRequired: true,
    roles: ["web"],
    secret: false,
    validationConstraints: "One of the documented examples.",
    valueType: "example-type",
} satisfies ConfigurationDocumentationInput;

describe("application configuration Markdown", () => {
    test("renders complete metadata without mutating the registry", () => {
        const registry = Object.freeze([
            Object.freeze({
                ...completeEntry,
                allowedValues: Object.freeze([...completeEntry.allowedValues]),
                overridePolicy: Object.freeze({ ...completeEntry.overridePolicy }),
                roles: Object.freeze([...completeEntry.roles]),
            }),
        ]);

        const documentation = renderConfiguration(registry);

        expect(documentation).toContain(
            "| `MIRA_EXAMPLE` | `example` | `example-type`; `alpha`, `beta` | One of the documented examples. | `alpha` | `web` | No | None |"
        );
        expect(documentation).toContain("| Required | Development only |");
        expect(Object.isFrozen(registry[0])).toBe(true);
    });

    test("never renders secret allowed values or defaults", () => {
        const secretValue = "sentinel-secret-default";
        const documentation = renderConfiguration([
            {
                ...completeEntry,
                allowedValues: ["sentinel-secret-choice"],
                browserExposure: "presence-only",
                defaultValue: secretValue,
                secret: true,
            },
        ]);

        expect(documentation).toContain("`example-type`; values withheld");
        expect(documentation).toContain("Default value withheld");
        expect(documentation).not.toContain(secretValue);
        expect(documentation).not.toContain("sentinel-secret-choice");
    });

    test("escapes Markdown table control characters in registry text", () => {
        const documentation = renderConfiguration([
            {
                ...completeEntry,
                description: "Pipe | backslash \\ and\nnew line.",
            },
        ]);

        expect(documentation).toContain(String.raw`Pipe \| backslash \\ and new line.`);
    });

    test("fails closed when required metadata is missing", () => {
        const requiredFields = [
            "allowedValues",
            "browserExposure",
            "defaultValue",
            "description",
            "environmentName",
            "field",
            "operationalEffect",
            "overridePolicy",
            "restartRequired",
            "roles",
            "secret",
            "validationConstraints",
            "valueType",
        ] as const;

        for (const field of requiredFields) {
            const incomplete = { ...completeEntry } as Record<string, unknown>;
            delete incomplete[field];
            expect(() =>
                renderConfiguration([
                    incomplete as unknown as ConfigurationDocumentationInput,
                ])
            ).toThrow();
        }
    });

    test("rejects browser value exposure for secrets", () => {
        expect(() =>
            renderConfiguration([
                {
                    ...completeEntry,
                    browserExposure: "value",
                    secret: true,
                },
            ])
        ).toThrow(
            "Secret application configuration metadata permits browser value exposure"
        );
    });
});
