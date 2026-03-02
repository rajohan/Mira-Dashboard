// Sessions API routes
const gateway = require("../gateway");

module.exports = function(app) {
    // Get session history via sessions.resolve (returns transcript)
    app.get("/api/sessions/:key/history", async (req, res) => {
        try {
            const key = req.params.key;
            
            const gwWs = gateway.getGatewayWs ? gateway.getGatewayWs() : null;
            
            if (!gwWs || gwWs.readyState !== 1) {
                return res.status(503).json({ error: "Gateway not connected" });
            }

            const result = await new Promise((resolve, reject) => {
                const id = "history-" + Date.now();
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
                    method: "sessions.resolve",
                    params: { key }
                }));
            });

            if (result.ok && result.payload) {
                // sessions.resolve returns the session with transcript
                const session = result.payload;
                const messages = [];
                
                // Extract messages from transcript if available
                if (session.transcript && Array.isArray(session.transcript)) {
                    for (const entry of session.transcript) {
                        if (entry.role && entry.content) {
                            messages.push({
                                role: entry.role,
                                content: typeof entry.content === "string" 
                                    ? entry.content 
                                    : JSON.stringify(entry.content)
                            });
                        }
                    }
                }
                
                res.json({ messages, session });
            } else {
                res.json({ messages: [], error: result.error?.message || "Failed to get session" });
            }
        } catch (e) {
            console.error("[Sessions] History error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Session actions (pause, resume, kill)
    app.post("/api/sessions/:key/action", async (req, res) => {
        try {
            const key = req.params.key;
            const { action } = req.body;
            
            const gwWs = gateway.getGatewayWs ? gateway.getGatewayWs() : null;
            
            if (!gwWs || gwWs.readyState !== 1) {
                return res.status(503).json({ error: "Gateway not connected" });
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
                
                let method = "sessions.pause";
                if (action === "resume") method = "sessions.resume";
                if (action === "kill") method = "sessions.delete";
                
                gwWs.send(JSON.stringify({
                    type: "req",
                    id,
                    method,
                    params: { key }
                }));
            });

            res.json({ ok: result.ok, error: result.error });
        } catch (e) {
            console.error("[Sessions] Action error:", e.message);
            res.status(500).json({ error: e.message });
        }
    });
};
