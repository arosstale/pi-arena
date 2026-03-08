/**
 * pi-arena — Model Benchmarking & Performance Tracking
 * 
 * Run tasks against multiple models, track results over time, detect regressions.
 * "You need to know which model is best for YOUR tasks." — Carmack lens
 * TAC Bet #8: Public benchmarks are saturated. Build your own.
 * 
 * /arena run <task> [models...]         → benchmark a task
 * /arena history [limit]                → show past runs
 * /arena compare <modelA> <modelB>      → side-by-side comparison
 * /arena stats                          → show aggregate statistics
 * /arena leaderboard                    → rank models by win rate
 * /arena export                         → export all data as JSON
 * /arena templates                      → show/manage task templates
 * 
 * Tools: arena_run, arena_history, arena_compare
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ARENA_DIR = join(homedir(), ".pi", "arena");
const RUNS_FILE = join(ARENA_DIR, "runs.jsonl");
const TEMPLATES_FILE = join(ARENA_DIR, "templates.json");
const BASELINES_FILE = join(ARENA_DIR, "vectara-baselines.json");

interface VectaraBaseline {
  hallucinationRate: number;
  factualConsistency: number;
  answerRate: number;
}

function loadBaselines(): Record<string, VectaraBaseline> {
  if (!existsSync(BASELINES_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(BASELINES_FILE, "utf-8"));
    return data.models || {};
  } catch { return {}; }
}

function findBaseline(model: string, baselines: Record<string, VectaraBaseline>): { key: string; data: VectaraBaseline } | null {
  const lower = model.toLowerCase();
  // Exact match first
  for (const [key, data] of Object.entries(baselines)) {
    if (key.toLowerCase() === lower) return { key, data };
  }
  // Partial match (e.g. "claude-sonnet-4" matches "anthropic/claude-sonnet-4-20250514")
  for (const [key, data] of Object.entries(baselines)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase().split("/").pop()!)) return { key, data };
  }
  return null;
}
const RST = "\x1b[0m", B = "\x1b[1m", D = "\x1b[2m";
const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m", MAGENTA = "\x1b[35m";

interface BenchmarkRun {
  id: string;
  task: string;
  model: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  score?: number;        // 1-10 quality score
  pass?: boolean;        // pass/fail
  notes?: string;
  domain?: string;       // for hallucination tracking
  tags?: string[];
  threadType?: string;   // Base, P-Thread, C-Thread, etc.
}

interface TaskTemplate {
  name: string;
  prompt: string;
  domain?: string;
  expectedBehavior?: string;
  scoringCriteria?: string;
  tags?: string[];
}

function ensureDir() {
  if (!existsSync(ARENA_DIR)) mkdirSync(ARENA_DIR, { recursive: true });
}

function appendRun(run: BenchmarkRun) {
  ensureDir();
  appendFileSync(RUNS_FILE, JSON.stringify(run) + "\n");
}

function loadRuns(limit?: number): BenchmarkRun[] {
  if (!existsSync(RUNS_FILE)) return [];
  const lines = readFileSync(RUNS_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const runs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as BenchmarkRun[];
  return limit ? runs.slice(-limit) : runs;
}

function loadTemplates(): TaskTemplate[] {
  ensureDir();
  if (!existsSync(TEMPLATES_FILE)) {
    const defaults: TaskTemplate[] = [
      { name: "code-gen", prompt: "Write a TypeScript function that...", domain: "coding", scoringCriteria: "Correctness, type safety, edge cases", tags: ["code"] },
      { name: "analysis", prompt: "Analyze this codebase and identify...", domain: "reasoning", scoringCriteria: "Accuracy, depth, actionability", tags: ["analysis"] },
      { name: "factual", prompt: "What is the capital of...", domain: "general-knowledge", scoringCriteria: "Factual accuracy", tags: ["facts"] },
      { name: "refactor", prompt: "Refactor this code to improve...", domain: "coding", scoringCriteria: "Readability, performance, correctness preserved", tags: ["code", "refactor"] },
    ];
    writeFileSync(TEMPLATES_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try { return JSON.parse(readFileSync(TEMPLATES_FILE, "utf-8")); } catch { return []; }
}

function saveTemplates(templates: TaskTemplate[]) {
  ensureDir();
  writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

function getModelStats(runs: BenchmarkRun[]) {
  const stats: Record<string, {
    runs: number; avgDuration: number; avgScore: number; passRate: number;
    totalTokens: number; scores: number[]; domains: Record<string, number>;
  }> = {};

  for (const run of runs) {
    if (!stats[run.model]) {
      stats[run.model] = { runs: 0, avgDuration: 0, avgScore: 0, passRate: 0, totalTokens: 0, scores: [], domains: {} };
    }
    const s = stats[run.model];
    s.runs++;
    s.avgDuration += run.durationMs;
    s.totalTokens += (run.inputTokens || 0) + (run.outputTokens || 0);
    if (run.score !== undefined) s.scores.push(run.score);
    if (run.pass !== undefined) s.passRate += run.pass ? 1 : 0;
    if (run.domain) s.domains[run.domain] = (s.domains[run.domain] || 0) + 1;
  }

  for (const [model, s] of Object.entries(stats)) {
    s.avgDuration = Math.round(s.avgDuration / s.runs);
    s.avgScore = s.scores.length ? +(s.scores.reduce((a, b) => a + b, 0) / s.scores.length).toFixed(1) : 0;
    s.passRate = s.runs ? +(s.passRate / s.runs * 100).toFixed(0) as number : 0;
  }

  return stats;
}

export default function (pi: ExtensionAPI) {
  ensureDir();

  pi.registerCommand("arena", {
    description: "Benchmarking: /arena run|history|compare|stats|leaderboard|export|templates",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const cmd = parts[0] || "stats";

      if (cmd === "run") {
        const task = parts.slice(1).join(" ");
        if (!task) return `${YELLOW}Usage:${RST} /arena run <task description>\nOr use ${CYAN}arena_run${RST} tool for model-specific benchmarks.`;
        return `${CYAN}Use the ${B}arena_run${RST}${CYAN} tool to record a benchmark:${RST}\n` +
          `Provide: task, model, durationMs, score (1-10), pass (true/false)`;
      }

      if (cmd === "history") {
        const limit = parseInt(parts[1]) || 20;
        const runs = loadRuns(limit);
        if (!runs.length) return `${YELLOW}No benchmark runs yet.${RST}`;
        let out = `${B}${CYAN}📊 Last ${runs.length} Benchmark Runs${RST}\n\n`;
        for (const r of runs.slice(-limit)) {
          const score = r.score !== undefined ? (r.score >= 7 ? `${GREEN}${r.score}/10${RST}` : r.score >= 4 ? `${YELLOW}${r.score}/10${RST}` : `${RED}${r.score}/10${RST}`) : "";
          const pass = r.pass !== undefined ? (r.pass ? `${GREEN}PASS${RST}` : `${RED}FAIL${RST}`) : "";
          out += `${D}${(r.startTime || "").slice(0, 16)}${RST} ${MAGENTA}${r.model}${RST} ${score} ${pass} ${D}${r.durationMs}ms${RST}\n`;
          out += `  ${r.task.slice(0, 80)}\n`;
        }
        return out;
      }

      if (cmd === "compare") {
        const modelA = parts[1], modelB = parts[2];
        if (!modelA || !modelB) return `${YELLOW}Usage:${RST} /arena compare <modelA> <modelB>`;
        const runs = loadRuns();
        const runsA = runs.filter(r => r.model.includes(modelA));
        const runsB = runs.filter(r => r.model.includes(modelB));
        
        const avgScore = (arr: BenchmarkRun[]) => arr.filter(r => r.score).length ?
          +(arr.filter(r => r.score).reduce((s, r) => s + (r.score || 0), 0) / arr.filter(r => r.score).length).toFixed(1) : 0;
        const avgTime = (arr: BenchmarkRun[]) => arr.length ?
          Math.round(arr.reduce((s, r) => s + r.durationMs, 0) / arr.length) : 0;
        
        let out = `${B}${CYAN}⚔️ ${modelA} vs ${modelB}${RST}\n\n`;
        out += `             ${B}${modelA.padEnd(20)}${modelB}${RST}\n`;
        out += `  Runs:      ${String(runsA.length).padEnd(20)}${runsB.length}\n`;
        out += `  Avg Score: ${String(avgScore(runsA)).padEnd(20)}${avgScore(runsB)}\n`;
        out += `  Avg Time:  ${String(avgTime(runsA) + "ms").padEnd(20)}${avgTime(runsB)}ms\n`;
        return out;
      }

      if (cmd === "baselines") {
        const baselines = loadBaselines();
        const entries = Object.entries(baselines).sort((a, b) => a[1].hallucinationRate - b[1].hallucinationRate);
        if (!entries.length) return `${YELLOW}No baselines loaded. Add vectara-baselines.json to ~/.pi/arena/${RST}`;
        let out = `${B}${CYAN}📊 Vectara Hallucination Baselines${RST} ${D}(HHEM-2.3, 7700+ articles, March 2026)${RST}\n\n`;
        out += `  ${"Model".padEnd(45)} ${"Halluc%".padStart(8)} ${"Factual%".padStart(9)} ${"Answer%".padStart(8)}\n`;
        out += `  ${"─".repeat(72)}\n`;
        for (const [model, data] of entries) {
          const color = data.hallucinationRate < 6 ? GREEN : data.hallucinationRate < 12 ? YELLOW : RED;
          out += `  ${model.padEnd(45)} ${color}${String(data.hallucinationRate + "%").padStart(8)}${RST} ${String(data.factualConsistency + "%").padStart(9)} ${String(data.answerRate + "%").padStart(8)}\n`;
        }
        out += `\n${D}Insight: Reasoning models (o3-pro: 23.3%, o4-mini: 18.6%) hallucinate most.${RST}`;
        out += `\n${D}Smaller models often more factual (Gemini 2.5 Flash Lite: 3.3% vs Flash: 7.8%).${RST}`;
        return out;
      }

      if (cmd === "leaderboard") {
        const runs = loadRuns();
        const stats = getModelStats(runs);
        if (!Object.keys(stats).length) return `${YELLOW}No data yet. Run some benchmarks first.${RST}`;
        
        const sorted = Object.entries(stats).sort((a, b) => b[1].avgScore - a[1].avgScore);
        let out = `${B}${CYAN}🏟️ Model Leaderboard${RST}\n\n`;
        out += `  ${"Rank".padEnd(5)} ${"Model".padEnd(25)} ${"Score".padEnd(8)} ${"Pass%".padEnd(8)} ${"Avg ms".padEnd(10)} Runs\n`;
        out += `  ${"-".repeat(65)}\n`;
        
        for (let i = 0; i < sorted.length; i++) {
          const [model, s] = sorted[i];
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
          out += `  ${medal.padEnd(5)} ${model.padEnd(25)} ${String(s.avgScore).padEnd(8)} ${String(s.passRate + "%").padEnd(8)} ${String(s.avgDuration).padEnd(10)} ${s.runs}\n`;
        }
        return out;
      }

      if (cmd === "templates") {
        const templates = loadTemplates();
        let out = `${B}${CYAN}📝 Task Templates${RST}\n\n`;
        for (const t of templates) {
          out += `  ${B}${t.name}${RST} ${D}[${t.domain || "general"}]${RST}\n`;
          out += `    ${t.prompt.slice(0, 60)}...\n`;
          out += `    ${D}Scoring: ${t.scoringCriteria || "n/a"}${RST}\n\n`;
        }
        return out;
      }

      if (cmd === "export") {
        const runs = loadRuns();
        const templates = loadTemplates();
        const stats = getModelStats(runs);
        const exportPath = join(ARENA_DIR, `arena-export-${new Date().toISOString().slice(0, 10)}.json`);
        writeFileSync(exportPath, JSON.stringify({ runs, templates, modelStats: stats, exported: new Date().toISOString() }, null, 2));
        return `${GREEN}✅ Exported${RST} ${runs.length} runs → ${exportPath}`;
      }

      // Default: stats
      const runs = loadRuns();
      const stats = getModelStats(runs);
      let out = `${B}${CYAN}🏟️ Arena Stats${RST}\n\n`;
      out += `  Total runs: ${GREEN}${runs.length}${RST}\n`;
      out += `  Models tested: ${GREEN}${Object.keys(stats).length}${RST}\n`;
      out += `  Storage: ${D}${ARENA_DIR}${RST}\n`;
      
      if (Object.keys(stats).length) {
        out += `\n  ${B}Per Model:${RST}\n`;
        for (const [model, s] of Object.entries(stats).sort((a, b) => b[1].avgScore - a[1].avgScore)) {
          out += `    ${MAGENTA}${model}${RST}: ${s.runs} runs, score ${s.avgScore}/10, ${s.avgDuration}ms avg\n`;
        }
      }
      
      // Domain distribution
      const byDomain: Record<string, number> = {};
      for (const r of runs) if (r.domain) byDomain[r.domain] = (byDomain[r.domain] || 0) + 1;
      if (Object.keys(byDomain).length) {
        out += `\n  ${B}By Domain:${RST}\n`;
        for (const [d, c] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) {
          out += `    ${d}: ${c}\n`;
        }
      }
      return out;
    }
  });

  pi.registerTool({
    name: "arena_run",
    description: "Record a benchmark run. Track model performance on a specific task with timing, quality score, and pass/fail.",
    parameters: Type.Object({
      task: Type.String({ description: "What was benchmarked (description of the task)" }),
      model: Type.String({ description: "Model used (e.g., claude-sonnet-4, gpt-4o, gemini-2.5-pro)" }),
      durationMs: Type.Number({ description: "How long it took in milliseconds" }),
      score: Type.Optional(Type.Number({ description: "Quality score 1-10" })),
      pass: Type.Optional(Type.Boolean({ description: "Did it pass/succeed?" })),
      inputTokens: Type.Optional(Type.Number({ description: "Input tokens used" })),
      outputTokens: Type.Optional(Type.Number({ description: "Output tokens generated" })),
      domain: Type.Optional(Type.String({ description: "Domain: coding, reasoning, general-knowledge, legal, medical, financial" })),
      notes: Type.Optional(Type.String({ description: "Additional notes" })),
      threadType: Type.Optional(Type.String({ description: "Thread type: Base, P-Thread, C-Thread, F-Thread, B-Thread, L-Thread, Z-Thread" })),
    }),
    execute: async (params) => {
      const run: BenchmarkRun = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        task: params.task,
        model: params.model,
        startTime: new Date(Date.now() - params.durationMs).toISOString(),
        endTime: new Date().toISOString(),
        durationMs: params.durationMs,
        score: params.score,
        pass: params.pass,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        domain: params.domain,
        notes: params.notes,
        threadType: params.threadType,
      };
      appendRun(run);
      
      let result = `Recorded: ${params.model} on "${params.task.slice(0, 50)}" — ${params.durationMs}ms`;
      if (params.score !== undefined) result += `, score: ${params.score}/10`;
      if (params.pass !== undefined) result += `, ${params.pass ? "PASS" : "FAIL"}`;
      
      // Vectara baseline comparison
      const baselines = loadBaselines();
      const baseline = findBaseline(params.model, baselines);
      if (baseline) {
        result += `\n📊 Vectara baseline for ${baseline.key}: ${baseline.data.hallucinationRate}% hallucination rate`;
        if (params.score !== undefined && params.score < 5 && baseline.data.hallucinationRate > 10) {
          result += ` ⚠️ Model has high hallucination rate — consider using a more factual model`;
        }
      }
      
      return result;
    }
  });

  pi.registerTool({
    name: "arena_history",
    description: "Query benchmark history. Filter by model, domain, or date range.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max runs to return (default 20)" })),
      model: Type.Optional(Type.String({ description: "Filter by model name (partial match)" })),
      domain: Type.Optional(Type.String({ description: "Filter by domain" })),
    }),
    execute: async (params) => {
      let runs = loadRuns(params.limit || 100);
      if (params.model) runs = runs.filter(r => r.model.toLowerCase().includes(params.model!.toLowerCase()));
      if (params.domain) runs = runs.filter(r => r.domain === params.domain);
      runs = runs.slice(-(params.limit || 20));
      return JSON.stringify(runs, null, 2);
    }
  });

  pi.registerTool({
    name: "arena_compare",
    description: "Compare two models side-by-side based on benchmark history. Shows average score, speed, pass rate.",
    parameters: Type.Object({
      modelA: Type.String({ description: "First model name (partial match)" }),
      modelB: Type.String({ description: "Second model name (partial match)" }),
    }),
    execute: async (params) => {
      const runs = loadRuns();
      const runsA = runs.filter(r => r.model.toLowerCase().includes(params.modelA.toLowerCase()));
      const runsB = runs.filter(r => r.model.toLowerCase().includes(params.modelB.toLowerCase()));
      
      const summarize = (arr: BenchmarkRun[]) => ({
        runs: arr.length,
        avgScore: arr.filter(r => r.score).length ?
          +(arr.filter(r => r.score).reduce((s, r) => s + (r.score || 0), 0) / arr.filter(r => r.score).length).toFixed(1) : null,
        avgDurationMs: arr.length ? Math.round(arr.reduce((s, r) => s + r.durationMs, 0) / arr.length) : null,
        passRate: arr.filter(r => r.pass !== undefined).length ?
          +(arr.filter(r => r.pass).length / arr.filter(r => r.pass !== undefined).length * 100).toFixed(0) + "%" : null,
      });
      
      // Add Vectara baselines
      const baselines = loadBaselines();
      const baseA = findBaseline(params.modelA, baselines);
      const baseB = findBaseline(params.modelB, baselines);
      
      const result: any = {
        [params.modelA]: { ...summarize(runsA), vectaraHallucinationRate: baseA?.data.hallucinationRate ?? null },
        [params.modelB]: { ...summarize(runsB), vectaraHallucinationRate: baseB?.data.hallucinationRate ?? null },
      };
      
      // Verbosity penalty insight
      const avgLenA = runsA.filter(r => r.outputTokens).reduce((s, r) => s + (r.outputTokens || 0), 0) / (runsA.filter(r => r.outputTokens).length || 1);
      const avgLenB = runsB.filter(r => r.outputTokens).reduce((s, r) => s + (r.outputTokens || 0), 0) / (runsB.filter(r => r.outputTokens).length || 1);
      if (avgLenA > 0 && avgLenB > 0) {
        result.verbosityInsight = avgLenA > avgLenB * 1.5
          ? `${params.modelA} is ${(avgLenA / avgLenB).toFixed(1)}x more verbose — Vectara data shows verbosity correlates with higher hallucination`
          : avgLenB > avgLenA * 1.5
          ? `${params.modelB} is ${(avgLenB / avgLenA).toFixed(1)}x more verbose — Vectara data shows verbosity correlates with higher hallucination`
          : "Similar verbosity levels";
      }
      
      return JSON.stringify(result, null, 2);
    }
  });
}
