/**
 * ai.ze.mt — Prompt Optimizer & Cost Router
 * Cloudflare Worker. Analyzes a raw prompt with xAI grok-4.3, returns
 * per-tool optimized prompts (Claude Cowork / Grok Build / Gemini),
 * a compact plan, model routing advice. Cost comparison + dynamic budget
 * computed client-side over the full June-2026 model lineup.
 *
 * Interfaces:
 *   Web UI     GET  /                  (session cookie auth: Google OAuth or access key)
 *   API v1     POST /api/v1/optimize   (Authorization: Bearer API_TOKEN)
 *              POST /api/v1/estimate
 *              GET  /api/v1/prices
 *   Remote MCP POST /mcp               (Bearer header or /mcp/<API_TOKEN> path auth)
 *
 * Secrets: XAI_API_KEY, ACCESS_KEY, SESSION_SECRET, API_TOKEN,
 *          GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 */

const ALLOWED_EMAILS = ["davidrad@gmail.com", "vandrixcapital@gmail.com"];
const ANALYSIS_MODEL = "grok-4.3";
const COOKIE = "zemt_session";
const SESSION_DAYS = 30;

// USD per 1M tokens — June 2026. cin = cached-input price. batch = batch-API -50%.
const PRICES = [
  { id: "grok-build-0.1",    vendor: "xAI",       inp: 1.0,  out: 2.0,  cin: 0.20, ctx: "256k", batch: false, note: "agentic coding" },
  { id: "grok-4.3",          vendor: "xAI",       inp: 1.25, out: 2.5,  cin: 0.20, ctx: "1M",   batch: false, note: "flagship, tool-calling" },
  { id: "grok-4.20",         vendor: "xAI",       inp: 2.0,  out: 6.0,  cin: 0.20, ctx: "2M",   batch: false, note: "huge-context / multi-agent" },
  { id: "gemini-3-flash",    vendor: "Google",    inp: 0.5,  out: 3.0,  cin: 0.125, ctx: "1M",  batch: true,  note: "cheapest bulk" },
  { id: "gemini-3.5-flash",  vendor: "Google",    inp: 1.5,  out: 9.0,  cin: 0.375, ctx: "1M",  batch: true,  note: "fast coding" },
  { id: "gemini-3.1-pro",    vendor: "Google",    inp: 2.0,  out: 12.0, cin: 0.50, ctx: "1M",   batch: true,  note: "long-doc / multimodal (≤200k tier)" },
  { id: "claude-haiku-4.5",  vendor: "Anthropic", inp: 1.0,  out: 5.0,  cin: 0.10, ctx: "200k", batch: true,  note: "fast subagent" },
  { id: "claude-sonnet-4.6", vendor: "Anthropic", inp: 3.0,  out: 15.0, cin: 0.30, ctx: "200k", batch: true,  note: "coding default" },
  { id: "claude-opus-4.6",   vendor: "Anthropic", inp: 5.0,  out: 25.0, cin: 0.50, ctx: "200k", batch: true,  note: "hard reasoning" },
  { id: "claude-opus-4.8",   vendor: "Anthropic", inp: 5.0,  out: 25.0, cin: 0.50, ctx: "200k", batch: true,  note: "newest flagship" },
  { id: "claude-opus-4.8-fast", vendor: "Anthropic", inp: 10.0, out: 50.0, cin: 1.0, ctx: "200k", batch: false, note: "speed mode — premium" },
];

const SYSTEM_PROMPT = `You are a prompt compiler and cost router for a solo founder who refuses to burn flagship tokens on work a cheap model can do.

Given a raw task prompt, the target tools selected, and the user's OS, return ONLY valid JSON matching the schema. No markdown, no commentary.

Schema:
{
 "classification": {"task_type":"codegen|edit|research|extract|translate|writing|bulk_repeat|other","size":"small|medium|large_repetitive","needs_reasoning":bool,"needs_web":bool,"risk":"low|high"},
 "context_advice": [string],            // 2-4 bullets: exactly what context to attach, what to strip
 "plan": {"steps":[{"id":int,"do":string,"tier":"cheap|mid|flagship","out":string}]},  // max 6 steps, terse
 "est_tokens": {"input":int,"output":int},   // per job, for executing the job (not this analysis)
 "routing": {"recommended":"one of: grok-build-0.1|grok-4.3|grok-4.20|gemini-3-flash|gemini-3.5-flash|gemini-3.1-pro|claude-haiku-4.5|claude-sonnet-4.6|claude-opus-4.6|claude-opus-4.8","rationale":string,"escalation":string},
 "prompts": {"claude":string|null,"grok":string|null,"gemini":string|null},  // only for selected targets, else null
 "warnings": [string]
}

Rules for generated prompts — each must be COMPLETE and paste-ready:
- claude (Claude Cowork / Claude Code): one role line; context in XML tags (<context>, <files>); explicit task; constraints as "Do not ..."; success criteria; exact output format; reference real file paths using the user's OS path style (Windows backslash vs mac slash); tell it to ask before destructive ops.
- grok (Grok Build / grok-build-0.1): terse imperative, zero filler. Structure: goal line → file tree / inputs → task steps → test command or acceptance check it must satisfy → output format.
- gemini: system-instruction block first, then task, then ONE few-shot example if task is repetitive, then strict JSON/output schema.
- Every prompt must cap output ("respond in ≤ N tokens", "return diff only", "JSON only") — output tokens cost 2-5x input.
- For bulk_repeat: design prompt as static template + {{ITEM}} placeholder so the static part gets prompt-cached; say so in the prompt comment.
- Routing: never recommend flagship when needs_reasoning=false. bulk_repeat → cheapest model with a 3-item sample-test step in plan. escalation: one line, e.g. "validator fails → retry claude-sonnet-4.6 → flag".
- est_tokens.input = realistic tokens for prompt+needed context; est_tokens.output = realistic completion size. Integers.`;

/* ---------------- crypto helpers ---------------- */
const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function makeSession(env, subject) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = `${subject}|${exp}`;
  return `${btoa(payload)}.${await hmac(env.SESSION_SECRET, payload)}`;
}
async function checkSession(env, req) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [b64, sig] = m[1].split(".");
  if (!b64 || !sig) return false;
  let payload;
  try { payload = atob(b64); } catch { return false; }
  const [, exp] = payload.split("|");
  if (Number(exp) < Date.now()) return false;
  return (await hmac(env.SESSION_SECRET, payload)) === sig;
}
function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bearerOk(req, env) {
  const a = req.headers.get("Authorization") || "";
  return !!env.API_TOKEN && a === `Bearer ${env.API_TOKEN}`;
}
function j(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

/* ---------------- cost math (server) ---------------- */
function estTable(tin, tout, jobs = 1, budget = null, cachedPct = 0, batch = false) {
  const c = Math.min(Math.max(cachedPct || 0, 0), 95) / 100;
  return PRICES.map((p) => {
    const disc = batch && p.batch ? 0.5 : 1;
    const job = ((tin * (1 - c) * p.inp + tin * c * p.cin + tout * p.out) / 1e6) * disc;
    return {
      id: p.id, vendor: p.vendor, ctx: p.ctx,
      usd_per_m_in: p.inp, usd_per_m_out: p.out, usd_per_m_cached: p.cin,
      batch_applied: batch && p.batch,
      cost_per_job_usd: +job.toFixed(6),
      total_usd: +(job * jobs).toFixed(2),
      jobs_in_budget: budget != null && job > 0 ? Math.floor(budget / job) : null,
      note: p.note,
    };
  }).sort((a, b) => a.cost_per_job_usd - b.cost_per_job_usd);
}

/* ---------------- xAI call ---------------- */
async function callXai(env, userMsg) {
  const body = {
    model: ANALYSIS_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  };
  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.XAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`xAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const jr = await r.json();
  return { content: jr.choices?.[0]?.message?.content || "{}", usage: jr.usage || {} };
}

/* ---------------- optimize core (shared by UI, API, MCP) ---------------- */
async function runOptimize(b, env, ctx) {
  const prompt = (b.prompt || "").trim();
  if (!prompt) return { status: 400, body: { error: "empty prompt" } };
  if (prompt.length > 60000) return { status: 413, body: { error: "prompt > 60k chars" } };
  const targets = Array.isArray(b.targets) && b.targets.length ? b.targets : ["claude"];
  const platform = b.platform === "mac" ? "mac" : "windows";

  const cacheKey = new Request(`https://cache.ai.ze.mt/v2/${await sha256(JSON.stringify({ prompt, targets, platform }))}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit && !b.nocache) {
    const data = await hit.json();
    data.cached = true;
    return { status: 200, body: data };
  }

  const userMsg = JSON.stringify({ raw_prompt: prompt, targets, os: platform });
  let analysis, usage;
  try {
    const res = await callXai(env, userMsg);
    usage = res.usage;
    analysis = JSON.parse(res.content);
  } catch (e) {
    return { status: 502, body: { error: String(e.message || e) } };
  }

  const analysisCost = ((usage.prompt_tokens || 0) * 1.25 + (usage.completion_tokens || 0) * 2.5) / 1e6;
  const payload = {
    analysis,
    usage: { prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0, analysis_cost_usd: Math.round(analysisCost * 10000) / 10000, model: ANALYSIS_MODEL },
    cached: false,
    ts: Date.now(),
  };
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=604800" } })));
  return { status: 200, body: payload };
}

