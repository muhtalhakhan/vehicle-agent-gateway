import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const { app } = createApp(cfg);

app.listen(cfg.port, () => {
  console.log(`vehicle-agent-gateway on ${cfg.publicUrl}`);
  console.log(`  MCP:        POST ${cfg.publicUrl}/mcp`);
  console.log(`  A2A card:   ${cfg.publicUrl}/.well-known/agent-card.json`);
  console.log(`  OAuth:      POST ${cfg.publicUrl}/oauth/token`);
});
