// Exec API routes
const { spawn } = require("child_process");

module.exports = function(app, express) {
    app.post("/api/exec", express.json(), async (req, res) => {
        const { command, args, cwd } = req.body;
        
        // Support both formats:
        // 1. { command: "ls -la" } - shell command string
        // 2. { command: "gh", args: ["issue", "list"] } - command with args array
        
        try {
            let child;
            
            if (args && Array.isArray(args)) {
                // Command with args array - spawn directly
                child = spawn(command, args, {
                    cwd: cwd || process.cwd(),
                    env: process.env
                });
            } else {
                // Shell command string
                child = spawn(command, {
                    shell: true,
                    cwd: cwd || process.cwd(),
                    env: process.env
                });
            }
            
            let stdout = "";
            let stderr = "";
            
            child.stdout.on("data", (data) => { stdout += data; });
            child.stderr.on("data", (data) => { stderr += data; });
            
            child.on("close", (code) => {
                res.json({
                    code: code,
                    stdout: stdout.slice(-10000),
                    stderr: stderr.slice(-10000)
                });
            });
            
            child.on("error", (e) => {
                res.status(500).json({ error: e.message });
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
