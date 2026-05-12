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

function guardedPathBuffer(path: GuardedPath): Buffer {
    return Buffer.from(path);
}

export function mkdirGuarded(path: GuardedPath, options: { recursive: true }): void {
    fsOps.mkdirSync(guardedPathBuffer(path), options);
}

export function readJson5Guarded(path: GuardedPath): string {
    return fsOps.readFileSync(guardedPathBuffer(path), "utf8");
}

export function readTextGuarded(path: GuardedPath): string {
    return fsOps.readFileSync(guardedPathBuffer(path), "utf8");
}

export function copyGuarded(source: GuardedPath, destination: GuardedPath): void {
    fsOps.copyFileSync(guardedPathBuffer(source), guardedPathBuffer(destination));
}

export function writeTextGuarded(path: GuardedPath, content: string): void {
    const fd = fsOps.openSync(guardedPathBuffer(path), "w");
    try {
        Fs.writeSync(fd, content, undefined, "utf8");
    } finally {
        Fs.closeSync(fd);
    }
}

export function statGuarded(path: GuardedPath): Fs.Stats {
    return fsOps.statSync(guardedPathBuffer(path));
}

export function openGuarded(path: GuardedPath, flags: number): number {
    return fsOps.openSync(guardedPathBuffer(path), flags);
}

export function spawnGuarded(
    executable: string,
    args: string[],
    options: ChildProcess.SpawnOptions
): ChildProcess.ChildProcess {
    return Reflect.apply(childProcessOps.spawn, childProcessOps, [
        executable,
        args,
        options,
    ]) as ChildProcess.ChildProcess;
}
