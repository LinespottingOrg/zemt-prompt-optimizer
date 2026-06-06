# zemt prompt-optimizer

**Stop burning flagship tokens on work a cheap model can do.**

A single-file Cloudflare Worker + MCP server + agent skill that cost-routes AI jobs:
paste a rough task → grok-4.3 classifies it → you get paste-ready optimized prompts
(Claude / Grok / Gemini), a compact plan, the cheapest capable model and a full
price comparison across 11 current models — before you spend anything.

Live instance: **https://ai.ze.mt** · Install page: **https://ai.ze.mt/install**

## What's in the box

| Piece | File | What it does |
|---|---|---|
| Worker | `worker.js` | Web UI + REST API + remote MCP endpoint, all in one file, zero build |
| MCP server | `mcp/zemt-optimizer-mcp.js` | Local stdio MCP (Node 18+, zero deps) for Claude Cowork/Code, Grok Build, Gemini CLI |
| Skill | `skills/prompt-optimizer/SKILL.md` | Teaches the agent to classify → route → sample-test → escalate per item |
| Playbook | `TOKEN-EFFICIENT-AGENTS.md` | The architecture: classify → retrieve → plan → route → execute, caching, logging |

## MCP tools

- `estimate_cost` — deterministic price table (cost/job, total ×N jobs, jobs-in-budget) across Grok, Gemini, Claude. Free.
- `get_prices` — current $/M token prices (June 2026). Free.
- `optimize_prompt` — grok-4.3 analysis: classification, plan, routing, tool-optimized prompts. Token-gated (it costs real money).

## Self-host (5 min)

```bash
git clone https://github.com/LinespottingOrg/zemt-prompt-optimizer
cd zemt-prompt-optimizer
npx wrangler secret put XAI_API_KEY     # console.x.ai
npx wrangler secret put ACCESS_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put API_TOKEN
npx wrangler deploy
```

Edit `ALLOWED_EMAILS` in `worker.js` + set `GOOGLE_CLIENT_ID/SECRET` for Google login (optional).

## Install the MCP + skill

See **https://ai.ze.mt/install** for copy-paste instructions per tool:
Claude Cowork, Claude Code, Grok Build (zero-config via Claude compat), Gemini CLI.

## Architecture

```
prompt → classify (grok-4.3, JSON) → retrieve only relevant context
       → compact plan → route to cheapest capable model → execute
       → cache identical requests 7d → log tokens per request
```

Prices live in `PRICES` in `worker.js` — update when vendors change rates.

MIT © 2026
