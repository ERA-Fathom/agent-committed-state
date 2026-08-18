# A committed-state layer for stateful agents

A long-horizon agent makes commitments to itself as it runs. Over a long build a coding
agent renames a field, changes a function signature, settles a routing decision, and a
later step has to honor each one. When the run outgrows the platform's memory horizon,
the agent works from a partial view of its own history and writes against a decision it
can no longer see. The task in front of it was not hard. The agent handled it incorrectly
because it lost an accurate account of what it had already done.

This repository is a small, deployable demonstration of two ways to give that history
back to the agent, and a probe that measures what each one costs. It runs as a single
[Cloudflare Worker](https://developers.cloudflare.com/workers/): a SQLite-backed Durable
Object holds the committed-state layer, and Workers AI embeddings plus
[Vectorize](https://developers.cloudflare.com/vectorize/) provide a managed-memory arm in
the same retrieve-then-inject shape the major agent platforms use.

## The two arms

**The committed-state layer.** Every commitment the agent makes is stored as a verbatim
record keyed by what it named. Re-grounding the agent on one fact is an O(1) lookup that
returns the exact record. It is deterministic (the same actions produce the same record),
its size tracks the working set rather than the whole growing history, and it is a record
an auditor can read.

**The managed-memory arm.** The session is embedded and stored in a vector index, then
retrieved by relevance and injected back at the dependent step. This recovers the fact
too. It differs in three ways that only show up under measurement: the retrieved payload
is a reconstruction rather than a stored record, its cost is driven by how much has
accumulated, and it leaves nothing exact for a control framework to cite.

Both arms recover the fact. The point of the probe is that recovering it is not the whole
story: *how* the history is kept decides the cost, the determinism, and the auditability.

## What the probe measures

`probe/cost_probe.py` stores a session of distinct, non-inferable commitments (each a
handler registered for an event, with arbitrary names so nothing can be compressed and
guessed back), then re-grounds the agent on one of them through each arm and reports the
injected size and whether the fact was recovered.

```bash
# offline, no network, no spend: power + specificity check
python probe/cost_probe.py --selftest

# against a deployed Worker (small embedding calls)
python probe/cost_probe.py --live \
  --endpoint https://<your-worker>.workers.dev/ \
  --sizes 10,40,100 --repeats 6
```

The committed-state layer holds flat as the session grows. The managed arm here is
retrieval-bounded with a fixed top-k budget, so its injected size flattens once the
session exceeds the budget, and the sharper signal to watch is whether top-k retrieval
still surfaces the exact target as the table fills with distractors. On platforms whose
managed memory injects a model-generated summary of the accumulated state instead of a
fixed budget, the re-grounding cost grows with the number of commitments; see
[`docs/RESULTS.md`](docs/RESULTS.md).

## Deploy

Requires a Cloudflare account on a Workers Paid plan (Vectorize) and
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/). Authenticate with
`wrangler login`; do not put an account id or an API token in any file here.

```bash
cd worker
wrangler vectorize create committed-state-mem --dimensions=768 --metric=cosine
wrangler deploy
```

Then confirm the embedding dimension matches the index before any grid:

```bash
curl "https://<your-worker>.workers.dev/embdims?model=@cf/baai/bge-base-en-v1.5"   # expect dims: 768
```

Routes are documented at the top of [`worker/worker.js`](worker/worker.js).

## Scope, and what this is not

This is a demonstration of the committed-state idea and a way to measure the cost of
memory, not a benchmark verdict on any platform. Where it quotes numbers, they were taken
under a matched control that hands the agent its current state and isolates ordinary task
difficulty, so any difference between arms is the cost of self-tracking and nothing else.
The measurement holds the task fixed and varies only how the agent remembers. Read the raw
per-run numbers before the means.

The full instrument that decomposes an agent's coherence cost into task difficulty and the
burden of keeping its own record consistent, and scores it across models and platforms, is
part of the Fathom™ program at [Embedded Risk Analytics](https://embeddedriskanalytics.com)
and is not included here. This repository is the deployable, self-contained piece.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Trademarks

Fathom™ is a trademark of Embedded Risk Analytics. The Apache-2.0 license granting rights
to this code does not grant any right to use the Embedded Risk Analytics name or the
Fathom mark. See [NOTICE](NOTICE).
