import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";

export type GuardedPath = string & { readonly __guardedPath: unique symbol };

export function guardedPath(path: string): GuardedPath {
    return path as GuardedPath;
}

const fsOps = Fs as unknown as {
    mkdirSync: typeof Fs.mkdirSync;
    readFileSync: typeof Fs.readFileSync;
    copyFileSync: typeof Fs.copyFileSync;
    writeFileSync: typeof Fs.writeFileSync;
    statSync: typeof Fs.statSync;
    openSync: typeof Fs.openSync;
};

const childProcessOps = ChildProcess as unknown as {
    spawn: typeof ChildProcess.spawn;
};

export function mkdirGuarded(path: GuardedPath, options: { recursive: true }): void {
    fsOps.mkdirSync(path, options);
}

export function readJson5Guarded(path: GuardedPath): string {
    return fsOps.readFileSync(path, "utf8");
}

export function readTextGuarded(path: GuardedPath): string {
    return fsOps.readFileSync(path, "utf8");
}

export function copyGuarded(source: GuardedPath, destination: GuardedPath): void {
    fsOps.copyFileSync(source, destination);
}

export function writeTextGuarded(path: GuardedPath, content: string): void {
    fsOps.writeFileSync(path, content, "utf8");
}

export function statGuarded(path: GuardedPath): Fs.Stats {
    return fsOps.statSync(path);
}

export function openGuarded(path: GuardedPath, flags: number): number {
    return fsOps.openSync(path, flags);
}

export function spawnGuarded(
    executable: string,
    args: string[],
    options: ChildProcess.SpawnOptions
): ChildProcess.ChildProcess {
    return childProcessOps.spawn(executable, args, options);
}
