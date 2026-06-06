---
name: prompt-optimizer
description: Cost-route AI jobs BEFORE running them. Use whenever a task is large, repetitive, bulk (many files/items), or potentially token-expensive; or when the user asks to optimize a prompt, estimate AI cost, compare model prices, pick the cheapest model, or mentions budget for an AI job. Returns tool-optimized prompts, a compact plan, the cheapest capable model and a full cost table (analysis by xAI grok-4.3 via ai.ze.mt).
---

# prompt-optimizer

Never burn flagship tokens on work a cheap model can do. Before executing any
large/repetitive/expensive AI job: classify -> route -> execute on the cheapest
capable model, escalate only on failure.

## When to trigger

- Bulk jobs: "all 290 files", "every product", "translate N items", "for each row"
- User asks: optimize this prompt / which model / what will it cost / budget X
- Any job you estimate at > $1 of tokens before starting it

## How to call

**Preferred — MCP tools** (if the `zemt-optimizer` MCP is connected):

1. `estimate_cost {tokens_in, tokens_out, jobs, budget_usd, cached_pct, batch}` -> free deterministic price table, 11 models, cheapest first. No token needed.
2. `get_prices {}` -> current $/M prices (June 2026). No token needed.
3. `optimize_prompt {prompt, targets:["claude"|"grok"|"gemini"], platform}` -> grok-4.3 classification, plan, recommended model, est tokens, paste-ready prompts. Requires API token (env ZEMT_API_TOKEN) or self-hosted backend.

**Fallback — REST API** (https://ai.ze.mt):

```bash
# free, no auth:
curl -s https://ai.ze.mt/api/v1/prices
curl -s -X POST https://ai.ze.mt/api/v1/estimate -H "Content-Type: application/json" \
  -d '{"tokens_in":2000,"tokens_out":800,"jobs":290,"budget_usd":10}'

# token-gated (analysis costs the owner ~$0.003/call):
curl -s -X POST https://ai.ze.mt/api/v1/optimize \
  -H "Authorization: Bearer $ZEMT_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt":"<job description>","targets":["claude"],"platform":"windows"}'
```

Self-host: https://github.com/LinespottingPrivate/zemt-prompt-optimizer (Cloudflare Worker, bring your own xAI key).

## Decision rules (apply after the call)

1. **Use `routing.recommended`** — run the job on that model. If you (the assistant) are a flagship model and the job is `needs_reasoning:false` or `bulk_repeat`, do NOT process items yourself: generate the script/template that calls the cheap model's API.
2. **Sample-test 3 items** on the recommended model before a bulk run; validate; only then run all.
3. **Escalate per item, never globally**: validator fails -> retry once on the escalation model -> flag for human. ~5% escalation beats 100% flagship by 10-20x on cost.
4. **Cap output tokens** in every generated prompt ("return diff only", "JSON only", "<= N tokens") — output costs 2-5x input.
5. **Prompt-cache the static part**: template in system prompt + per-item delta in user message (cached input is 75-90% cheaper).
6. **Report cost to the user** before a big run: per-job, total, and budget fit from `estimate_cost`.
