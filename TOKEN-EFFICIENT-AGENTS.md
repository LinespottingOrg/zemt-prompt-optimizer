# Token-Efficient Agent Playbook

> Paste-able spec. Goal: never burn flagship tokens on work a cheap model can do.
> Companion app: https://ai.ze.mt (prompt optimizer + cost predictor).

## Core flow (MVP, highest ROI)

```
User request
  → 1. CLASSIFY      (cheap model, ~100 tokens out, JSON only)
  → 2. RETRIEVE      (send ONLY relevant context, never whole repo/folder)
  → 3. PLAN          (compact JSON plan, cheap-or-mid model)
  → 4. ROUTE         (pick cheapest model that can execute each step)
  → 5. EXECUTE       (minimal prompt: task + retrieved context + plan step)
  → 6. LOG + CACHE   (usage per request; reuse results for repeated task types)
```

## 1. Classify

One call, JSON out, temperature 0:

```json
{"task_type":"codegen|edit|research|extract|translate|bulk_repeat",
 "size":"small|medium|large_repetitive",
 "needs_reasoning":false,
 "needs_web":false,
 "risk":"low|high"}
```

Rule: classification + planning NEVER use flagship models. grok-build-0.1 or Gemini 3 Flash class is enough.

## 2. Retrieve

- Index sources once (file list + 1-line summaries). Send the index, not the files.
- Model asks for specific files/sections; send only those (max ~20k tokens).
- Repetitive jobs (290 kommuner pattern): static template + per-item delta only. Template goes in the system prompt once → prompt-cached at $0.20/M instead of $1.25/M.

## 3. Plan

Compact JSON, no prose:

```json
{"steps":[{"id":1,"do":"...","model":"cheap|mid|flagship","ctx":["file.md#sec2"],"out":"format"}],
 "est_tokens":{"in":12000,"out":4000}}
```

## 4. Route (June 2026 prices, USD per 1M tokens)

| Model | In | Out | Cached in | Ctx | Use for |
|---|---|---|---|---|---|
| grok-build-0.1 | 1.00 | 2.00 | 0.20 | 256k | agentic coding, bulk codegen |
| grok-4.3 | 1.25 | 2.50 | 0.20 | 1M | reasoning, agentic tool-calling, quality writing |
| grok-4.20 | 2.00 | — | 0.20 | 2M | huge-context one-shots |
| Gemini 3 Flash | 0.50 | 3.00 | low | 1M | classify, extract, translate, bulk cheap |
| Gemini 3.1 Pro | 2.00 | 12.00 | — | 1M (≤200k tier) | multimodal, long-doc reasoning |
| Claude Haiku 4.5 | 1.00 | 5.00 | -90% | 200k | fast subagent work |
| Claude Sonnet 4.6 | 3.00 | 15.00 | -90% | 200k+ | solid coding default |
| Claude Opus 4.x | 5.00 | 25.00 | -90% | 200k+ | hardest reasoning ONLY |

Routing rules:
- `bulk_repeat` → cheapest model that passes a 3-item sample test (grok-build / Flash). Batch APIs = extra −50% (Claude, Gemini).
- `needs_reasoning=false` → never Opus/4.3-reasoning. Use non-reasoning mode / fast variants.
- Escalate per-item only on failure (validator rejects → retry once on mid → flag for flagship). ~5% escalation beats 100% flagship by ~10–20x cost.
- Output tokens dominate cost (2–5x input price). Cap output: "answer in ≤N tokens", ask for diffs not whole files, JSON not prose.

## 5. Execute — minimal prompt

- System prompt: static, reusable → prompt-cache it.
- User prompt: plan step + only its `ctx` + output schema. Nothing else.
- No conversation history for stateless bulk items.

## 6. Cache + Log

- Cache key: `hash(task_type + template_version + input_item)`. Hit → $0.
- Log per request: `{ts, model, task_type, tokens_in, tokens_out, cached, cost_usd}`.
- Weekly: sort by cost desc → top 3 task types are your next caching/routing targets.

## Cost prediction formula

```
est_in  = chars(prompt+context)/4 + system_tokens
est_out = task_type lookup (edit:~0.3×in, codegen:~0.8×in, extract:~0.1×in, research:~0.5×in)
cost    = est_in×price_in/1e6 + est_out×price_out/1e6   (× items for bulk)
```

## Per-tool prompt shapes (what ai.ze.mt generates)

- **Claude (Cowork/Code)**: role line → context in XML tags → explicit task → constraints ("do not…") → success criteria → output format. Files by path. Ask-before-destructive.
- **Grok Build**: terse imperative. File tree first, then task, then test command to satisfy. No filler. First-principles over examples.
- **Gemini**: system instruction block → task → few-shot examples (best for repetitive) → strict JSON output schema.
