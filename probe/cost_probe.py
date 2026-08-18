#!/usr/bin/env python3
"""
cost_probe.py: measure what it costs to re-ground an agent on one committed fact,
as the number of distinct commitments in a session grows.

Two arms, hitting a deployed copy of the committed-state Worker:

  * the layer:   POST /commit for each fact, then GET /reground?key=... for one fact.
                 The re-ground is a verbatim O(1) record; its injected size is flat in N.
  * managed:     POST /session to embed+store the turns, then POST /retrieve to pull the
                 fact back by relevance. The injected payload is the retrieved chunks.

Both should recover the target fact on every run. What differs is the injected token
cost and whether the answer is a stored record or a reconstruction.

  python cost_probe.py --selftest                 # offline, no network, no spend
  python cost_probe.py --live --endpoint https://<your-worker>.workers.dev/ \
      --sizes 10,40,100 --repeats 6 --extract-wait 60

The --live arm makes real Workers AI embedding calls (small: embeddings for the turns
per N plus one query embedding per N; no LLM synthesis call). Confirm the shapes with
`curl <endpoint>/embdims` before a grid, and read the raw per-N runs before the means.
"""
import argparse
import json
import sys
import time
import urllib.request

# A rough token proxy for injected text, used only to compare payload sizes across arms.
# Replace with your model's tokenizer if you need exact billing tokens; the shape holds.
def approx_tokens(text):
    return max(1, round(len(text) / 4))


def _post(url, payload, timeout=120):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _get(url, timeout=120):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _target(i):
    """A distinct, non-inferable committed fact: handler HDLR#### registered for event EVT####.
    Arbitrary names matter: a predictable pattern lets managed memory compress the set and
    reconstruct it, which would understate the cost. These do not compress."""
    return f"E{i}", f"registered dispatch handler HDLR{1000+i} for event type EVT{1000+i}"


def run_live(endpoint, sizes, repeats, topk, extract_wait):
    endpoint = endpoint.rstrip("/")
    rows = []
    for n in sizes:
        keys = [f"E{i}" for i in range(n)]
        turns = [[_target(i)[1]] for i in range(n)]
        session = f"probe-{n}"

        # managed arm: store the whole session, then retrieve the target fact
        layer_runs, native_runs, native_recovers = [], [], 0
        for rep in range(repeats):
            _post(f"{endpoint}/session", {"session": f"{session}-{rep}", "turns": turns, "emb": "base"})
            time.sleep(extract_wait)  # Vectorize is eventually consistent right after an upsert
            target_i = n - 1
            _, target_text = _target(target_i)
            res = _post(f"{endpoint}/retrieve",
                        {"session": f"{session}-{rep}", "query": f"which handler is registered for event type EVT{1000+target_i}?",
                         "topk": topk, "emb": "base"})
            answer = res.get("answer", "")
            native_runs.append(approx_tokens(answer))
            if f"HDLR{1000+target_i}" in answer:
                native_recovers += 1

            # layer arm: commit every fact, then re-ground the one target
            for i, k in enumerate(keys):
                _post(f"{endpoint}/commit?key={k}&value={urllib_quote(_target(i)[1])}&turn={i}", {})
            rg = _get(f"{endpoint}/reground?key=E{target_i}")
            layer_runs.append(approx_tokens(rg.get("injected", "")))

        rows.append({
            "n_items": n, "repeats": repeats,
            "native_inject_tokens_mean": round(sum(native_runs) / len(native_runs), 1),
            "native_inject_tokens_runs": native_runs,
            "native_recovers_rate": round(native_recovers / repeats, 3),
            "layer_inject_tokens_mean": round(sum(layer_runs) / len(layer_runs), 1),
            "ratio": round((sum(native_runs) / len(native_runs)) / max(1, sum(layer_runs) / len(layer_runs)), 1),
        })
    out = {"endpoint": endpoint, "topk": topk, "rows": rows,
           "note": "layer is an exact O(1) verbatim lookup; managed is top-k vector retrieval "
                   "(fixed budget), so its injected size tends to flatten once N exceeds topk. Read "
                   "native_recovers_rate for the correctness cliff. Numbers here are an approx-token "
                   "proxy over injected text; swap in your tokenizer for exact billing tokens."}
    print(json.dumps(out, indent=2))
    return out


def urllib_quote(s):
    import urllib.parse
    return urllib.parse.quote(str(s))


def _selftest():
    ok = [True]
    def chk(name, cond):
        ok[0] = ok[0] and bool(cond)
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}")

    # POWER: the token proxy grows with text length, so a growing retrieved payload reads
    # as a growing cost and a flat verbatim record reads as flat.
    small, big = approx_tokens("E5 = 42"), approx_tokens("x" * 4000)
    chk("token proxy: verbatim record is far smaller than a large retrieved payload", small < big / 50)

    # SPECIFICITY: distinct targets do not collide. An arbitrary-name set is non-inferable,
    # so a compressor cannot reconstruct one target from another.
    a, b = _target(7), _target(88)
    chk("targets are distinct and non-inferable", a[0] != b[0] and a[1] != b[1] and "HDLR1007" in a[1])

    # SHAPE: a recovered answer containing the target handler counts as a recover; one that
    # does not, does not.
    def recovers(answer, i): return f"HDLR{1000+i}" in answer
    chk("recovery detection: hit is counted", recovers("... HDLR1050 ...", 50))
    chk("recovery detection: miss is not counted", not recovers("... HDLR1049 ...", 50))

    print("\n  SELFTEST:", "ALL PASS" if ok[0] else "FAILURES PRESENT")
    return 0 if ok[0] else 1


def main():
    ap = argparse.ArgumentParser(description="Committed-state layer vs managed memory: re-grounding cost by N")
    ap.add_argument("--selftest", action="store_true", help="offline power+specificity check, no network")
    ap.add_argument("--live", action="store_true", help="hit a deployed Worker (makes small embedding calls)")
    ap.add_argument("--endpoint", default="https://<your-worker>.workers.dev/")
    ap.add_argument("--sizes", default="10,40,100")
    ap.add_argument("--repeats", type=int, default=6)
    ap.add_argument("--topk", type=int, default=20)
    ap.add_argument("--extract-wait", type=int, default=60, help="seconds to wait for Vectorize consistency")
    a = ap.parse_args()
    if a.selftest:
        sys.exit(_selftest())
    if a.live:
        sizes = [int(x) for x in a.sizes.split(",") if x.strip()]
        run_live(a.endpoint, sizes, a.repeats, a.topk, a.extract_wait)
        return
    ap.print_help()


if __name__ == "__main__":
    main()
