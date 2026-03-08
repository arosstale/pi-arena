# @artale/pi-arena

Model benchmarking and performance tracking for pi. Run tasks against models, track results, detect regressions.

## Install
```bash
npm install -g @artale/pi-arena
```

## Features (v1.1)
- **Benchmark tracking** — Record task/model/duration/score/pass runs
- **Vectara baselines** — 28 models from HHEM-2.3 hallucination leaderboard (March 2026)
- **Auto-compare** — Flag models scoring below their Vectara baseline
- **Verbosity penalty** — Detect when verbose output correlates with hallucination
- **Domain tracking** — coding, reasoning, general-knowledge, legal, medical, financial
- **Thread type tracking** — Base, P-Thread, C-Thread, F-Thread, B-Thread, L-Thread, Z-Thread

## Tools
- **arena_run** — Record a benchmark run
- **arena_history** — Query benchmark history (filter by model/domain)
- **arena_compare** — Side-by-side model comparison with Vectara baselines

## Commands
- `/arena stats` — Aggregate statistics
- `/arena baselines` — Vectara hallucination leaderboard
- `/arena leaderboard` — Model rankings by score
- `/arena history [n]` — Recent benchmark runs
- `/arena compare <A> <B>` — Head-to-head comparison
- `/arena templates` — Task templates
- `/arena export` — Export all data