/* ---------------- MCP (Model Context Protocol, Streamable HTTP) ---------------- */
const MCP_TOOLS = [
  {
    name: "optimize_prompt",
    description: "Analyze a raw task prompt with grok-4.3: classifies the task, returns paste-ready tool-optimized prompts (Claude/Grok/Gemini), a compact execution plan, the cheapest capable model, token estimates and escalation rule. Use BEFORE running any large, repetitive or potentially expensive AI job. Costs ~$0.003 per uncached call; identical calls are cached 7 days (free).",
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
    description: "Deterministic price comparison across all 11 current models (Grok / Gemini / Claude, June 2026 list prices). Returns cost per job, total for N jobs and jobs affordable within a budget, sorted cheapest first. Pure math, no LLM call, free and instant.",
    inputSchema: {
      type: "object",
      properties: {
        tokens_in: { type: "integer", description: "input tokens per job" },
        tokens_out: { type: "integer", description: "output tokens per job" },
        jobs: { type: "integer", description: "number of identical jobs (default 1, supports up to 1e9)" },
        budget_usd: { type: "number", description: "optional budget to compute jobs_in_budget" },
        cached_pct: { type: "number", description: "0-95: share of input tokens served from prompt cache" },
        batch: { type: "boolean", description: "apply batch-API -50% where supported (Claude, Gemini)" },
      },
      required: ["tokens_in", "tokens_out"],
    },
  },
  {
    name: "get_prices",
    description: "Current model price table: USD per 1M input / output / cached-input tokens, context window and batch-discount support for every Grok, Gemini and Claude model (June 2026).",
    inputSchema: { type: "object", properties: {} },
  },
];

async function mcpDispatch(name, args, env, ctx, authed = true) {
  if (name === "get_prices") return { prices: PRICES, unit: "USD per 1M tokens", updated: "2026-06" };
  if (name === "estimate_cost") {
    if (typeof args.tokens_in !== "number" || typeof args.tokens_out !== "number") throw new Error("tokens_in and tokens_out are required integers");
    return {
      inputs: { tokens_in: args.tokens_in, tokens_out: args.tokens_out, jobs: args.jobs || 1, budget_usd: args.budget_usd ?? null, cached_pct: args.cached_pct || 0, batch: !!args.batch },
      table: estTable(args.tokens_in, args.tokens_out, args.jobs || 1, args.budget_usd ?? null, args.cached_pct || 0, !!args.batch),
    };
  }
  if (name === "optimize_prompt") {
    if (!authed) throw new Error("optimize_prompt requires an API token (Bearer header or /mcp/<token> path). estimate_cost and get_prices are free. Self-host: github.com/LinespottingOrg/zemt-prompt-optimizer");
    const r = await runOptimize({ prompt: args.prompt, targets: args.targets, platform: args.platform }, env, ctx);
    if (r.status !== 200) throw new Error(r.body.error || "optimize failed");
    const out = r.body;
    const t = out.analysis?.est_tokens || {};
    if (t.input && t.output) out.cost_table = estTable(t.input, t.output, 1, null, 0, false);
    return out;
  }
  throw new Error(`unknown tool: ${name}`);
}

async function handleMcp(req, env, ctx, url) {
  const pathTok = decodeURIComponent(url.pathname.split("/")[2] || "");
  const mcpAuthed = bearerOk(req, env) || !!(env.API_TOKEN && pathTok === env.API_TOKEN);
  if (req.method === "GET") {
    return j({ name: "zemt-optimizer", transport: "streamable-http", usage: "POST JSON-RPC 2.0 (initialize, tools/list, tools/call)" });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  let msg;
  try { msg = await req.json(); } catch { return j({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }

  const one = async (m) => {
    const id = m.id ?? null;
    try {
      switch (m.method) {
        case "initialize":
          return { jsonrpc: "2.0", id, result: { protocolVersion: m.params?.protocolVersion || "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "zemt-optimizer", version: "1.1.0" } } };
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
        case "tools/call": {
          const res = await mcpDispatch(m.params?.name, m.params?.arguments || {}, env, ctx, mcpAuthed);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(res, null, 1) }], isError: false } };
        }
        default:
          if (!("id" in m)) return null; // notification — no response
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${m.method}` } };
      }
    } catch (e) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + (e.message || e) }], isError: true } };
    }
  };

  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map(one))).filter(Boolean);
    return out.length ? j(out) : new Response(null, { status: 202 });
  }
  const out = await one(msg);
  return out ? j(out) : new Response(null, { status: 202 });
}

/* ---------------- routes ---------------- */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // --- MCP (own auth) ---
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return handleMcp(req, env, ctx, url);
    }

    const authed = await checkSession(env, req);

    // --- auth endpoints ---
    if (url.pathname === "/auth/key" && req.method === "POST") {
      const { key } = await req.json().catch(() => ({}));
      if (key && env.ACCESS_KEY && key === env.ACCESS_KEY) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookie(await makeSession(env, "key-user")) },
        });
      }
      return j({ ok: false, error: "wrong key" }, 401);
    }
    if (url.pathname === "/auth/google") {
      if (!env.GOOGLE_CLIENT_ID) return new Response("Google OAuth not configured yet", { status: 501 });
      const p = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${url.origin}/auth/callback`,
        response_type: "code",
        scope: "openid email",
        prompt: "select_account",
      });
      return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
    }
    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code || !env.GOOGLE_CLIENT_ID) return new Response("missing code", { status: 400 });
      const tr = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${url.origin}/auth/callback`, grant_type: "authorization_code",
        }),
      });
      const tj = await tr.json();
      let email = "";
      try { email = JSON.parse(atob(tj.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || ""; } catch {}
      if (!ALLOWED_EMAILS.includes(email.toLowerCase())) return new Response(`Access denied for ${email || "unknown"}`, { status: 403 });
      return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": sessionCookie(await makeSession(env, email)) } });
    }
    if (url.pathname === "/auth/logout") {
      return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0` } });
    }

    // --- API: optimize (UI session OR bearer) ---
    if ((url.pathname === "/api/optimize" || url.pathname === "/api/v1/optimize") && req.method === "POST") {
      if (!authed && !bearerOk(req, env)) return j({ error: "unauthorized" }, 401);
      let b;
      try { b = await req.json(); } catch { return j({ error: "bad json" }, 400); }
      const r = await runOptimize(b, env, ctx);
      return j(r.body, r.status);
    }

    // --- API v1: estimate + prices (bearer only) ---
    if (url.pathname === "/api/v1/estimate" && req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return j({ error: "bad json" }, 400); }
      if (typeof b.tokens_in !== "number" || typeof b.tokens_out !== "number") return j({ error: "tokens_in and tokens_out required (numbers)" }, 400);
      return j({ table: estTable(b.tokens_in, b.tokens_out, b.jobs || 1, b.budget_usd ?? null, b.cached_pct || 0, !!b.batch) });
    }
    if (url.pathname === "/api/v1/prices") {
      return j({ prices: PRICES, unit: "USD per 1M tokens", updated: "2026-06" });
    }

    if (url.pathname === "/api/config") {
      return j({ authed, google: !!env.GOOGLE_CLIENT_ID, prices: PRICES });
    }

    // --- public install page + downloads ---
    if (url.pathname === "/install") return new Response(deB64(PUB.install), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname === "/download/zemt-optimizer-mcp.js") return new Response(deB64(PUB.mcp), { headers: { "Content-Type": "application/javascript; charset=utf-8", "Content-Disposition": "attachment; filename=zemt-optimizer-mcp.js" } });
    if (url.pathname === "/download/prompt-optimizer-SKILL.md") return new Response(deB64(PUB.skill), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": "attachment; filename=SKILL.md" } });

    // --- page ---
    return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};

