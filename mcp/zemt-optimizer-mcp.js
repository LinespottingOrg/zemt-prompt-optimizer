#!/usr/bin/env node
/**
 * zemt-optimizer — local stdio MCP server (zero dependencies, Node 18+)
 * Proxies tool calls to the private ai.ze.mt API (Cloudflare Worker → xAI grok-4.3).
 *
 * Tools: optimize_prompt, estimate_cost, get_prices
 *
 * Works in: Claude Cowork / Claude Desktop / Claude Code (mcpServers config)
 *           Grok Build (reads Claude Code MCP config automatically, or /mcps in TUI)
 *
 * Env (optional): ZEMT_API_URL (default https://ai.ze.mt), ZEMT_API_TOKEN
 */

const API = process.env.ZEMT_API_URL || "https://ai.ze.mt";
const TOKEN = process.env.ZEMT_API_TOKEN || "";

const TOOLS = [
  {
    name: "optimize_prompt",
    description:
      "Analyze a raw task prompt with grok-4.3: classifies the task, returns paste-ready tool-optimized prompts (Claude/Grok/Gemini), a compact execution plan, the cheapest capable model, token estimates and escalation rule. Use BEFORE running any large, repetitive or potentially expensive AI job. ~$0.003 per uncached call; identical calls cached 7 days (free).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The raw task / job description" },
        targets: { type: "array", items: { type: "string", enum: ["claude", "grok", "gemini"] }, description: 'Tools to generate optimized prompts for. Default ["claude"]' },
        platform: { type: "string", enum: ["windows", "mac"], description: "OS for file-path style. Default windows" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "estimate_cost",
    description:
      "Deterministic price comparison across all 11 current models (Grok / Gemini / Claude, June 2026 list prices). Returns cost per job, total for N jobs and jobs affordable within a budget, sorted cheapest first. Pure math, no LLM call, free and instant.",
    inputSchema: {
      type: "object",
      properties: {
        tokens_in: { type: "integer", description: "input tokens per job" },
        tokens_out: { type: "integer", description: "output tokens per job" },
        jobs: { type: "integer", description: "number of identical jobs (default 1, up to 1e9)" },
        budget_usd: { type: "number", description: "optional budget to compute jobs_in_budget" },
        cached_pct: { type: "number", description: "0-95: share of input tokens served from prompt cache" },
        batch: { type: "boolean", description: "apply batch-API -50% where supported (Claude, Gemini)" },
      },
      required: ["tokens_in", "tokens_out"],
    },
  },
  {
    name: "get_prices",
    description:
      "Current model price table: USD per 1M input / output / cached-input tokens, context window and batch-discount support for every Grok, Gemini and Claude model (June 2026).",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(m) {
  process.stdout.write(JSON.stringify(m) + "\n");
}

async function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  const id = m.id;
  const isNotification = id === undefined;
  try {
    switch (m.method) {
      case "initialize":
        return send({ jsonrpc: "2.0", id, result: { protocolVersion: m.params?.protocolVersion || "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "zemt-optimizer", version: "1.1.0" } } });
      case "ping":
        return send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      case "tools/call": {
        const r = await fetch(API + "/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
          body: JSON.stringify({ jsonrpc: "2.0", id: id ?? 0, method: "tools/call", params: m.params }),
        });
        const jr = await r.json();
        if (jr.error) return send({ jsonrpc: "2.0", id, error: jr.error });
        return send({ jsonrpc: "2.0", id, result: jr.result });
      }
      default:
        if (isNotification) return; // notifications/initialized etc — no response
        return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + m.method } });
    }
  } catch (e) {
    if (!isNotification) send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + (e.message || e) }], isError: true } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
