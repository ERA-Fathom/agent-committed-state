# What we measured

These are results from running the committed-state idea against managed agent memory,
instrumented the same way on more than one substrate. They are reported here so the demo
in this repository has context, and so the method is legible enough to reproduce or to
disagree with.

## The setup

The agent maintains a small working service across a session and commits one change per
turn. Because the committed state is code, the true result is settled by running it rather
than by asking one model to grade another. Each condition differs only in how the agent
remembers its own history, so any difference in the result is the cost of remembering and
nothing else. A matched control hands the agent its current state and isolates ordinary
task difficulty; that control sits at zero throughout, which is what lets us attribute the
rest to self-tracking.

## Re-grounding cost grows with how much the agent has committed

The question is how many tokens the agent has to re-inject at a dependent step to recover
one committed fact, as the number of distinct commitments in the session grows. Managed
memory recovers the fact. Its cost to do so climbs, because it reconstructs the state from
a model-generated summary and the reconstruction grows as the session accumulates.

On the two major agent platforms we instrumented, recovering a single committed fact after
a hundred accumulated commitments cost roughly 3,700 tokens on one and roughly 2,000 on the
other, against about 24 tokens for a deterministic lookup of the same fact. That is on the
order of 150 times and 85 times the committed-state layer at a hundred commitments, and the
gap widens with every further commitment. Both platforms recovered the fact on every run;
the difference is entirely in the cost and the form of the answer.

## The Cloudflare arm in this repository

The Vectorize arm in this repository is retrieval-bounded: it injects a fixed top-k budget
rather than a growing summary, so its injected size flattens once the session exceeds the
budget, rather than climbing the way a summary-based managed memory does. Measured with the
same arbitrary-name methodology, the deterministic layer re-grounds one fact in about 25
tokens against a few hundred for the retrieval arm, a ratio around 30 times, flat in the
number of commitments. Because this arm is retrieval-bounded, the sharper signal to watch
is not the token ratio but `native_recovers_rate`: whether top-k retrieval still surfaces
the exact target as the table fills with distractors. The deterministic layer's exact O(1)
lookup never misses.

This is a real structural difference between a fixed-budget retrieval arm and a
summary-based managed memory, not a discrepancy in the method. Both are worth knowing:
one shows the cost climbing, the other shows a correctness cliff to watch for.

## The three properties this points at

The measurement is not that managed memory forgets the agent's work. We pushed the premium
managed-memory paths hard, with dense sessions at scale, a key renamed several times in a
chain, a dispatch table grown from ten to a hundred distinct entries, arbitrary names, and
both a frontier and a mid-tier model, and they preserved the specific commitment in every
case. The opening is in how they remember it:

1. **The default configuration is where most agents run, and it can lose the commitment.**
   A recent-window default drops an early commit once the build outgrows the window. The
   premium path is an opt-in a team has to know about, enable, and pay for.
2. **The premium path's cost grows with the committed state.** It hands back a
   reconstruction produced on demand, and the reconstruction grows as the agent accumulates
   commitments. A pilot that looks cheap at ten commitments can look very different at a
   hundred.
3. **It leaves no record an auditor can cite.** A probabilistic reconstruction is not a
   stored record. For a workload that has to satisfy a control framework, that absence is
   the binding constraint, and it is structural to anything built on a model summary.

A deterministic committed-state layer answers all three: it covers the default from the
moment it is installed, it holds the re-grounding cost flat, and it produces a verbatim
record by construction. It runs on top of the platform's managed memory and leaves that
memory in place.

## Honesty notes

- The numbers above were taken under the matched control described in the setup, and on a
  strict version of the rename task. Where a window is involved, the failure is un-induced:
  the pressure is the platform's own default meeting the length of a realistic build, not a
  window tuned to force a break.
- One early cost probe appeared to show managed memory dropping a commitment at scale.
  Re-running with arbitrary, non-inferable names showed the apparent loss was correct
  compression of information the agent could reconstruct from its pattern, and the loss
  rate went to zero. That reading was retracted rather than reported. The arbitrary-name
  methodology in the probe here is the fix.
- This is an early result with a defined scope: one substrate family, a small executable
  service, a handful of change types, and runs that test consistency rather than
  independent sampling.

Fuller write-ups, including the cross-cloud benchmark this summarizes, are available from
[Embedded Risk Analytics](https://embeddedriskanalytics.com).
