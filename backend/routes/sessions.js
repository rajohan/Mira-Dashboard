// Sessions API routes
const gateway = require("../gateway");
const fs = require("fs");
const readline = require("readline");

module.exports = function(app) {
    // Get session history by reading session file directly
    app.get("/api/sessions/:key/history", async (req, res) => {
        try {
            const key = req.params.key;
            
            // Get session file path from sessions.usage
            const gwWs = gateway.getGatewayWs ? gateway.getGatewayWs() : null;
            
            if (!gwWs || gwWs.readyState !== 1) {
                return res.status(503).json({ error: "Gateway not connected" });
            }

            const usageResult = await new Promise((resolve, reject) => {
                const id = "usage-" + Date.now();
                const timer = setTimeout(() => reject(new Error("Timeout")), 10000);
                
                const handler = (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.id === id) {
                            clearTimeout(timer);
                            gwWs.off("message", handler);
                            resolve(msg);
                        }
                    } catch (e) {}
                };
                
                gwWs.on("message", handler);
                gwWs.send(JSON.stringify({
                    type: "req",
                    id,
                    method: "sessions.usage",
                    params: { key }
                }));
            });

            if (!usageResult.ok || !usageResult.payload?.sessions?.[0]?.usage?.sessionFile) {
                return res.json({ messages: [], error: "Session file not found" });
            }

            const sessionFile = usageResult.payload.sessions[0].usage.sessionFile;
            
            // Read messages from session file
            const messages = [];
            const maxMessages = 500;
            
            if (fs.existsSync(sessionFile)) {
                const fileStream = fs.createReadStream(sessionFile);
                const rl = readline.createInterface({
                    input: fileStream,
                    crlfDelay: Infinity
                });

                for await (const line of rl) {
                    if (!line.trim()) continue;
                    try {
                        const entry = JSON.parse(line);
                        
                        // Handle message type entries
                        if (entry.type === "message" && entry.message) {
                            const msg = entry.message;
                            if (msg.role && msg.content) {
                                // Extract text content
                                let content = "";
                                if (typeof msg.content === "string") {
                                    content = msg.content;
                                } else if (Array.isArray(msg.content)) {
                                    // Handle content blocks
                                    for (const block of msg.content) {
                                        if (block.type === "text" && block.text) {
                                            content += block.text;
                                        } else if (block.type === "thinking" && block.thinking) {
                                            // Skip thinking blocks for now
                                        } else if (typeof block === "string") {
                                            content += block;
                                        }
                                    }
                                }
                                
                                if (content.trim()) {
                                    messages.push({
                                        role: msg.role,
                                        content: content.trim(),
                                        timestamp: entry.timestamp
                                    });
                                }
                            }
                        }
                    } catch (e) {}
                }
            }

            // Return last maxMessages messages
            res.json({ 
                messages: messages.slice(-maxMessages),
                total: messages.length 
            });
        } catch (e) {
            console.error("[Sessions] History error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Session actions (stop, compact, reset, delete)
    app.post("/api/sessions/:key/action", async (req, res) => {
        try {
            const key = req.params.key;
            const { action } = req.body;
            
            const gwWs = gateway.getGatewayWs ? gateway.getGatewayWs() : null;
            
            if (!gwWs || gwWs.readyState !== 1) {
                return res.status(503).json({ error: "Gateway not connected" });
            }

            // Map action to gateway method
            let method;
            switch (action) {
                case "stop":
                    method = "chat.abort";
                    break;
                case "compact":
                    method = "sessions.compact";
                    break;
                case "reset":
                    method = "sessions.reset";
                    break;
                case "delete":
                    method = "sessions.delete";
                    break;
                default:
                    return res.status(400).json({ error: "Unknown action: " + action });
            }

            const result = await new Promise((resolve, reject) => {
                const id = "action-" + Date.now();
                const timer = setTimeout(() => reject(new Error("Timeout")), 10000);
                
                const handler = (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.id === id) {
                            clearTimeout(timer);
                            gwWs.off("message", handler);
                            resolve(msg);
                        }
                    } catch (e) {}
                };
                
                gwWs.on("message", handler);
                
                const params = action === "stop" ? { sessionKey: key } : { key };
                
                gwWs.send(JSON.stringify({
                    type: "req",
                    id,
                    method,
                    params
                }));
            });

            res.json({ ok: result.ok, error: result.error });
        } catch (e) {
            console.error("[Sessions] Action error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });
};