/* ---------------- UI ---------------- */
const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ai.ze.mt — prompt optimizer & cost router</title>
<style>
:root{--bg:#0b0e14;--card:#131825;--line:#232b3d;--txt:#dbe2f0;--dim:#8a94ab;--acc:#5eead4;--acc2:#818cf8;--warn:#fbbf24;--err:#f87171}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif;padding:10px 16px;max-width:1200px;margin:0 auto}
h1{font-size:17px;display:inline}h1 b{color:var(--acc)}
.top{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:7px}
.top .sub{color:var(--dim);font-size:12.5px;flex:1;min-width:200px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:7px}
textarea{width:100%;min-height:54px;background:#0e1320;color:var(--txt);border:1px solid var(--line);border-radius:7px;padding:8px 10px;font:13px/1.45 ui-monospace,Consolas,monospace;resize:vertical}
textarea:focus,input:focus{outline:1px solid var(--acc2)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:7px}
label.chk{display:flex;gap:5px;align-items:center;background:#0e1320;border:1px solid var(--line);border-radius:7px;padding:4px 9px;cursor:pointer;font-size:13px;user-select:none;white-space:nowrap}
label.chk input{accent-color:var(--acc)}
.badge{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.badge.on{color:var(--acc);border-color:var(--acc)}
select,input[type=number],input[type=password]{background:#0e1320;color:var(--txt);border:1px solid var(--line);border-radius:7px;padding:4px 8px;font-size:13px}
input[type=range]{accent-color:var(--acc2);width:80px}
button{background:linear-gradient(135deg,var(--acc2),var(--acc));color:#08111c;font-weight:700;border:0;border-radius:7px;padding:6px 18px;font-size:14px;cursor:pointer}
button:disabled{opacity:.45;cursor:wait}
button.ghost{background:none;border:1px solid var(--line);color:var(--dim);font-weight:400;padding:3px 9px;font-size:12px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:5px}
.chip{font-size:11.5px;padding:2px 8px;border-radius:99px;background:#0e1320;border:1px solid var(--line)}
.chip.hl{border-color:var(--acc);color:var(--acc)}
.chip.warn{border-color:var(--warn);color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:3px 7px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:500;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px}
td.num,th.num{text-align:right}
tr.best td{color:var(--acc)}
tr.rec td{background:rgba(129,140,248,.08)}
.promptbox{position:relative;background:#0e1320;border:1px solid var(--line);border-radius:7px;padding:10px;margin-top:6px;white-space:pre-wrap;font:12.5px/1.45 ui-monospace,Consolas,monospace;max-height:300px;overflow:auto}
.copy{position:absolute;top:6px;right:6px;background:var(--line);color:var(--txt);border:0;border-radius:5px;padding:3px 9px;font-size:11px;cursor:pointer}
.copy:hover{background:var(--acc2)}
h3{font-size:13.5px;margin:6px 0 3px;display:inline-block}h3 .tool{color:var(--acc2)}
details{margin-top:3px}summary{cursor:pointer;color:var(--dim);font-size:12px}
.err{color:var(--err);font-size:13px}
.spin{display:inline-block;width:12px;height:12px;border:2px solid #08111c;border-top-color:transparent;border-radius:50%;animation:r .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes r{to{transform:rotate(360deg)}}
#login{max-width:420px;margin:8vh auto}
.gbtn{display:block;text-align:center;background:#fff;color:#1a1a1a;border-radius:8px;padding:10px;font-weight:600;text-decoration:none;margin-bottom:10px}
.hr{display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12px;margin:10px 0}
.hr:before,.hr:after{content:"";flex:1;height:1px;background:var(--line)}
.muted{color:var(--dim);font-size:12px}
.bgrid{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
.bgrid .fld{display:flex;align-items:center;gap:5px;background:#0e1320;border:1px solid var(--line);border-radius:7px;padding:3px 8px}
.bgrid .fld span{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.bgrid input[type=number]{border:0;background:none;padding:0;color:var(--acc);font-size:13px;font-weight:600;width:62px}
#b_jobs{width:104px!important}
.budgetline{margin-top:5px;font-size:12.5px}
.budgetline b{color:var(--acc)}
.foot{color:var(--dim);font-size:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:2px 2px 8px}
.foot a{color:var(--acc2)}
.foot b{color:var(--acc)}
</style></head><body>

<div id="login" style="display:none" class="card">
  <h1>ai.<b>ze.mt</b></h1>
  <p class="muted" style="margin:4px 0 12px">prompt optimizer & cost router — private · <a href="/install" style="color:var(--acc2)">public: install MCP + skill</a></p>
  <a id="gbtn" class="gbtn" href="/auth/google" style="display:none">Sign in with Google</a>
  <div class="hr" id="ghr" style="display:none">or</div>
  <input type="password" id="key" placeholder="access key" style="width:100%">
  <div class="row"><button onclick="loginKey()">Enter</button></div>
  <p class="err" id="lerr"></p>
</div>

<div id="app" style="display:none">
  <div class="top">
    <h1>ai.<b>ze.mt</b></h1>
    <span class="sub">rough prompt → grok-4.3 → tool-optimized prompts + cheapest capable model</span>
    <span class="badge on" id="osbadge"></span>
    <button class="ghost" onclick="location.href='/auth/logout'">logout</button>
  </div>

  <div class="card">
    <textarea id="prompt" placeholder="Describe the job — e.g. 'standardize headers in 290 council motion drafts, output markdown'"></textarea>
    <div class="row">
      <label class="chk"><input type="checkbox" id="t_claude" checked> Claude Cowork</label>
      <label class="chk"><input type="checkbox" id="t_grok"> Grok Build</label>
      <label class="chk"><input type="checkbox" id="t_gemini"> Gemini</label>
      <select id="platform"><option value="windows">Windows</option><option value="mac">macOS</option></select>
      <button id="go" onclick="run()">Optimize</button>
      <span class="err" id="aerr"></span>
    </div>
  </div>

  <div id="out"></div>

  <div class="card">
    <div class="bgrid">
      <b style="font-size:13px;margin-right:2px">Cost & budget</b>
      <div class="fld"><span>in/job</span><input type="number" id="b_in" value="2000" min="1" step="100"></div>
      <div class="fld"><span>out/job</span><input type="number" id="b_out" value="800" min="1" step="100"></div>
      <div class="fld"><span>jobs</span><input type="number" id="b_jobs" value="1" min="1" max="1000000000"></div>
      <div class="fld"><span>budget $</span><input type="number" id="b_budget" value="10" min="0" step="1"></div>
      <div class="fld"><span>cached <b id="b_cachev" style="color:var(--acc)">0%</b></span><input type="range" id="b_cache" value="0" min="0" max="95" step="5"></div>
      <label class="chk"><input type="checkbox" id="b_batch"> batch −50%</label>
    </div>
    <div style="overflow-x:auto"><table id="costtbl"><thead><tr>
      <th>model</th><th>ctx</th><th class="num">$/M in · out · cached</th><th class="num">cost / job</th><th class="num">total ×jobs</th><th class="num">jobs in budget</th><th>note</th>
    </tr></thead><tbody></tbody></table></div>
    <p class="budgetline" id="budgetline"></p>
  </div>

  <div class="foot">
    <span>log: <b id="s_req">0</b> req · <b id="s_tok">0</b> tok · <b id="s_usd">$0</b> · <b id="s_hit">0</b> hits</span>
    <details style="margin:0"><summary>history</summary><table id="logtbl"><thead><tr><th>time</th><th>type</th><th>in</th><th>out</th><th>cost</th><th>cached</th></tr></thead><tbody></tbody></table></details>
    <button class="ghost" onclick="clearLog()">clear</button>
    <span>grok-4.3 · cached 7d · prices 2026-06 · <a href="/install">install MCP + skill</a> · <a href="https://github.com/LinespottingOrg/zemt-prompt-optimizer">github</a></span>
  </div>
</div>

<script>
const $=id=>document.getElementById(id);
let PR=[],RECOMMENDED=null;

function detectOS(){const p=(navigator.userAgentData?.platform||navigator.platform||"").toLowerCase();return p.includes("mac")?"mac":"windows"}

async function init(){
  const c=await fetch("/api/config").then(r=>r.json());
  PR=c.prices;
  if(!c.authed){$("login").style.display="block";if(c.google){$("gbtn").style.display="block";$("ghr").style.display="flex"}return}
  $("app").style.display="block";
  const os=detectOS();
  $("platform").value=os;
  $("osbadge").textContent="detected: "+(os==="mac"?"macOS":"Windows");
  renderLog();renderCost();
  ["b_in","b_out","b_jobs","b_budget","b_batch"].forEach(id=>$(id).addEventListener("input",renderCost));
  $("b_cache").addEventListener("input",()=>{$("b_cachev").textContent=$("b_cache").value+"%";renderCost()});
  $("prompt").addEventListener("input",()=>{const ch=$("prompt").value.length;if(ch){$("b_in").value=Math.ceil(ch/4)+500;$("b_out").value=Math.ceil((+$("b_in").value)*.4);renderCost()}});
  $("prompt").addEventListener("keydown",e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey))run()});
}
async function loginKey(){
  const r=await fetch("/auth/key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:$("key").value})});
  if(r.ok)location.reload();else $("lerr").textContent="wrong key";
}
$("key")?.addEventListener("keydown",e=>{if(e.key==="Enter")loginKey()});

/* ---- dynamic cost engine (pure client-side, no API cost) ---- */
function jobCost(p,tin,tout,cachePct,batch){
  const c=cachePct/100;
  const inCost=(tin*(1-c)*p.inp+tin*c*p.cin)/1e6;
  const outCost=tout*p.out/1e6;
  const disc=batch&&p.batch?0.5:1;
  return (inCost+outCost)*disc;
}
function fmt(v){
  if(!isFinite(v))return "—";
  if(v===0)return "$0";
  if(v>=1){const w=Math.abs(v-Math.round(v))<1e-9;return "$"+v.toLocaleString("en-US",{minimumFractionDigits:w?0:2,maximumFractionDigits:w?0:2})}
  const c=v*100;
  if(c>=1)return (Math.abs(c-Math.round(c))<1e-9?String(Math.round(c)):c.toFixed(2))+"¢";
  return c.toFixed(3)+"¢";
}
function renderCost(){
  if(!PR.length)return;
  const tin=+$("b_in").value||0,tout=+$("b_out").value||0,jobs=+$("b_jobs").value||1;
  const budget=+$("b_budget").value||0,cache=+$("b_cache").value||0,batch=$("b_batch").checked;
  const rows=PR.map(p=>({...p,job:jobCost(p,tin,tout,cache,batch)})).sort((a,b)=>a.job-b.job);
  const tb=$("costtbl").querySelector("tbody");
  tb.innerHTML=rows.map((p,i)=>{
    const total=p.job*jobs, afford=p.job>0?Math.floor(budget/p.job):0;
    const cls=(i===0?"best ":"")+(p.id===RECOMMENDED?"rec":"");
    return '<tr class="'+cls+'"><td>'+p.id+(p.id===RECOMMENDED?" ★":"")+(i===0?" ◎":"")+'</td><td>'+p.ctx+'</td>'+
      '<td class="num">'+p.inp.toFixed(2)+' · '+p.out.toFixed(2)+' · '+p.cin.toFixed(2)+'</td>'+
      '<td class="num">'+fmt(p.job)+'</td><td class="num">'+fmt(total)+(batch&&p.batch?" ⓑ":"")+'</td>'+
      '<td class="num">'+afford.toLocaleString()+'</td><td class="muted">'+p.note+'</td></tr>';
  }).join("");
  const cheap=rows[0],pricey=rows[rows.length-1];
  const rec=rows.find(r=>r.id===RECOMMENDED);
  let line='Budget <b>$'+budget+'</b> → <b>'+(cheap.job>0?Math.floor(budget/cheap.job).toLocaleString():"∞")+'</b> jobs on '+cheap.id+' vs <b>'+(pricey.job>0?Math.floor(budget/pricey.job).toLocaleString():"∞")+'</b> on '+pricey.id+
    ' · '+jobs.toLocaleString()+' job(s): <b>'+fmt(cheap.job*jobs)+'</b> vs '+fmt(pricey.job*jobs)+' — '+(pricey.job>0&&cheap.job>0?(pricey.job/cheap.job).toFixed(1):"?")+'x spread';
  if(rec)line+=' · recommended '+rec.id+': <b>'+fmt(rec.job*jobs)+'</b> ('+(rec.job>0?Math.floor(budget/rec.job).toLocaleString():"∞")+' in budget)';
  $("budgetline").innerHTML=line;
}

/* ---- log ---- */
function log(){try{return JSON.parse(localStorage.zemtlog||"[]")}catch{return[]}}
function pushLog(e){const l=log();l.unshift(e);localStorage.zemtlog=JSON.stringify(l.slice(0,200));renderLog()}
function clearLog(){localStorage.zemtlog="[]";renderLog()}
function renderLog(){
  const l=log();
  $("s_req").textContent=l.length;
  $("s_tok").textContent=l.reduce((a,e)=>a+(e.in||0)+(e.out||0),0).toLocaleString();
  $("s_usd").textContent="$"+l.reduce((a,e)=>a+(e.usd||0),0).toFixed(4);
  $("s_hit").textContent=l.filter(e=>e.cached).length;
  $("logtbl").querySelector("tbody").innerHTML=l.slice(0,50).map(e=>"<tr><td>"+new Date(e.ts).toLocaleString()+"</td><td>"+(e.type||"")+"</td><td>"+(e.in||0)+"</td><td>"+(e.out||0)+"</td><td>$"+(e.usd||0).toFixed(4)+"</td><td>"+(e.cached?"✓":"")+"</td></tr>").join("");
}

const esc=s=>(s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
function copyBtn(txt){const b=document.createElement("button");b.className="copy";b.textContent="copy";b.onclick=()=>{navigator.clipboard.writeText(txt);b.textContent="copied ✓";setTimeout(()=>b.textContent="copy",1500)};return b}

async function run(){
  const prompt=$("prompt").value.trim();if(!prompt)return;
  const targets=[["t_claude","claude"],["t_grok","grok"],["t_gemini","gemini"]].filter(([i])=>$(i).checked).map(([,t])=>t);
  if(!targets.length){$("aerr").textContent="pick at least one target tool";return}
  $("aerr").textContent="";$("go").disabled=true;$("go").innerHTML='<span class="spin"></span>analyzing…';
  try{
    const r=await fetch("/api/optimize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt,targets,platform:$("platform").value})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||r.status);
    render(d);
    pushLog({ts:Date.now(),type:d.analysis?.classification?.task_type,in:d.usage?.prompt_tokens,out:d.usage?.completion_tokens,usd:d.cached?0:(d.usage?.analysis_cost_usd||0),cached:d.cached});
  }catch(e){$("aerr").textContent=e.message}
  $("go").disabled=false;$("go").textContent="Optimize";
}

function render(d){
  const a=d.analysis,c=a.classification||{};
  RECOMMENDED=a.routing?.recommended||null;
  if(a.est_tokens?.input)$("b_in").value=a.est_tokens.input;
  if(a.est_tokens?.output)$("b_out").value=a.est_tokens.output;
  if(c.task_type==="bulk_repeat"&&+$("b_jobs").value===1)$("b_jobs").value=10;
  renderCost();
  let h='<div class="card"><div class="chips">';
  h+='<span class="chip hl">'+esc(c.task_type)+'</span><span class="chip">'+esc(c.size)+'</span>';
  h+='<span class="chip">'+(c.needs_reasoning?"reasoning":"no-reasoning")+'</span>';
  if(c.needs_web)h+='<span class="chip">needs web</span>';
  if(c.risk==="high")h+='<span class="chip warn">high risk</span>';
  if(d.cached)h+='<span class="chip hl">cache hit — $0</span>';
  h+='<span class="chip">est '+(a.est_tokens?.input||0).toLocaleString()+' in / '+(a.est_tokens?.output||0).toLocaleString()+' out</span>';
  h+='<span class="chip">analysis $'+(d.usage?.analysis_cost_usd||0).toFixed(4)+'</span>';
  h+='</div>';
  h+='<p style="margin:2px 0"><b style="color:var(--acc)">→ '+esc(a.routing?.recommended)+'</b> — '+esc(a.routing?.rationale)+' <span class="muted">· escalation: '+esc(a.routing?.escalation)+'</span></p>';
  if(a.context_advice?.length)h+='<p class="muted" style="margin:3px 0">context: '+a.context_advice.map(esc).join(" · ")+'</p>';
  if(a.warnings?.length)h+='<p class="muted" style="color:var(--warn);margin:3px 0">⚠ '+a.warnings.map(esc).join(" · ")+'</p>';
  h+='<details><summary>compact plan (JSON)</summary><div class="promptbox">'+esc(JSON.stringify(a.plan,null,1))+'</div></details>';
  h+='</div>';

  const names={claude:"Claude Cowork",grok:"Grok Build",gemini:"Gemini"};
  h+='<div class="card" id="prompts" style="padding-top:6px">';
  Object.entries(a.prompts||{}).forEach(([k,v])=>{if(!v)return;h+='<h3><span class="tool">'+names[k]+'</span></h3><div class="promptbox" data-p="'+k+'">'+esc(v)+'</div>'});
  h+='</div>';
  $("out").innerHTML=h;
  document.querySelectorAll(".promptbox[data-p]").forEach(b=>b.appendChild(copyBtn(b.textContent)));
  window.scrollTo({top:$("out").offsetTop-10,behavior:"smooth"});
}
init();
</script></body></html>`;

/* ---------------- public downloads (base64) ---------------- */
function deB64(s){return new TextDecoder().decode(Uint8Array.from(atob(s),c=>c.charCodeAt(0)))}
const PUB = {
  mcp: "IyEvdXNyL2Jpbi9lbnYgbm9kZQovKioKICogemVtdC1vcHRpbWl6ZXIg4oCUIGxvY2FsIHN0ZGlvIE1DUCBzZXJ2ZXIgKHplcm8gZGVwZW5kZW5jaWVzLCBOb2RlIDE4KykKICogUHJveGllcyB0b29sIGNhbGxzIHRvIHRoZSBwcml2YXRlIGFpLnplLm10IEFQSSAoQ2xvdWRmbGFyZSBXb3JrZXIg4oaSIHhBSSBncm9rLTQuMykuCiAqCiAqIFRvb2xzOiBvcHRpbWl6ZV9wcm9tcHQsIGVzdGltYXRlX2Nvc3QsIGdldF9wcmljZXMKICoKICogV29ya3MgaW46IENsYXVkZSBDb3dvcmsgLyBDbGF1ZGUgRGVza3RvcCAvIENsYXVkZSBDb2RlIChtY3BTZXJ2ZXJzIGNvbmZpZykKICogICAgICAgICAgIEdyb2sgQnVpbGQgKHJlYWRzIENsYXVkZSBDb2RlIE1DUCBjb25maWcgYXV0b21hdGljYWxseSwgb3IgL21jcHMgaW4gVFVJKQogKgogKiBFbnYgKG9wdGlvbmFsKTogWkVNVF9BUElfVVJMIChkZWZhdWx0IGh0dHBzOi8vYWkuemUubXQpLCBaRU1UX0FQSV9UT0tFTgogKi8KCmNvbnN0IEFQSSA9IHByb2Nlc3MuZW52LlpFTVRfQVBJX1VSTCB8fCAiaHR0cHM6Ly9haS56ZS5tdCI7CmNvbnN0IFRPS0VOID0gcHJvY2Vzcy5lbnYuWkVNVF9BUElfVE9LRU4gfHwgIiI7Cgpjb25zdCBUT09MUyA9IFsKICB7CiAgICBuYW1lOiAib3B0aW1pemVfcHJvbXB0IiwKICAgIGRlc2NyaXB0aW9uOgogICAgICAiQW5hbHl6ZSBhIHJhdyB0YXNrIHByb21wdCB3aXRoIGdyb2stNC4zOiBjbGFzc2lmaWVzIHRoZSB0YXNrLCByZXR1cm5zIHBhc3RlLXJlYWR5IHRvb2wtb3B0aW1pemVkIHByb21wdHMgKENsYXVkZS9Hcm9rL0dlbWluaSksIGEgY29tcGFjdCBleGVjdXRpb24gcGxhbiwgdGhlIGNoZWFwZXN0IGNhcGFibGUgbW9kZWwsIHRva2VuIGVzdGltYXRlcyBhbmQgZXNjYWxhdGlvbiBydWxlLiBVc2UgQkVGT1JFIHJ1bm5pbmcgYW55IGxhcmdlLCByZXBldGl0aXZlIG9yIHBvdGVudGlhbGx5IGV4cGVuc2l2ZSBBSSBqb2IuIH4kMC4wMDMgcGVyIHVuY2FjaGVkIGNhbGw7IGlkZW50aWNhbCBjYWxscyBjYWNoZWQgNyBkYXlzIChmcmVlKS4iLAogICAgaW5wdXRTY2hlbWE6IHsKICAgICAgdHlwZTogIm9iamVjdCIsCiAgICAgIHByb3BlcnRpZXM6IHsKICAgICAgICBwcm9tcHQ6IHsgdHlwZTogInN0cmluZyIsIGRlc2NyaXB0aW9uOiAiVGhlIHJhdyB0YXNrIC8gam9iIGRlc2NyaXB0aW9uIiB9LAogICAgICAgIHRhcmdldHM6IHsgdHlwZTogImFycmF5IiwgaXRlbXM6IHsgdHlwZTogInN0cmluZyIsIGVudW06IFsiY2xhdWRlIiwgImdyb2siLCAiZ2VtaW5pIl0gfSwgZGVzY3JpcHRpb246ICdUb29scyB0byBnZW5lcmF0ZSBvcHRpbWl6ZWQgcHJvbXB0cyBmb3IuIERlZmF1bHQgWyJjbGF1ZGUiXScgfSwKICAgICAgICBwbGF0Zm9ybTogeyB0eXBlOiAic3RyaW5nIiwgZW51bTogWyJ3aW5kb3dzIiwgIm1hYyJdLCBkZXNjcmlwdGlvbjogIk9TIGZvciBmaWxlLXBhdGggc3R5bGUuIERlZmF1bHQgd2luZG93cyIgfSwKICAgICAgfSwKICAgICAgcmVxdWlyZWQ6IFsicHJvbXB0Il0sCiAgICB9LAogIH0sCiAgewogICAgbmFtZTogImVzdGltYXRlX2Nvc3QiLAogICAgZGVzY3JpcHRpb246CiAgICAgICJEZXRlcm1pbmlzdGljIHByaWNlIGNvbXBhcmlzb24gYWNyb3NzIGFsbCAxMSBjdXJyZW50IG1vZGVscyAoR3JvayAvIEdlbWluaSAvIENsYXVkZSwgSnVuZSAyMDI2IGxpc3QgcHJpY2VzKS4gUmV0dXJucyBjb3N0IHBlciBqb2IsIHRvdGFsIGZvciBOIGpvYnMgYW5kIGpvYnMgYWZmb3JkYWJsZSB3aXRoaW4gYSBidWRnZXQsIHNvcnRlZCBjaGVhcGVzdCBmaXJzdC4gUHVyZSBtYXRoLCBubyBMTE0gY2FsbCwgZnJlZSBhbmQgaW5zdGFudC4iLAogICAgaW5wdXRTY2hlbWE6IHsKICAgICAgdHlwZTogIm9iamVjdCIsCiAgICAgIHByb3BlcnRpZXM6IHsKICAgICAgICB0b2tlbnNfaW46IHsgdHlwZTogImludGVnZXIiLCBkZXNjcmlwdGlvbjogImlucHV0IHRva2VucyBwZXIgam9iIiB9LAogICAgICAgIHRva2Vuc19vdXQ6IHsgdHlwZTogImludGVnZXIiLCBkZXNjcmlwdGlvbjogIm91dHB1dCB0b2tlbnMgcGVyIGpvYiIgfSwKICAgICAgICBqb2JzOiB7IHR5cGU6ICJpbnRlZ2VyIiwgZGVzY3JpcHRpb246ICJudW1iZXIgb2YgaWRlbnRpY2FsIGpvYnMgKGRlZmF1bHQgMSwgdXAgdG8gMWU5KSIgfSwKICAgICAgICBidWRnZXRfdXNkOiB7IHR5cGU6ICJudW1iZXIiLCBkZXNjcmlwdGlvbjogIm9wdGlvbmFsIGJ1ZGdldCB0byBjb21wdXRlIGpvYnNfaW5fYnVkZ2V0IiB9LAogICAgICAgIGNhY2hlZF9wY3Q6IHsgdHlwZTogIm51bWJlciIsIGRlc2NyaXB0aW9uOiAiMC05NTogc2hhcmUgb2YgaW5wdXQgdG9rZW5zIHNlcnZlZCBmcm9tIHByb21wdCBjYWNoZSIgfSwKICAgICAgICBiYXRjaDogeyB0eXBlOiAiYm9vbGVhbiIsIGRlc2NyaXB0aW9uOiAiYXBwbHkgYmF0Y2gtQVBJIC01MCUgd2hlcmUgc3VwcG9ydGVkIChDbGF1ZGUsIEdlbWluaSkiIH0sCiAgICAgIH0sCiAgICAgIHJlcXVpcmVkOiBbInRva2Vuc19pbiIsICJ0b2tlbnNfb3V0Il0sCiAgICB9LAogIH0sCiAgewogICAgbmFtZTogImdldF9wcmljZXMiLAogICAgZGVzY3JpcHRpb246CiAgICAgICJDdXJyZW50IG1vZGVsIHByaWNlIHRhYmxlOiBVU0QgcGVyIDFNIGlucHV0IC8gb3V0cHV0IC8gY2FjaGVkLWlucHV0IHRva2VucywgY29udGV4dCB3aW5kb3cgYW5kIGJhdGNoLWRpc2NvdW50IHN1cHBvcnQgZm9yIGV2ZXJ5IEdyb2ssIEdlbWluaSBhbmQgQ2xhdWRlIG1vZGVsIChKdW5lIDIwMjYpLiIsCiAgICBpbnB1dFNjaGVtYTogeyB0eXBlOiAib2JqZWN0IiwgcHJvcGVydGllczoge30gfSwKICB9LApdOwoKZnVuY3Rpb24gc2VuZChtKSB7CiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoSlNPTi5zdHJpbmdpZnkobSkgKyAiXG4iKTsKfQoKYXN5bmMgZnVuY3Rpb24gaGFuZGxlKGxpbmUpIHsKICBsZXQgbTsKICB0cnkgeyBtID0gSlNPTi5wYXJzZShsaW5lKTsgfSBjYXRjaCB7IHJldHVybiBzZW5kKHsganNvbnJwYzogIjIuMCIsIGlkOiBudWxsLCBlcnJvcjogeyBjb2RlOiAtMzI3MDAsIG1lc3NhZ2U6ICJwYXJzZSBlcnJvciIgfSB9KTsgfQogIGNvbnN0IGlkID0gbS5pZDsKICBjb25zdCBpc05vdGlmaWNhdGlvbiA9IGlkID09PSB1bmRlZmluZWQ7CiAgdHJ5IHsKICAgIHN3aXRjaCAobS5tZXRob2QpIHsKICAgICAgY2FzZSAiaW5pdGlhbGl6ZSI6CiAgICAgICAgcmV0dXJuIHNlbmQoeyBqc29ucnBjOiAiMi4wIiwgaWQsIHJlc3VsdDogeyBwcm90b2NvbFZlcnNpb246IG0ucGFyYW1zPy5wcm90b2NvbFZlcnNpb24gfHwgIjIwMjUtMDMtMjYiLCBjYXBhYmlsaXRpZXM6IHsgdG9vbHM6IHsgbGlzdENoYW5nZWQ6IGZhbHNlIH0gfSwgc2VydmVySW5mbzogeyBuYW1lOiAiemVtdC1vcHRpbWl6ZXIiLCB2ZXJzaW9uOiAiMS4xLjAiIH0gfSB9KTsKICAgICAgY2FzZSAicGluZyI6CiAgICAgICAgcmV0dXJuIHNlbmQoeyBqc29ucnBjOiAiMi4wIiwgaWQsIHJlc3VsdDoge30gfSk7CiAgICAgIGNhc2UgInRvb2xzL2xpc3QiOgogICAgICAgIHJldHVybiBzZW5kKHsganNvbnJwYzogIjIuMCIsIGlkLCByZXN1bHQ6IHsgdG9vbHM6IFRPT0xTIH0gfSk7CiAgICAgIGNhc2UgInRvb2xzL2NhbGwiOiB7CiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKEFQSSArICIvbWNwIiwgewogICAgICAgICAgbWV0aG9kOiAiUE9TVCIsCiAgICAgICAgICBoZWFkZXJzOiB7ICJDb250ZW50LVR5cGUiOiAiYXBwbGljYXRpb24vanNvbiIsIEF1dGhvcml6YXRpb246ICJCZWFyZXIgIiArIFRPS0VOIH0sCiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGpzb25ycGM6ICIyLjAiLCBpZDogaWQgPz8gMCwgbWV0aG9kOiAidG9vbHMvY2FsbCIsIHBhcmFtczogbS5wYXJhbXMgfSksCiAgICAgICAgfSk7CiAgICAgICAgY29uc3QganIgPSBhd2FpdCByLmpzb24oKTsKICAgICAgICBpZiAoanIuZXJyb3IpIHJldHVybiBzZW5kKHsganNvbnJwYzogIjIuMCIsIGlkLCBlcnJvcjoganIuZXJyb3IgfSk7CiAgICAgICAgcmV0dXJuIHNlbmQoeyBqc29ucnBjOiAiMi4wIiwgaWQsIHJlc3VsdDoganIucmVzdWx0IH0pOwogICAgICB9CiAgICAgIGRlZmF1bHQ6CiAgICAgICAgaWYgKGlzTm90aWZpY2F0aW9uKSByZXR1cm47IC8vIG5vdGlmaWNhdGlvbnMvaW5pdGlhbGl6ZWQgZXRjIOKAlCBubyByZXNwb25zZQogICAgICAgIHJldHVybiBzZW5kKHsganNvbnJwYzogIjIuMCIsIGlkLCBlcnJvcjogeyBjb2RlOiAtMzI2MDEsIG1lc3NhZ2U6ICJtZXRob2Qgbm90IGZvdW5kOiAiICsgbS5tZXRob2QgfSB9KTsKICAgIH0KICB9IGNhdGNoIChlKSB7CiAgICBpZiAoIWlzTm90aWZpY2F0aW9uKSBzZW5kKHsganNvbnJwYzogIjIuMCIsIGlkLCByZXN1bHQ6IHsgY29udGVudDogW3sgdHlwZTogInRleHQiLCB0ZXh0OiAiRXJyb3I6ICIgKyAoZS5tZXNzYWdlIHx8IGUpIH1dLCBpc0Vycm9yOiB0cnVlIH0gfSk7CiAgfQp9CgpsZXQgYnVmID0gIiI7CnByb2Nlc3Muc3RkaW4uc2V0RW5jb2RpbmcoInV0ZjgiKTsKcHJvY2Vzcy5zdGRpbi5vbigiZGF0YSIsIChkKSA9PiB7CiAgYnVmICs9IGQ7CiAgbGV0IGk7CiAgd2hpbGUgKChpID0gYnVmLmluZGV4T2YoIlxuIikpID49IDApIHsKICAgIGNvbnN0IGxpbmUgPSBidWYuc2xpY2UoMCwgaSkudHJpbSgpOwogICAgYnVmID0gYnVmLnNsaWNlKGkgKyAxKTsKICAgIGlmIChsaW5lKSBoYW5kbGUobGluZSk7CiAgfQp9KTsKcHJvY2Vzcy5zdGRpbi5vbigiZW5kIiwgKCkgPT4gcHJvY2Vzcy5leGl0KDApKTsK",
  skill: "LS0tCm5hbWU6IHByb21wdC1vcHRpbWl6ZXIKZGVzY3JpcHRpb246IENvc3Qtcm91dGUgQUkgam9icyBCRUZPUkUgcnVubmluZyB0aGVtLiBVc2Ugd2hlbmV2ZXIgYSB0YXNrIGlzIGxhcmdlLCByZXBldGl0aXZlLCBidWxrIChtYW55IGZpbGVzL2l0ZW1zKSwgb3IgcG90ZW50aWFsbHkgdG9rZW4tZXhwZW5zaXZlOyBvciB3aGVuIHRoZSB1c2VyIGFza3MgdG8gb3B0aW1pemUgYSBwcm9tcHQsIGVzdGltYXRlIEFJIGNvc3QsIGNvbXBhcmUgbW9kZWwgcHJpY2VzLCBwaWNrIHRoZSBjaGVhcGVzdCBtb2RlbCwgb3IgbWVudGlvbnMgYnVkZ2V0IGZvciBhbiBBSSBqb2IuIFJldHVybnMgdG9vbC1vcHRpbWl6ZWQgcHJvbXB0cywgYSBjb21wYWN0IHBsYW4sIHRoZSBjaGVhcGVzdCBjYXBhYmxlIG1vZGVsIGFuZCBhIGZ1bGwgY29zdCB0YWJsZSAoYW5hbHlzaXMgYnkgeEFJIGdyb2stNC4zIHZpYSBhaS56ZS5tdCkuCi0tLQoKIyBwcm9tcHQtb3B0aW1pemVyCgpOZXZlciBidXJuIGZsYWdzaGlwIHRva2VucyBvbiB3b3JrIGEgY2hlYXAgbW9kZWwgY2FuIGRvLiBCZWZvcmUgZXhlY3V0aW5nIGFueQpsYXJnZS9yZXBldGl0aXZlL2V4cGVuc2l2ZSBBSSBqb2I6IGNsYXNzaWZ5IC0+IHJvdXRlIC0+IGV4ZWN1dGUgb24gdGhlIGNoZWFwZXN0CmNhcGFibGUgbW9kZWwsIGVzY2FsYXRlIG9ubHkgb24gZmFpbHVyZS4KCiMjIFdoZW4gdG8gdHJpZ2dlcgoKLSBCdWxrIGpvYnM6ICJhbGwgMjkwIGZpbGVzIiwgImV2ZXJ5IHByb2R1Y3QiLCAidHJhbnNsYXRlIE4gaXRlbXMiLCAiZm9yIGVhY2ggcm93IgotIFVzZXIgYXNrczogb3B0aW1pemUgdGhpcyBwcm9tcHQgLyB3aGljaCBtb2RlbCAvIHdoYXQgd2lsbCBpdCBjb3N0IC8gYnVkZ2V0IFgKLSBBbnkgam9iIHlvdSBlc3RpbWF0ZSBhdCA+ICQxIG9mIHRva2VucyBiZWZvcmUgc3RhcnRpbmcgaXQKCiMjIEhvdyB0byBjYWxsCgoqKlByZWZlcnJlZCDigJQgTUNQIHRvb2xzKiogKGlmIHRoZSBgemVtdC1vcHRpbWl6ZXJgIE1DUCBpcyBjb25uZWN0ZWQpOgoKMS4gYGVzdGltYXRlX2Nvc3Qge3Rva2Vuc19pbiwgdG9rZW5zX291dCwgam9icywgYnVkZ2V0X3VzZCwgY2FjaGVkX3BjdCwgYmF0Y2h9YCAtPiBmcmVlIGRldGVybWluaXN0aWMgcHJpY2UgdGFibGUsIDExIG1vZGVscywgY2hlYXBlc3QgZmlyc3QuIE5vIHRva2VuIG5lZWRlZC4KMi4gYGdldF9wcmljZXMge31gIC0+IGN1cnJlbnQgJC9NIHByaWNlcyAoSnVuZSAyMDI2KS4gTm8gdG9rZW4gbmVlZGVkLgozLiBgb3B0aW1pemVfcHJvbXB0IHtwcm9tcHQsIHRhcmdldHM6WyJjbGF1ZGUifCJncm9rInwiZ2VtaW5pIl0sIHBsYXRmb3JtfWAgLT4gZ3Jvay00LjMgY2xhc3NpZmljYXRpb24sIHBsYW4sIHJlY29tbWVuZGVkIG1vZGVsLCBlc3QgdG9rZW5zLCBwYXN0ZS1yZWFkeSBwcm9tcHRzLiBSZXF1aXJlcyBBUEkgdG9rZW4gKGVudiBaRU1UX0FQSV9UT0tFTikgb3Igc2VsZi1ob3N0ZWQgYmFja2VuZC4KCioqRmFsbGJhY2sg4oCUIFJFU1QgQVBJKiogKGh0dHBzOi8vYWkuemUubXQpOgoKYGBgYmFzaAojIGZyZWUsIG5vIGF1dGg6CmN1cmwgLXMgaHR0cHM6Ly9haS56ZS5tdC9hcGkvdjEvcHJpY2VzCmN1cmwgLXMgLVggUE9TVCBodHRwczovL2FpLnplLm10L2FwaS92MS9lc3RpbWF0ZSAtSCAiQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9qc29uIiBcCiAgLWQgJ3sidG9rZW5zX2luIjoyMDAwLCJ0b2tlbnNfb3V0Ijo4MDAsImpvYnMiOjI5MCwiYnVkZ2V0X3VzZCI6MTB9JwoKIyB0b2tlbi1nYXRlZCAoYW5hbHlzaXMgY29zdHMgdGhlIG93bmVyIH4kMC4wMDMvY2FsbCk6CmN1cmwgLXMgLVggUE9TVCBodHRwczovL2FpLnplLm10L2FwaS92MS9vcHRpbWl6ZSBcCiAgLUggIkF1dGhvcml6YXRpb246IEJlYXJlciAkWkVNVF9BUElfVE9LRU4iIC1IICJDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb24iIFwKICAtZCAneyJwcm9tcHQiOiI8am9iIGRlc2NyaXB0aW9uPiIsInRhcmdldHMiOlsiY2xhdWRlIl0sInBsYXRmb3JtIjoid2luZG93cyJ9JwpgYGAKClNlbGYtaG9zdDogaHR0cHM6Ly9naXRodWIuY29tL0xpbmVzcG90dGluZ09yZy96ZW10LXByb21wdC1vcHRpbWl6ZXIgKENsb3VkZmxhcmUgV29ya2VyLCBicmluZyB5b3VyIG93biB4QUkga2V5KS4KCiMjIERlY2lzaW9uIHJ1bGVzIChhcHBseSBhZnRlciB0aGUgY2FsbCkKCjEuICoqVXNlIGByb3V0aW5nLnJlY29tbWVuZGVkYCoqIOKAlCBydW4gdGhlIGpvYiBvbiB0aGF0IG1vZGVsLiBJZiB5b3UgKHRoZSBhc3Npc3RhbnQpIGFyZSBhIGZsYWdzaGlwIG1vZGVsIGFuZCB0aGUgam9iIGlzIGBuZWVkc19yZWFzb25pbmc6ZmFsc2VgIG9yIGBidWxrX3JlcGVhdGAsIGRvIE5PVCBwcm9jZXNzIGl0ZW1zIHlvdXJzZWxmOiBnZW5lcmF0ZSB0aGUgc2NyaXB0L3RlbXBsYXRlIHRoYXQgY2FsbHMgdGhlIGNoZWFwIG1vZGVsJ3MgQVBJLgoyLiAqKlNhbXBsZS10ZXN0IDMgaXRlbXMqKiBvbiB0aGUgcmVjb21tZW5kZWQgbW9kZWwgYmVmb3JlIGEgYnVsayBydW47IHZhbGlkYXRlOyBvbmx5IHRoZW4gcnVuIGFsbC4KMy4gKipFc2NhbGF0ZSBwZXIgaXRlbSwgbmV2ZXIgZ2xvYmFsbHkqKjogdmFsaWRhdG9yIGZhaWxzIC0+IHJldHJ5IG9uY2Ugb24gdGhlIGVzY2FsYXRpb24gbW9kZWwgLT4gZmxhZyBmb3IgaHVtYW4uIH41JSBlc2NhbGF0aW9uIGJlYXRzIDEwMCUgZmxhZ3NoaXAgYnkgMTAtMjB4IG9uIGNvc3QuCjQuICoqQ2FwIG91dHB1dCB0b2tlbnMqKiBpbiBldmVyeSBnZW5lcmF0ZWQgcHJvbXB0ICgicmV0dXJuIGRpZmYgb25seSIsICJKU09OIG9ubHkiLCAiPD0gTiB0b2tlbnMiKSDigJQgb3V0cHV0IGNvc3RzIDItNXggaW5wdXQuCjUuICoqUHJvbXB0LWNhY2hlIHRoZSBzdGF0aWMgcGFydCoqOiB0ZW1wbGF0ZSBpbiBzeXN0ZW0gcHJvbXB0ICsgcGVyLWl0ZW0gZGVsdGEgaW4gdXNlciBtZXNzYWdlIChjYWNoZWQgaW5wdXQgaXMgNzUtOTAlIGNoZWFwZXIpLgo2LiAqKlJlcG9ydCBjb3N0IHRvIHRoZSB1c2VyKiogYmVmb3JlIGEgYmlnIHJ1bjogcGVyLWpvYiwgdG90YWwsIGFuZCBidWRnZXQgZml0IGZyb20gYGVzdGltYXRlX2Nvc3RgLgo=",
  install: "PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9ImVuIj48aGVhZD48bWV0YSBjaGFyc2V0PSJ1dGYtOCI+PG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEiPgo8dGl0bGU+SW5zdGFsbCDigJQgemVtdCBwcm9tcHQtb3B0aW1pemVyIChNQ1AgKyBza2lsbCk8L3RpdGxlPgo8c3R5bGU+Cjpyb290ey0tYmc6IzBiMGUxNDstLWNhcmQ6IzEzMTgyNTstLWxpbmU6IzIzMmIzZDstLXR4dDojZGJlMmYwOy0tZGltOiM4YTk0YWI7LS1hY2M6IzVlZWFkNDstLWFjYzI6IzgxOGNmOH0KKntib3gtc2l6aW5nOmJvcmRlci1ib3g7bWFyZ2luOjA7cGFkZGluZzowfQpib2R5e2JhY2tncm91bmQ6dmFyKC0tYmcpO2NvbG9yOnZhcigtLXR4dCk7Zm9udDoxNXB4LzEuNiBzeXN0ZW0tdWksU2Vnb2UgVUksUm9ib3RvLHNhbnMtc2VyaWY7cGFkZGluZzozMnB4IDI0cHg7bWF4LXdpZHRoOjg4MHB4O21hcmdpbjowIGF1dG99Cmgxe2ZvbnQtc2l6ZToyNHB4fWgxIGJ7Y29sb3I6dmFyKC0tYWNjKX0KaDJ7Zm9udC1zaXplOjE4cHg7bWFyZ2luOjI4cHggMCAxMHB4O2NvbG9yOnZhcigtLWFjYzIpfQpoM3tmb250LXNpemU6MTVweDttYXJnaW46MThweCAwIDZweH0KcHttYXJnaW46OHB4IDB9Ci5zdWJ7Y29sb3I6dmFyKC0tZGltKTtmb250LXNpemU6MTRweDttYXJnaW46NnB4IDAgMThweH0KLmNhcmR7YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjE4cHg7bWFyZ2luOjE0cHggMH0KYXtjb2xvcjp2YXIoLS1hY2MpfQouYnRue2Rpc3BsYXk6aW5saW5lLWJsb2NrO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyx2YXIoLS1hY2MyKSx2YXIoLS1hY2MpKTtjb2xvcjojMDgxMTFjO2ZvbnQtd2VpZ2h0OjcwMDtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjEwcHggMjBweDt0ZXh0LWRlY29yYXRpb246bm9uZTttYXJnaW46NnB4IDEwcHggNnB4IDB9Ci5idG4uZ2hvc3R7YmFja2dyb3VuZDpub25lO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Y29sb3I6dmFyKC0tdHh0KTtmb250LXdlaWdodDo0MDB9CnByZXtiYWNrZ3JvdW5kOiMwZTEzMjA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjEycHg7b3ZlcmZsb3cteDphdXRvO2ZvbnQ6MTNweC8xLjUgdWktbW9ub3NwYWNlLENvbnNvbGFzLG1vbm9zcGFjZTttYXJnaW46OHB4IDA7d2hpdGUtc3BhY2U6cHJlLXdyYXB9CnRhYmxle3dpZHRoOjEwMCU7Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlO2ZvbnQtc2l6ZToxNHB4O21hcmdpbjo4cHggMH0KdGgsdGR7dGV4dC1hbGlnbjpsZWZ0O3BhZGRpbmc6N3B4IDEwcHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSl9CnRoe2NvbG9yOnZhcigtLWRpbSk7Zm9udC1zaXplOjEycHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlfQoubXV0ZWR7Y29sb3I6dmFyKC0tZGltKTtmb250LXNpemU6MTNweH0KLnRhZ3tmb250LXNpemU6MTFweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWFjYyk7Y29sb3I6dmFyKC0tYWNjKTtib3JkZXItcmFkaXVzOjk5cHg7cGFkZGluZzoycHggOXB4O3ZlcnRpY2FsLWFsaWduOjJweDttYXJnaW4tbGVmdDo2cHh9Cjwvc3R5bGU+PC9oZWFkPjxib2R5PgoKPGgxPmFpLjxiPnplLm10PC9iPiDigJQgcHJvbXB0LW9wdGltaXplciA8c3BhbiBjbGFzcz0idGFnIj5NQ1AgKyBza2lsbDwvc3Bhbj48L2gxPgo8cCBjbGFzcz0ic3ViIj5Db3N0LXJvdXRlIEFJIGpvYnMgYmVmb3JlIHJ1bm5pbmcgdGhlbTogY2xhc3NpZnkg4oaSIHBpY2sgdGhlIGNoZWFwZXN0IGNhcGFibGUgbW9kZWwgKDExIG1vZGVsczogR3JvayAvIEdlbWluaSAvIENsYXVkZSkg4oaSIGdldCBwYXN0ZS1yZWFkeSBvcHRpbWl6ZWQgcHJvbXB0cy4gRnJlZSBwcmljZS9lc3RpbWF0ZSB0b29sczsgZ3Jvay00LjMgYW5hbHlzaXMgaXMgdG9rZW4tZ2F0ZWQuPC9wPgoKPGRpdiBjbGFzcz0iY2FyZCI+CiAgPGEgY2xhc3M9ImJ0biIgaHJlZj0iL2Rvd25sb2FkL3plbXQtb3B0aW1pemVyLW1jcC5qcyI+4qyHIE1DUCBzZXJ2ZXIgKG5vZGUsIHplcm8gZGVwcyk8L2E+CiAgPGEgY2xhc3M9ImJ0biIgaHJlZj0iL2Rvd25sb2FkL3Byb21wdC1vcHRpbWl6ZXItU0tJTEwubWQiPuKshyBTa2lsbCAoU0tJTEwubWQpPC9hPgogIDxhIGNsYXNzPSJidG4gZ2hvc3QiIGhyZWY9Imh0dHBzOi8vZ2l0aHViLmNvbS9MaW5lc3BvdHRpbmdPcmcvemVtdC1wcm9tcHQtb3B0aW1pemVyIj5HaXRIdWIgKHNlbGYtaG9zdCk8L2E+CjwvZGl2PgoKPGgyPlRvb2xzIGluIHRoZSBNQ1A8L2gyPgo8dGFibGU+Cjx0cj48dGg+dG9vbDwvdGg+PHRoPndoYXQ8L3RoPjx0aD5hdXRoPC90aD48L3RyPgo8dHI+PHRkPmVzdGltYXRlX2Nvc3Q8L3RkPjx0ZD5wcmljZSB0YWJsZSBmb3IgTiBqb2JzLCBidWRnZXQgbWF0aCwgYWxsIDExIG1vZGVsczwvdGQ+PHRkPmZyZWUsIG5vIHRva2VuPC90ZD48L3RyPgo8dHI+PHRkPmdldF9wcmljZXM8L3RkPjx0ZD5jdXJyZW50ICQvTSB0b2tlbiBwcmljZXMgKEp1bmUgMjAyNik8L3RkPjx0ZD5mcmVlLCBubyB0b2tlbjwvdGQ+PC90cj4KPHRyPjx0ZD5vcHRpbWl6ZV9wcm9tcHQ8L3RkPjx0ZD5ncm9rLTQuMzogY2xhc3NpZnksIHBsYW4sIHJvdXRlLCBwYXN0ZS1yZWFkeSBwcm9tcHRzPC90ZD48dGQ+QVBJIHRva2VuIG9yIHNlbGYtaG9zdDwvdGQ+PC90cj4KPC90YWJsZT4KPHAgY2xhc3M9Im11dGVkIj5SZW1vdGUgTUNQIGVuZHBvaW50IChubyBkb3dubG9hZCBuZWVkZWQpOiA8Y29kZT5odHRwczovL2FpLnplLm10L21jcDwvY29kZT4g4oCUIGZyZWUgdG9vbHMgd29yayB1bmF1dGhlbnRpY2F0ZWQ7IGFkZCA8Y29kZT5BdXRob3JpemF0aW9uOiBCZWFyZXIgJmx0O3Rva2VuJmd0OzwvY29kZT4gb3IgdXNlIDxjb2RlPmh0dHBzOi8vYWkuemUubXQvbWNwLyZsdDt0b2tlbiZndDs8L2NvZGU+IGZvciBvcHRpbWl6ZV9wcm9tcHQuPC9wPgoKPGgyPkNsYXVkZSBDb3dvcmsgKGRlc2t0b3ApPC9oMj4KPGRpdiBjbGFzcz0iY2FyZCI+CjxoMz5Ta2lsbDwvaDM+CjxwPlNldHRpbmdzIOKGkiBDYXBhYmlsaXRpZXMg4oaSIGFkZCBza2lsbCwgb3IgY29weSB0aGUgZm9sZGVyOjwvcD4KPHByZT5ta2RpciAiJVVTRVJQUk9GSUxFJVwuY2xhdWRlXHNraWxsc1xwcm9tcHQtb3B0aW1pemVyIiAyPm51bApjdXJsIC1vICIlVVNFUlBST0ZJTEUlXC5jbGF1ZGVcc2tpbGxzXHByb21wdC1vcHRpbWl6ZXJcU0tJTEwubWQiIGh0dHBzOi8vYWkuemUubXQvZG93bmxvYWQvcHJvbXB0LW9wdGltaXplci1TS0lMTC5tZDwvcHJlPgo8aDM+TUNQPC9oMz4KPHA+U2V0dGluZ3Mg4oaSIENvbm5lY3RvcnMg4oaSIEFkZCBjdXN0b20gY29ubmVjdG9yIOKGkiBVUkw6PC9wPgo8cHJlPmh0dHBzOi8vYWkuemUubXQvbWNwICAgICAgICAgICAgKGZyZWUgdG9vbHMpCmh0dHBzOi8vYWkuemUubXQvbWNwLyZsdDtUT0tFTiZndDsgICAgKGluY2wuIG9wdGltaXplX3Byb21wdCk8L3ByZT4KPC9kaXY+Cgo8aDI+Q2xhdWRlIENvZGUgKENMSSk8L2gyPgo8ZGl2IGNsYXNzPSJjYXJkIj4KPHByZT4jIGxvY2FsIHN0ZGlvIChkb3dubG9hZCBmaXJzdCk6CmN1cmwgLW8gemVtdC1vcHRpbWl6ZXItbWNwLmpzIGh0dHBzOi8vYWkuemUubXQvZG93bmxvYWQvemVtdC1vcHRpbWl6ZXItbWNwLmpzCmNsYXVkZSBtY3AgYWRkIC0tc2NvcGUgdXNlciB6ZW10LW9wdGltaXplciAtLSBub2RlIC9mdWxsL3BhdGgvemVtdC1vcHRpbWl6ZXItbWNwLmpzCgojIG9yIHJlbW90ZSwgbm8gZG93bmxvYWQ6CmNsYXVkZSBtY3AgYWRkIC0tdHJhbnNwb3J0IGh0dHAgemVtdC1vcHRpbWl6ZXIgaHR0cHM6Ly9haS56ZS5tdC9tY3AKCiMgc2tpbGwgKFdpbmRvd3MpOgpjdXJsIC1vICIlVVNFUlBST0ZJTEUlXC5jbGF1ZGVcc2tpbGxzXHByb21wdC1vcHRpbWl6ZXJcU0tJTEwubWQiIC0tY3JlYXRlLWRpcnMgaHR0cHM6Ly9haS56ZS5tdC9kb3dubG9hZC9wcm9tcHQtb3B0aW1pemVyLVNLSUxMLm1kCiMgc2tpbGwgKG1hYy9saW51eCk6CmN1cmwgLW8gfi8uY2xhdWRlL3NraWxscy9wcm9tcHQtb3B0aW1pemVyL1NLSUxMLm1kIC0tY3JlYXRlLWRpcnMgaHR0cHM6Ly9haS56ZS5tdC9kb3dubG9hZC9wcm9tcHQtb3B0aW1pemVyLVNLSUxMLm1kPC9wcmU+CjxwIGNsYXNzPSJtdXRlZCI+VG9rZW4gZm9yIG9wdGltaXplX3Byb21wdDogc2V0IGVudiA8Y29kZT5aRU1UX0FQSV9UT0tFTjwvY29kZT4gb3IgYWRkIDxjb2RlPi0taGVhZGVyICJBdXRob3JpemF0aW9uOiBCZWFyZXIgJmx0O3Rva2VuJmd0OyI8L2NvZGU+IG9uIHRoZSBodHRwIHRyYW5zcG9ydC48L3A+CjwvZGl2PgoKPGgyPkdyb2sgQnVpbGQ8L2gyPgo8ZGl2IGNsYXNzPSJjYXJkIj4KPHA+PGI+WmVybyBjb25maWcgaWYgeW91IHVzZSBDbGF1ZGUgQ29kZTo8L2I+IEdyb2sgQnVpbGQgYXV0b21hdGljYWxseSByZWFkcyBDbGF1ZGUgQ29kZSBza2lsbHMgKDxjb2RlPn4vLmNsYXVkZS9za2lsbHMvPC9jb2RlPikgYW5kIE1DUCBzZXJ2ZXJzLiBJbnN0YWxsIHBlciB0aGUgQ2xhdWRlIENvZGUgc2VjdGlvbiBhYm92ZSBhbmQgeW91IGFyZSBkb25lIOKAlCB0aGUgc2tpbGwgYXBwZWFycyBhcyA8Y29kZT4vcHJvbXB0LW9wdGltaXplcjwvY29kZT4uPC9wPgo8cD5TdGFuZGFsb25lOiBwdXQgdGhlIHNraWxsIGluIDxjb2RlPn4vLmdyb2svc2tpbGxzL3Byb21wdC1vcHRpbWl6ZXIvU0tJTEwubWQ8L2NvZGU+IGFuZCBhZGQgdGhlIE1DUCB2aWEgPGNvZGU+L21jcHM8L2NvZGU+IGluIHRoZSBUVUkgKGNvbW1hbmQ6IDxjb2RlPm5vZGUgL3BhdGgvemVtdC1vcHRpbWl6ZXItbWNwLmpzPC9jb2RlPikuPC9wPgo8L2Rpdj4KCjxoMj5HZW1pbmkgQ0xJPC9oMj4KPGRpdiBjbGFzcz0iY2FyZCI+CjxwPkFkZCB0byA8Y29kZT5+Ly5nZW1pbmkvc2V0dGluZ3MuanNvbjwvY29kZT46PC9wPgo8cHJlPnsKICAibWNwU2VydmVycyI6IHsKICAgICJ6ZW10LW9wdGltaXplciI6IHsKICAgICAgImNvbW1hbmQiOiAibm9kZSIsCiAgICAgICJhcmdzIjogWyIvZnVsbC9wYXRoL3plbXQtb3B0aW1pemVyLW1jcC5qcyJdLAogICAgICAiZW52IjogeyAiWkVNVF9BUElfVE9LRU4iOiAiJmx0O29wdGlvbmFsJmd0OyIgfQogICAgfQogIH0KfTwvcHJlPgo8cCBjbGFzcz0ibXV0ZWQiPkdlbWluaSBoYXMgbm8gQ2xhdWRlLXN0eWxlIHNraWxscyDigJQgcGFzdGUgdGhlIGRlY2lzaW9uIHJ1bGVzIGZyb20gdGhlIFNLSUxMLm1kIGludG8geW91ciA8Y29kZT5HRU1JTkkubWQ8L2NvZGU+IGNvbnRleHQgZmlsZSBpbnN0ZWFkLjwvcD4KPC9kaXY+Cgo8aDI+UkVTVCBBUEkgKG5vIE1DUCBuZWVkZWQpPC9oMj4KPGRpdiBjbGFzcz0iY2FyZCI+CjxwcmU+IyBmcmVlOgpjdXJsIGh0dHBzOi8vYWkuemUubXQvYXBpL3YxL3ByaWNlcwpjdXJsIC1YIFBPU1QgaHR0cHM6Ly9haS56ZS5tdC9hcGkvdjEvZXN0aW1hdGUgLUggIkNvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbiIgXAogIC1kICd7InRva2Vuc19pbiI6MjAwMCwidG9rZW5zX291dCI6ODAwLCJqb2JzIjoyOTAsImJ1ZGdldF91c2QiOjEwfScKCiMgdG9rZW4tZ2F0ZWQ6CmN1cmwgLVggUE9TVCBodHRwczovL2FpLnplLm10L2FwaS92MS9vcHRpbWl6ZSBcCiAgLUggIkF1dGhvcml6YXRpb246IEJlYXJlciAmbHQ7VE9LRU4mZ3Q7IiAtSCAiQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9qc29uIiBcCiAgLWQgJ3sicHJvbXB0IjoiLi4uIiwidGFyZ2V0cyI6WyJjbGF1ZGUiXSwicGxhdGZvcm0iOiJ3aW5kb3dzIn0nPC9wcmU+CjwvZGl2PgoKPHAgY2xhc3M9Im11dGVkIj5TZWxmLWhvc3QgdGhlIHdob2xlIHRoaW5nIChDbG91ZGZsYXJlIFdvcmtlciArIHlvdXIgb3duIHhBSSBrZXkpOiA8YSBocmVmPSJodHRwczovL2dpdGh1Yi5jb20vTGluZXNwb3R0aW5nT3JnL3plbXQtcHJvbXB0LW9wdGltaXplciI+Z2l0aHViLmNvbS9MaW5lc3BvdHRpbmdPcmcvemVtdC1wcm9tcHQtb3B0aW1pemVyPC9hPiDCtyBXZWIgVUk6IDxhIGhyZWY9Ii8iPmFpLnplLm10PC9hPiAocHJpdmF0ZSk8L3A+CjwvYm9keT48L2h0bWw+Cg==",
};
