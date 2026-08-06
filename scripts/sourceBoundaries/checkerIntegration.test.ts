import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkSourceBoundaries } from "../checkSourceBoundaries.ts";

async function temporaryProject(): Promise<string> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-source-boundary-"));
    await mkdir(path.join(projectRoot, "scripts"));
    await mkdir(path.join(projectRoot, "src", "browser"), { recursive: true });
    await writeFile(path.join(projectRoot, "package.json"), "{}");
    return projectRoot;
}

describe("source-boundary checker integration", () => {
    test("rejects triple-slash lib, types, and path authority directives", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "shared"));
            await writeFile(
                path.join(projectRoot, "src", "shared", "authority.ts"),
                `/// <reference lib="dom" />
                 /// <reference types="node" />
                 /// <reference path="../server/private.ts" />
                 export const network = globalThis.fetch;`
            );

            const violations = await checkSourceBoundaries(projectRoot);
            const directiveViolations = violations.filter(
                (violation) =>
                    violation.importer === "src/shared/authority.ts" &&
                    violation.message.includes("Triple-slash reference directives")
            );

            expect(directiveViolations.map(({ line }) => line)).toEqual([1, 2, 3]);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects indirect loaders, dynamic code, and runtime-root aliases", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "server"));
            await writeFile(
                path.join(projectRoot, "src", "browser", "loader.ts"),
                `import { createRequire as makeLoader } from "node:module";
                 const load = makeLoader(import.meta.url);
                 const metaLoad = import.meta.require("../server/private.ts");
                 const moduleLoad = module.require("../server/private.ts");
                 void [load, metaLoad, moduleLoad];`
            );
            await writeFile(
                path.join(projectRoot, "src", "server", "authority.ts"),
                `const root = globalThis;
                 const secret = root.process.env.SECRET;
                 const reflected = Reflect.get(globalThis, "process");
                 const processOwner = process;
                 const bunOwner = Bun;
                 const denoOwner = Deno;
                 const metaOwner = import.meta;
                 const generated = Function("return import(name)");
                 void [secret, reflected, processOwner, bunOwner, denoOwner, metaOwner, generated];`
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "computedLoader.ts"),
                `const constructorKey = "con" + "structor";
                 const execute = (() => {})[constructorKey as "constructor"];
                 execute("return process.env.SECRET")();
                 const requireKey = "requ" + "ire";
                 const loaded = module[requireKey]("../server/private.ts");
                 const reflected = Reflect.get(() => {}, ["con", "structor"].join(""))("return process.env.SECRET");
                 const moduleAlias = module;
                 const unknownLoad = module[unknownKey]("../server/private.ts");
                 void [loaded, reflected, moduleAlias, unknownLoad];`
            );
            await writeFile(
                path.join(projectRoot, "src", "server", "nativeLoader.ts"),
                `process.binding("fs");
                 process["_linked" + "Binding"]("fs");
                 process.dlopen(nativeModule, filename);
                 Bun.plugin(plugin);
                 const bindingKey = "bin" + "ding";
                 const escapedBinding = globalThis.process[bindingKey];
                 const ffi = Bun["F" + "FI"];
                 module["_com" + "pile"](source, filename);
                 void [escapedBinding, ffi];`
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "workerLoader.ts"),
                `new Worker("../worker/entry.ts");
                 const WorkerAlias = Worker;
                 new globalThis["Wor" + "ker"]("../worker/global.ts");
                 new SharedWorker("../worker/shared.ts");
                 importScripts("./bootstrap.ts");
                 void WorkerAlias;`
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/loader.ts" &&
                        violation.specifier === "node:module" &&
                        violation.message.includes("dynamic module-loader")
                )
            ).toBe(true);
            for (const line of [3, 4]) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === "src/browser/loader.ts" &&
                            violation.line === line &&
                            violation.message.includes("browser may not import server")
                    )
                ).toBe(true);
            }
            for (const line of [1, 3, 4, 5, 6, 7]) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === "src/server/authority.ts" &&
                            violation.line === line &&
                            violation.message.includes("runtime/global authority")
                    )
                ).toBe(true);
            }
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/authority.ts" &&
                        violation.line === 8 &&
                        violation.message.includes("dynamic-code primitives")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/computedLoader.ts" &&
                        violation.line === 2 &&
                        violation.message.includes("dynamic-code primitives")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/computedLoader.ts" &&
                        violation.line === 5 &&
                        violation.message.includes("browser may not import server")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/computedLoader.ts" &&
                        violation.line === 6 &&
                        violation.message.includes("module-loader primitive")
                )
            ).toBe(true);
            for (const line of [7, 8]) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === "src/browser/computedLoader.ts" &&
                            violation.line === line &&
                            violation.message.includes("runtime/global authority")
                    )
                ).toBe(true);
            }
            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/server/nativeLoader.ts" &&
                            violation.message.includes("module-loader primitive")
                    )
                    .map(({ line }) => line)
            ).toEqual([1, 2, 3, 4, 6, 7]);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/nativeLoader.ts" &&
                        violation.line === 8 &&
                        violation.message.includes("dynamic-code primitives")
                )
            ).toBe(true);
            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/browser/workerLoader.ts" &&
                            violation.message.includes("module-loader primitive")
                    )
                    .map(({ line }) => line)
            ).toEqual([1, 2, 3, 4, 5]);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects WebAssembly, browser loaders, string timers, and unsafe process execution", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "server"));
            await writeFile(
                path.join(projectRoot, "src", "browser", "runtimeLoaders.ts"),
                `WebAssembly.instantiate(bytes);
                 const compile = globalThis["Web" + "Assembly"].compile;
                 navigator.serviceWorker.register("./serviceWorker.ts");
                 CSS.paintWorklet["add" + "Module"]("./paint.ts");
                 const code = "do" + "Work()";
                 setTimeout(code, 0);
                 globalThis.setInterval(\`tick()\`, 1000);
                 setTimeout(() => undefined, 0);
                 function local(WebAssembly: unknown, navigator: unknown, setTimeout: (callback: string) => void) { setTimeout("local", 0); return [WebAssembly, navigator]; }
                 void [compile, local];`
            );
            await writeFile(
                path.join(projectRoot, "src", "server", "processExecution.ts"),
                `Bun.spawn(["true"]);
                 process.execve("/bin/true", ["true"], {});
                 const reflected = Reflect.get(globalThis.process, "execve");
                 Bun["$"]("echo blocked");
                 void reflected;`
            );
            await writeFile(
                path.join(projectRoot, "scripts", "processExecution.ts"),
                `Bun["spawn" + "Sync"](["true"]);
                 process.execve("/bin/true", ["true"], {});
                 Bun.$\`echo blocked\`;`
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/browser/runtimeLoaders.ts" &&
                            violation.message.includes("dynamic-code primitives")
                    )
                    .map(({ line }) => line)
            ).toEqual([1, 2, 6, 7]);
            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/browser/runtimeLoaders.ts" &&
                            violation.message.includes("module-loader primitive")
                    )
                    .map(({ line }) => line)
            ).toEqual([3, 4]);
            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/server/processExecution.ts" &&
                            violation.message.includes("process-execution authority")
                    )
                    .map(({ line }) => line)
            ).toEqual([1, 2, 3]);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/server/processExecution.ts" &&
                        violation.line === 4 &&
                        violation.message.includes("Bun.$ shell-execution")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "scripts/processExecution.ts" &&
                        violation.message.includes("process-execution authority")
                )
            ).toBe(false);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "scripts/processExecution.ts" &&
                        violation.line === 3 &&
                        violation.message.includes("Bun.$ shell-execution")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects imported builtin and Bun authority before aliasing", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "server"));
            await mkdir(path.join(projectRoot, "src", "worker"));
            await writeFile(
                path.join(projectRoot, "package.json"),
                JSON.stringify({
                    dependencies: {
                        child_process: "1.0.0",
                        module: "1.0.0",
                        process: "1.0.0",
                        vm: "1.0.0",
                        wasi: "1.0.0",
                        worker_threads: "1.0.0",
                    },
                })
            );
            await writeFile(
                path.join(projectRoot, "src", "server", "importedAuthority.ts"),
                `import { createRequire as makeLoader } from "module";
                 import { runInContext } from "vm";
                 import { Worker as ThreadWorker } from "worker_threads";
                 import { fork } from "node:child_process";
                 import processAlias from "process";
                 import test from "node:test";
                 import { plugin, spawn, spawnSync, $ as shell } from "bun";
                 import { dlopen } from "bun:ffi";
                 import { WASI as NodeWasi } from "node:wasi";
                 import { WASI as BareWasi } from "wasi";
                 void [makeLoader, runInContext, ThreadWorker, fork, processAlias, test, plugin, spawn, spawnSync, shell, dlopen, NodeWasi, BareWasi];`
            );
            await writeFile(
                path.join(projectRoot, "scripts", "allowedProcess.ts"),
                `import { spawn } from "child_process";
                 Bun.spawn(["true"]);
                 void spawn;`
            );
            await writeFile(
                path.join(projectRoot, "src", "worker", "allowedProcess.ts"),
                `import { spawn } from "node:child_process";
                 Bun.spawn(["true"]);
                 void spawn;`
            );

            const violations = await checkSourceBoundaries(projectRoot);

            const rejectedSpecifiers = new Set(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/server/importedAuthority.ts"
                    )
                    .map(({ specifier }) => specifier)
            );
            for (const specifier of [
                "bun",
                "bun:ffi",
                "module",
                "node:child_process",
                "node:test",
                "node:wasi",
                "process",
                "vm",
                "wasi",
                "worker_threads",
            ] as const) {
                expect(rejectedSpecifiers.has(specifier)).toBe(true);
            }
            for (const importer of [
                "scripts/allowedProcess.ts",
                "src/worker/allowedProcess.ts",
            ] as const) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === importer &&
                            (violation.specifier?.includes("child_process") === true ||
                                violation.message.includes("process-execution authority"))
                    )
                ).toBe(false);
            }
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("rejects ambient runtime declarations and declaration files", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "contracts"));
            await mkdir(path.join(projectRoot, "src", "server"));
            await mkdir(path.join(projectRoot, "src", "shared"));
            await writeFile(
                path.join(projectRoot, "src", "contracts", "escape.d.ts"),
                "declare function fetch(input: string): Promise<unknown>;"
            );
            await writeFile(
                path.join(projectRoot, "src", "shared", "ambient.ts"),
                `export {};
                 declare const process: { env: Record<string, string> };
                 declare function fetch(input: string): Promise<unknown>;
                 declare global { const injected: string; }
                 declare module "runtime-module" { export const value: string; }
                 declare interface SafeShape { readonly value: string; }
                 declare type SafeAlias = string;`
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "ambient.ts"),
                `declare const process: { env: Record<string, string> };
                 export const secret = process.env.SECRET;`
            );
            await writeFile(
                path.join(projectRoot, "src", "server", "ambient.ts"),
                `declare function eval(source: string): unknown;
                 export const result = eval("return process.env.SECRET");`
            );
            await writeFile(
                path.join(projectRoot, "src", "shared", "types.ts"),
                "export interface process { readonly marker: string; }"
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "erasedBinding.ts"),
                `import type { process } from "../shared/types.ts";
                 // @ts-expect-error intentional authority probe
                 export const secret = process.env.SECRET;`
            );

            const violations = await checkSourceBoundaries(projectRoot);

            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/contracts/escape.d.ts" &&
                        violation.message.includes("declaration files are forbidden")
                )
            ).toBe(true);
            expect(
                violations
                    .filter(
                        (violation) =>
                            violation.importer === "src/shared/ambient.ts" &&
                            violation.message.includes("ambient runtime values")
                    )
                    .map(({ line }) => line)
            ).toEqual([2, 3, 4, 5]);
            for (const importer of ["src/browser/ambient.ts", "src/server/ambient.ts"]) {
                expect(
                    violations.some(
                        (violation) =>
                            violation.importer === importer &&
                            violation.message.includes("ambient runtime values")
                    )
                ).toBe(true);
            }
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/erasedBinding.ts" &&
                        violation.line === 3 &&
                        violation.message.includes("typed configuration")
                )
            ).toBe(true);
            expect(
                violations.some(
                    (violation) =>
                        violation.importer === "src/browser/erasedBinding.ts" &&
                        violation.line === 2 &&
                        violation.message.includes("suppress TypeScript diagnostics")
                )
            ).toBe(true);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });
});
