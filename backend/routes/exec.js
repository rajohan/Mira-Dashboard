// Exec API routes
const { spawn } = require("child_process");

module.exports = function(app, express) {
    app.post("/api/exec", express.json(), async (req, res) => {
        const { command, cwd } = req.body;
        
        if (!command) {
            return res.status(400).json({ error: "Command required" });
        }
        
        try {
            const child = spawn(command, { 
                shell: true, 
                cwd: cwd || process.cwd(),
                env: process.env 
            });
            
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
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
