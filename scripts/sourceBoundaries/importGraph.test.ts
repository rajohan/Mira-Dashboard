import { describe, expect, test } from "bun:test";

import { parseSourceAnalysis, parseSourceImports } from "./importGraph.ts";

describe("source-boundary import parsing", () => {
    test("finds value, type-only, side-effect, re-export, and dynamic edges", async () => {
        const imports = await parseSourceImports(
            `
                import type { Contract } from "../contracts/type.ts";
                import { value } from "../shared/value.ts";
                import "./sideEffect.ts";
                import manifest from "./manifest.json" with { type: "json" };
                import alias = require("../shared/alias.ts");
                export type { Result } from "../contracts/result.ts";
                export * from "../shared/all.ts";
                const lazy = import("../browser/lazy.tsx");
                type Imported = import("../contracts/imported.ts").Imported;
            `,
            "src/browser/example.ts"
        );

        expect(imports.map(({ kind, specifier }) => ({ kind, specifier }))).toEqual([
            { kind: "import", specifier: "../contracts/type.ts" },
            { kind: "import", specifier: "../shared/value.ts" },
            { kind: "import", specifier: "./sideEffect.ts" },
            { kind: "import", specifier: "./manifest.json" },
            { kind: "require", specifier: "../shared/alias.ts" },
            { kind: "export", specifier: "../contracts/result.ts" },
            { kind: "export", specifier: "../shared/all.ts" },
            { kind: "dynamic-import", specifier: "../browser/lazy.tsx" },
            { kind: "import", specifier: "../contracts/imported.ts" },
        ]);
    });

    test("selects TypeScript or TSX grammar from the filename", async () => {
        const typescriptImports = await parseSourceImports(
            `
                const identity = <Value>(value: Value): Value => value;
                export { identity } from "../shared/identity.ts";
            `,
            "src/browser/identity.ts"
        );
        const tsxImports = await parseSourceImports(
            `
                import { Fragment } from "react";
                export const view = <Fragment />;
            `,
            "src/browser/view.tsx"
        );

        expect(typescriptImports).toHaveLength(1);
        expect(tsxImports).toHaveLength(1);
    });

    test("selects all supported JavaScript and TypeScript grammars", async () => {
        for (const extension of ["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"]) {
            const imports = await parseSourceImports(
                'const dependency = require("../shared/dependency.ts"); void dependency;',
                `src/browser/example.${extension}`
            );
            expect(imports).toEqual([
                {
                    kind: "require",
                    line: 1,
                    specifier: "../shared/dependency.ts",
                },
            ]);
        }
    });

    test("finds literal require calls and retains nonliteral loads", async () => {
        const imports = await parseSourceImports(
            `
                const literal = require("../shared/literal.ts");
                export const load = (name: string) => [literal, import(name), require(name)];
            `,
            "src/browser/load.ts"
        );

        expect(imports).toEqual([
            {
                kind: "require",
                line: 2,
                specifier: "../shared/literal.ts",
            },
            { kind: "dynamic-import", line: 3 },
            { kind: "require", line: 3 },
        ]);
    });

    test("finds alternate direct runtime-environment access forms", async () => {
        const analysis = await parseSourceAnalysis(
            `
                const port = process.env.PORT;
                const bunPort = Bun["env"].PORT;
                const denoPort = Deno?.env.get("PORT");
                const mode = import.meta.env.MODE;
                const globalPort = globalThis.process.env.PORT;
                const { env: projected } = process;
                ({ env: assigned } = Bun);
            `,
            "src/worker/environment.ts"
        );

        expect(analysis.environmentAccesses.map(({ line }) => line)).toEqual([
            2, 3, 4, 5, 6, 7, 8,
        ]);
    });

    test("fails closed on optional or escaped require and runtime-owner aliases", async () => {
        const analysis = await parseSourceAnalysis(
            `const runtime = process;
             const loaded = require?.("../server/optional.ts");
             const loader = require;
             const dynamic = Bun[propertyName];
             void [runtime, loaded, loader, dynamic];`,
            "src/browser/escape.ts"
        );

        expect(analysis.environmentAccesses).toEqual([]);
        expect(analysis.runtimeAuthorityEscapes).toEqual([{ line: 1 }, { line: 4 }]);
        expect(analysis.imports).toEqual([
            {
                kind: "require",
                line: 2,
                specifier: "../server/optional.ts",
            },
            { kind: "module-loader", line: 3 },
        ]);
    });

    test("fails closed on global-root and runtime-owner alias variants", async () => {
        const analysis = await parseSourceAnalysis(
            `const root = globalThis;
             const nestedRoot = globalThis["globalThis"];
             const processAlias = globalThis["process"];
             const reflectedProcess = Reflect.get(globalThis, "process");
             const processOwner = process;
             const bunOwner = Bun;
             const denoOwner = Deno;
             const metaOwner = import.meta;
             consume(process);
             const wrapped = { process };
             const secret = globalThis["process"].env.SECRET;
             void [root, nestedRoot, processAlias, reflectedProcess, processOwner, bunOwner, denoOwner, metaOwner, wrapped, secret];`,
            "src/server/authorityEscape.ts"
        );

        expect(analysis.environmentAccesses).toEqual([{ line: 11 }]);
        expect(analysis.runtimeAuthorityEscapes.map(({ line }) => line)).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ]);
    });

    test("treats erased type-only bindings as runtime globals", async () => {
        const analysis = await parseSourceAnalysis(
            `// @ts-nocheck
             import type { process } from "./processTypes.ts";
             import { type Bun } from "./bunTypes.ts";
             import type globalThis from "./globalTypes.ts";
             import type * as Deno from "./denoTypes.ts";
             import type { RuntimeWindow as window, RuntimeFunction as Function } from "./runtimeTypes.ts";
             // @ts-expect-error intentional escape probe
             process.env.SECRET;
             // @ts-ignore intentional escape probe
             Bun.env.SECRET;
             Deno.env.SECRET;
             globalThis.process.env.SECRET;
             window.process.env.SECRET;
             Function(source);`,
            "src/browser/erasedBindings.ts"
        );

        expect(analysis.environmentAccesses.map(({ line }) => line)).toEqual([
            8, 10, 11, 12, 13,
        ]);
        expect(
            analysis.imports
                .filter(({ kind }) => kind === "dynamic-code")
                .map(({ line }) => line)
        ).toEqual([14]);
        expect(analysis.typeScriptSuppressionDirectives).toEqual([
            { line: 1 },
            { line: 7 },
            { line: 9 },
        ]);
    });

    test("finds createRequire sources and equivalent module-loader forms", async () => {
        const analysis = await parseSourceAnalysis(
            `import { createRequire as makeLoader } from "node:module";
             const load = makeLoader(import.meta.url);
             const fromMeta = import.meta.require("../server/meta.ts");
             const fromModule = module["require"]("../server/module.ts");
             const escaped = module.require;
             const builtin = process.getBuiltinModule("node:module");
             const dynamicBuiltin = process["getBuiltinModule"](moduleName);
             const reflected = Reflect.get(module, "require");
             void [load, fromMeta, fromModule, escaped, builtin, dynamicBuiltin, reflected];`,
            "src/browser/moduleEscape.ts"
        );

        expect(analysis.imports).toEqual([
            {
                kind: "import",
                importedBindings: [{ imported: "createRequire", typeOnly: false }],
                line: 1,
                specifier: "node:module",
            },
            {
                kind: "require",
                line: 3,
                specifier: "../server/meta.ts",
            },
            {
                kind: "require",
                line: 4,
                specifier: "../server/module.ts",
            },
            { kind: "module-loader", line: 5 },
            {
                kind: "module-loader",
                line: 6,
                specifier: "node:module",
            },
            { kind: "module-loader", line: 7 },
            { kind: "module-loader", line: 8 },
        ]);
    });

    test("finds runtime-owned internal and native loader APIs", async () => {
        const analysis = await parseSourceAnalysis(
            `process.binding("fs");
             globalThis.process["_linked" + "Binding"]("fs");
             const bindingKey = "bin" + "ding";
             const escapedBinding = process[bindingKey];
             process.dlopen(nativeModule, filename);
             Bun.plugin(plugin);
             const pluginKey = \`plugin\` as const;
             const escapedPlugin = globalThis.Bun[pluginKey];
             const ffiKey = "F" + "FI";
             const escapedFfi = globalThis.Bun[ffiKey];
             module["_com" + "pile"](source, filename);
             const { env, ...processRest } = process;
             function localOwners(process: { binding(): void }, Bun: { plugin(): void; FFI: unknown }, module: { _compile(): void }) {
                 process.binding();
                 Bun.plugin();
                 void Bun.FFI;
                 module._compile();
             }
             void [escapedBinding, escapedPlugin, escapedFfi, processRest, localOwners];`,
            "src/server/nativeLoader.ts"
        );

        expect(analysis.environmentAccesses).toEqual([{ line: 12 }]);
        expect(analysis.imports).toEqual([
            { kind: "module-loader", line: 1 },
            { kind: "module-loader", line: 2 },
            { kind: "module-loader", line: 4 },
            { kind: "module-loader", line: 5 },
            { kind: "module-loader", line: 6 },
            { kind: "module-loader", line: 8 },
            { kind: "module-loader", line: 10 },
            { kind: "dynamic-code", line: 11 },
        ]);
        expect(analysis.runtimeAuthorityEscapes).toEqual([{ line: 12 }]);
    });

    test("finds unbound worker entrypoint loaders", async () => {
        const analysis = await parseSourceAnalysis(
            `new Worker("../worker/entry.ts");
             const WorkerAlias = Worker;
             new globalThis["Wor" + "ker"]("../worker/global.ts");
             new SharedWorker("../worker/shared.ts");
             importScripts("./bootstrap.ts");
             self["import" + "Scripts"]("./computed.ts");
             function localWorker(Worker: new () => unknown) { return new Worker(); }
             void [WorkerAlias, localWorker];`,
            "src/browser/workerLoader.ts"
        );

        expect(analysis.imports).toEqual([
            { kind: "module-loader", line: 1 },
            { kind: "module-loader", line: 2 },
            { kind: "module-loader", line: 3 },
            { kind: "module-loader", line: 4 },
            { kind: "module-loader", line: 5 },
            { kind: "module-loader", line: 6 },
        ]);
    });

    test("finds global WebAssembly authority while allowing local shadows", async () => {
        const analysis = await parseSourceAnalysis(
            `WebAssembly.instantiate(bytes);
             const compile = WebAssembly["com" + "pile"];
             const ModuleAlias = globalThis["Web" + "Assembly"].Module;
             const reflected = Reflect.get(globalThis, "WebAssembly");
             const { WebAssembly: destructured } = globalThis;
             function local(WebAssembly: { instantiate(value: unknown): unknown }) { return WebAssembly.instantiate(bytes); }
             void [compile, ModuleAlias, reflected, destructured, local];`,
            "src/browser/webAssembly.ts"
        );

        expect(
            analysis.imports
                .filter(({ kind }) => kind === "dynamic-code")
                .map(({ line }) => line)
        ).toEqual([1, 2, 3, 4, 5]);
    });

    test("finds service-worker, worklet, and string-timer loaders", async () => {
        const analysis = await parseSourceAnalysis(
            `navigator.serviceWorker.register("./serviceWorker.ts");
             const serviceWorker = globalThis.navigator["service" + "Worker"];
             const reflectedWorker = Reflect.get(navigator, "serviceWorker");
             CSS.paintWorklet["add" + "Module"]("./paintWorklet.ts");
             const workletLoad = audioWorklet.addModule;
             const timerAlias = setTimeout;
             const code = "do" + "Work()";
             setTimeout(code, 0);
             globalThis["set" + "Interval"](\`tick()\`, 1000);
             setTimeout(() => undefined, 0);
             setInterval(callback, 1000);
             function local(navigator: { serviceWorker: unknown }, setTimeout: (callback: string) => void, setInterval: (callback: string) => void) { navigator.serviceWorker; setTimeout("local", 0); setInterval("local", 0); }
             void [serviceWorker, reflectedWorker, workletLoad, timerAlias, local];`,
            "src/browser/browserLoaders.ts"
        );

        expect(
            analysis.imports
                .filter(({ kind }) => kind === "module-loader")
                .map(({ line }) => line)
        ).toEqual([1, 2, 3, 4, 5]);
        expect(
            analysis.imports
                .filter(({ kind }) => kind === "dynamic-code")
                .map(({ line }) => line)
        ).toEqual([6, 8, 9]);
    });

    test("finds Bun process and shell execution with binding awareness", async () => {
        const analysis = await parseSourceAnalysis(
            `Bun.spawn(["true"]);
             globalThis.Bun["spawn" + "Sync"](["true"]);
             const spawnAlias = Bun.spawn;
             Bun.$\`echo blocked\`;
             Bun["$"]("echo blocked");
             function local(Bun: { spawn(): void; $(): void }) { Bun.spawn(); Bun.$(); }
             void [spawnAlias, local];`,
            "scripts/processExecution.ts"
        );

        expect(
            analysis.imports
                .filter(({ kind }) => kind === "process-execution")
                .map(({ line }) => line)
        ).toEqual([1, 2, 3]);
        expect(
            analysis.imports
                .filter(({ kind }) => kind === "shell-execution")
                .map(({ line }) => line)
        ).toEqual([4, 5]);
    });

    test("finds Bun process.execve authority with binding awareness", async () => {
        const analysis = await parseSourceAnalysis(
            `process.execve("/bin/true", ["true"], {});
             globalThis.process["exec" + "ve"]("/bin/true", ["true"], {});
             const execute = process.execve;
             const reflected = Reflect.get(process, "execve");
             function local(process: { execve(): void }, Reflect: { get(owner: unknown, property: string): unknown }) { process.execve(); return Reflect.get(process, "execve"); }
             void [execute, reflected, local];`,
            "src/server/processExecve.ts"
        );

        expect(
            analysis.imports
                .filter(({ kind }) => kind === "process-execution")
                .map(({ line }) => line)
        ).toEqual([1, 2, 3, 4]);
    });

    test("retains exact imported bindings and type erasure for Bun imports", async () => {
        const analysis = await parseSourceAnalysis(
            `import type { Server } from "bun";
             import { CookieMap as Cookies, type Server as ServerType } from "bun";
             import BunDefault from "bun";
             import * as BunRuntime from "bun";
             import "bun";
             void [Cookies, BunDefault, BunRuntime];`,
            "scripts/bunImports.ts"
        );

        expect(analysis.imports.map(({ importedBindings }) => importedBindings)).toEqual([
            [{ imported: "Server", typeOnly: true }],
            [
                { imported: "CookieMap", typeOnly: false },
                { imported: "Server", typeOnly: true },
            ],
            [{ imported: "default", typeOnly: false }],
            [{ imported: "*", typeOnly: false }],
            [],
        ]);
    });

    test("finds eval, Function, reflected, and constructor code loaders", async () => {
        const analysis = await parseSourceAnalysis(
            `eval(source);
             const execute = eval;
             const generated = new Function("return import(name)");
             const globalGenerated = globalThis["Function"]("return 1");
             const AsyncFunction = (async () => {}).constructor;
             const reflected = Reflect.get(globalThis, "eval");
             const inherited = Object.getPrototypeOf(() => {}).constructor;
             const { constructor: Constructor } = handler;
             void [execute, generated, globalGenerated, AsyncFunction, reflected, inherited, Constructor];`,
            "src/server/dynamicCode.ts"
        );

        expect(analysis.imports).toEqual([
            { kind: "dynamic-code", line: 1 },
            { kind: "dynamic-code", line: 2 },
            { kind: "dynamic-code", line: 3 },
            { kind: "dynamic-code", line: 4 },
            { kind: "dynamic-code", line: 5 },
            { kind: "dynamic-code", line: 6 },
            { kind: "dynamic-code", line: 7 },
            { kind: "dynamic-code", line: 8 },
        ]);
    });

    test("folds bounded computed loader keys and rejects unresolved reflection", async () => {
        const analysis = await parseSourceAnalysis(
            `const constructorKey = "con" + "structor";
             const execute = (() => {})[constructorKey as "constructor"];
             execute("return process.env.SECRET")();
             const direct = (() => {})["con" + "structor"];
             const evalKey = (\`ev\` + ("al" as string)) as const;
             const indirectEval = globalThis[evalKey];
             const requireKey = "requ" + "ire";
             const loaded = module[requireKey as "require"]("../server/secret.ts");
             const templateKey = \`require\` as const;
             const templateLoaded = module[templateKey]("../server/template.ts");
             const reflected = Reflect.get(() => {}, ["con", "structor"].join(""))("return process.env.SECRET");
             const reflectedGet = Reflect.get;
             const moduleAlias = module;
             const unknownLoad = module[unknownKey]("../server/dynamic.ts");
             void [direct, indirectEval, loaded, templateLoaded, reflected, reflectedGet, moduleAlias, unknownLoad];`,
            "src/browser/computedLoader.ts"
        );

        expect(analysis.environmentAccesses).toEqual([]);
        expect(analysis.imports).toEqual([
            { kind: "dynamic-code", line: 2 },
            { kind: "dynamic-code", line: 4 },
            { kind: "dynamic-code", line: 6 },
            {
                kind: "require",
                line: 8,
                specifier: "../server/secret.ts",
            },
            {
                kind: "require",
                line: 10,
                specifier: "../server/template.ts",
            },
            { kind: "module-loader", line: 11 },
            { kind: "module-loader", line: 12 },
        ]);
        expect(analysis.runtimeAuthorityEscapes).toEqual([{ line: 13 }, { line: 14 }]);
    });

    test("distinguishes runtime ambient declarations from pure types", async () => {
        const analysis = await parseSourceAnalysis(
            `export {};
             declare function fetch(input: string): Promise<unknown>;
             declare const process: { env: Record<string, string> };
             declare class RuntimeClass {}
             declare enum RuntimeEnum { Value }
             declare namespace RuntimeNamespace { const value: string; }
             declare global { const injected: string; }
             declare module "runtime-module" { export const value: string; }
             declare interface SafeShape { readonly value: string; }
             declare type SafeAlias = string;
             function overloaded(value: string): string;
             function overloaded(value: string): string { return value; }`,
            "src/shared/ambient.ts"
        );

        expect(analysis.ambientRuntimeDeclarations.map(({ line }) => line)).toEqual([
            2, 3, 4, 5, 6, 7, 8,
        ]);
    });

    test("finds triple-slash directives that can restore ambient authority", async () => {
        const analysis = await parseSourceAnalysis(
            `/// <reference lib="dom" />
             /// <reference types="node" />
             /// <reference path="../server/private.ts" />
             export const value = true;`,
            "src/shared/authority.ts"
        );

        expect(analysis.referenceDirectives).toEqual([
            { line: 1 },
            { line: 2 },
            { line: 3 },
        ]);
    });
});
