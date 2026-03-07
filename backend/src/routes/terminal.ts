import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import express from "express";

interface CompletionRequest {
    partial: string;
    cwd: string;
}

interface CompletionItem {
    completion: string;
    type: "file" | "directory" | "executable";
    display: string;
}

interface CompletionResponse {
    completions: CompletionItem[];
    commonPrefix: string;
}

const HOME_DIR = "/home/ubuntu";

function expandPath(inputPath: string, cwd: string): string {
    if (inputPath.startsWith("/")) return inputPath;
    if (inputPath.startsWith("~/")) return HOME_DIR + inputPath.slice(1);
    if (inputPath === "~") return HOME_DIR;
    return join(cwd, inputPath);
}

async function getCompletions(partial: string, cwd: string): Promise<CompletionResponse> {
    const trimmed = partial.trim();
    
    // Extract the path part being completed (after last space for commands)
    const lastSpaceIndex = trimmed.lastIndexOf(" ");
    const pathPart = lastSpaceIndex >= 0 ? trimmed.slice(lastSpaceIndex + 1) : trimmed;
    const prefix = lastSpaceIndex >= 0 ? trimmed.slice(0, lastSpaceIndex + 1) : "";
    
    // Determine directory to search in
    let searchDir: string;
    let searchPrefix: string;
    let dirPart = "";
    
    if (pathPart.includes("/")) {
        const lastSlashIndex = pathPart.lastIndexOf("/");
        dirPart = pathPart.slice(0, lastSlashIndex + 1);
        searchPrefix = pathPart.slice(lastSlashIndex + 1);
        searchDir = expandPath(dirPart, cwd);
    } else {
        searchDir = cwd;
        searchPrefix = pathPart;
    }
    
    try {
        const entries = await readdir(searchDir, { withFileTypes: true });
        const matches: CompletionItem[] = [];
        
        for (const entry of entries) {
            const name = entry.name;
            if (!name.startsWith(searchPrefix) || name.startsWith(".")) {
                continue;
            }
            
            const fullPath = join(searchDir, name);
            let type: "file" | "directory" | "executable" = "file";
            
            if (entry.isDirectory()) {
                type = "directory";
            } else if (entry.isFile()) {
                try {
                    const stats = await stat(fullPath);
                    if (stats.mode & 0o111) {
                        type = "executable";
                    }
                } catch {
                    // ignore
                }
            }
            
            const completion = prefix + (pathPart.includes("/") 
                ? dirPart + name 
                : name);
            
            matches.push({
                completion,
                type,
                display: name + (type === "directory" ? "/" : ""),
            });
        }
        
        // Sort: directories first, then executables, then files
        matches.sort((a, b) => {
            const typeOrder = { directory: 0, executable: 1, file: 2 };
            if (typeOrder[a.type] !== typeOrder[b.type]) {
                return typeOrder[a.type] - typeOrder[b.type];
            }
            return a.display.localeCompare(b.display);
        });
        
        // Find common prefix
        let commonPrefix = "";
        if (matches.length > 0) {
            const first = matches[0].completion;
            let i = first.length;
            while (i > searchPrefix.length) {
                const candidate = first.slice(0, i);
                if (matches.every(m => m.completion.startsWith(candidate))) {
                    commonPrefix = candidate;
                    break;
                }
                i--;
            }
        }
        
        return { completions: matches.slice(0, 20), commonPrefix };
    } catch {
        return { completions: [], commonPrefix: "" };
    }
}

export default function terminalRoutes(app: express.Application): void {
    app.post("/api/terminal/complete", express.json(), async (req, res) => {
        const { partial, cwd } = req.body as CompletionRequest;
        
        if (!partial || typeof partial !== "string") {
            res.status(400).json({ error: "Missing or invalid partial" });
            return;
        }
        
        const resolvedCwd = cwd || HOME_DIR;
        const result = await getCompletions(partial, resolvedCwd);
        res.json(result);
    });
}
