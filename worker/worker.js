// A committed-state layer for stateful agents, as a Cloudflare Worker.
//
// A long-horizon agent makes commitments to itself as it runs: it renames a field,
// settles a routing decision, records a handler for an event. A later step has to
// honor each one. This Worker exposes two ways to give that history back to the agent,
// so you can measure what each costs to keep the agent coherent:
//
//   1. A committed-state layer. A SQLite-backed Durable Object holds the verbatim
//      current value of every committed fact. Re-grounding one fact is an O(1) lookup
//      that returns the exact record. Deterministic, cost-bounded, auditable.
//
//   2. A managed-memory arm. Workers AI embeddings + Vectorize store the session and
//      retrieve it by relevance (retrieve-then-inject), the same shape as the managed
//      memory offered by the major agent platforms.
//
// Both recover the fact. They differ in cost, determinism, and whether they leave a
// record you can cite. Point the probe in /probe at a deployed copy to read the
// difference for yourself.
//
// Routes:
//   GET  /probe                              -> Workers AI usage (confirms token accounting works)
//   POST /commit?key=&value=&turn=           -> store one committed fact (the layer)
//   GET  /reground?key=                      -> deterministic verbatim re-ground of one fact (the layer)
//   GET  /count                              -> number of accumulated commitments
//   POST /session  {session,turns,emb?}      -> embed + upsert turns into Vectorize (managed arm)
//   POST /retrieve {session,query,topk,emb?} -> embed query + top-k retrieve (managed arm)
//   GET  /embdims?model=@cf/...              -> report an embedding model's output dimension
//
// Embedding models (choose per request via `emb`): base = bge-base (768-d, binding VEC),
// large = bge-large (1024-d, binding VEC1024), m3 = bge-m3 (1024-d, binding VEC1024).
// Different-dimension models need different-dimension indexes; same-dimension models
// share an index via namespaces.

import { DurableObject } from "cloudflare:workers";

const EMB = {
  base:  { model: "@cf/baai/bge-base-en-v1.5",  bind: "VEC" },      // 768-d
  large: { model: "@cf/baai/bge-large-en-v1.5", bind: "VEC1024" },  // 1024-d
  m3:    { model: "@cf/baai/bge-m3",            bind: "VEC1024" },   // 1024-d (verify via /embdims)
};
const embCfg = (name) => EMB[name] || EMB.base;

// The committed-state layer: a verbatim, per-key record of the agent's own commitments.
export class CommittedState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS commits (key TEXT PRIMARY KEY, value TEXT, turn INTEGER)"
    );
  }
  commit(key, value, turn) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO commits (key, value, turn) VALUES (?, ?, ?)", key, value, turn);
    return { ok: true, key, value, turn };
  }
  reground(key) {
    const rows = [...this.ctx.storage.sql.exec(
      "SELECT key, value, turn FROM commits WHERE key = ?", key)];
    const record = rows[0] ?? null;
    const injected = record ? `${record.key} = ${record.value}` : "";
    return { record, injected, injected_chars: injected.length };
  }
  count() {
    const rows = [...this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM commits")];
    return rows[0].n;
  }
}

// Embed texts with a chosen Workers AI model, batched to stay under a per-call cap.
async function embed(env, model, texts) {
  const BATCH = 50, out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const r = await env.AI.run(model, { text: texts.slice(i, i + BATCH) });
    for (const v of r.data) out.push(v);
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const stub = () => env.COMMITTED_STATE.get(env.COMMITTED_STATE.idFromName("demo"));

    try {
      if (path === "/probe") {
        const r = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: [{ role: "user", content: "Reply with the single word: ok" }] });
        return Response.json({ ok: true, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          response: r.response ?? r, usage: r.usage ?? null, usage_reported: !!r.usage });
      }

      // ── Committed-state layer: verbatim O(1) record ─────────────────────────────
      if (path === "/commit" && request.method === "POST") {
        const key = url.searchParams.get("key"), value = url.searchParams.get("value");
        const turn = Number(url.searchParams.get("turn") ?? 0);
        return Response.json(await stub().commit(key, value, turn));
      }
      if (path === "/reground")
        return Response.json(await stub().reground(url.searchParams.get("key")));
      if (path === "/count")
        return Response.json({ commits: await stub().count() });

      // ── Managed-memory arm: Workers AI embeddings + Vectorize (retrieve-then-inject) ──
      if (path === "/session" && request.method === "POST") {
        const { session, turns, emb } = await request.json();
        const cfg = embCfg(emb), idx = env[cfg.bind];
        if (!idx) return Response.json({ ok: false, error: `binding ${cfg.bind} not configured (create the index + add the binding)` }, { status: 400 });
        const s = String(session);
        const texts = (turns || []).map(([content]) => String(content));
        const embs = await embed(env, cfg.model, texts);
        const vectors = embs.map((values, i) => ({ id: `${s}:${i}`, namespace: s, values, metadata: { session: s, text: texts[i] } }));
        let wrote = 0;
        for (let i = 0; i < vectors.length; i += 200) { await idx.upsert(vectors.slice(i, i + 200)); wrote += Math.min(200, vectors.length - i); }
        return Response.json({ ok: true, wrote, emb: emb || "base", dims: embs[0] ? embs[0].length : null });
      }

      if (path === "/retrieve" && request.method === "POST") {
        const { session, query, topk, emb } = await request.json();
        const cfg = embCfg(emb), idx = env[cfg.bind];
        if (!idx) return Response.json({ ok: false, error: `binding ${cfg.bind} not configured` }, { status: 400 });
        const s = String(session);
        const qv = await embed(env, cfg.model, [String(query)]);
        const res = await idx.query(qv[0], { topK: Number(topk) || 20, namespace: s, returnMetadata: "all" });
        const matches = res.matches || [];
        const answer = matches.map(m => (m.metadata && m.metadata.text) ? m.metadata.text : "").join("\n");
        return Response.json({ answer, records: matches.length, emb: emb || "base",
          scores: matches.map(m => Math.round((m.score ?? 0) * 1000) / 1000) });
      }

      // Report an embedding model's output dimension, before sizing an index for it.
      if (path === "/embdims") {
        const model = url.searchParams.get("model") || "@cf/baai/bge-large-en-v1.5";
        const e = await env.AI.run(model, { text: ["dimension probe"] });
        return Response.json({ model, dims: e.data && e.data[0] ? e.data[0].length : null, usage: e.usage ?? null });
      }

      return new Response(
        "Committed-state layer (Cloudflare Worker). Routes: /probe, /commit, /reground, /count, /session, /retrieve, /embdims",
        { headers: { "content-type": "text/plain" } });
    } catch (err) {
      return Response.json({ ok: false, error: String(err), stack: err && err.stack ? String(err.stack).slice(0, 400) : null }, { status: 500 });
    }
  }
};
