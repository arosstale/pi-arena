// Fetch ALL Bench Leaderboard v2.1 from HuggingFace and update pi-arena allbench-scores.json
const https = require('https');
const fs = require('fs');
const path = require('path');

const ALLBENCH_PATH = path.join(require('os').homedir(), '.pi/arena/allbench-scores.json');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'pi-arena/1.3.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redir = res.headers.location.startsWith('http') ? res.headers.location : 'https://huggingface.co' + res.headers.location;
        return fetchJSON(redir).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// 5-axis mapping from ALL Bench raw fields
// Knowledge: mmluPro, mmmlu
// Expert Reasoning: gpqa, aime
// Abstract Reasoning: arcAgi2, hle
// Metacognition: metacog (FINAL Bench)
// Execution: sweV, swePro, lcb, ifeval, bfcl
function computeAxis(entry, axis) {
  const benchmarks = {
    knowledge: [{ key: 'mmluPro', weight: 0.5 }, { key: 'mmmlu', weight: 0.5 }],
    expert_reasoning: [{ key: 'gpqa', weight: 0.5 }, { key: 'aime', weight: 0.5 }],
    abstract_reasoning: [{ key: 'arcAgi2', weight: 0.5 }, { key: 'hle', weight: 0.5 }],
    metacognition: [{ key: 'metacog', weight: 1.0 }],
    execution: [{ key: 'sweV', weight: 0.25 }, { key: 'swePro', weight: 0.25 }, { key: 'lcb', weight: 0.25 }, { key: 'ifeval', weight: 0.25 }]
  };

  const items = benchmarks[axis];
  let sum = 0, totalWeight = 0;
  for (const { key, weight } of items) {
    if (entry[key] != null && entry[key] !== '') {
      sum += entry[key] * weight;
      totalWeight += weight;
    }
  }
  return totalWeight > 0 ? Math.round((sum / totalWeight) * 10) / 10 : null;
}

const AXES = ['knowledge', 'expert_reasoning', 'abstract_reasoning', 'metacognition', 'execution'];

function buildScores(entry) {
  const scores = {};
  let count = 0;
  for (const axis of AXES) {
    const val = computeAxis(entry, axis);
    if (val != null) {
      scores[axis] = val;
      count++;
    }
  }
  
  // Compute composite: Avg(axes) * sqrt(N/5)
  const vals = Object.values(scores);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const penalty = Math.sqrt(count / 5);
  const composite = Math.round(avg * penalty * 10) / 10;
  const coverage = Math.round((count / 5) * 100);

  return { scores, composite, coverage };
}

async function main() {
  console.log('Fetching ALL Bench Leaderboard v2.1 from HuggingFace...');
  const data = await fetchJSON('https://huggingface.co/datasets/FINAL-Bench/ALL-Bench-Leaderboard/resolve/main/all_bench_leaderboard_v2.1.json');

  console.log('LLM models:', data.llm?.length);
  
  const result = {};
  let updated = 0, added = 0;

  // Load existing
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(ALLBENCH_PATH, 'utf8')); } catch (e) {}
  
  for (const entry of data.llm || []) {
    const { scores, composite, coverage } = buildScores(entry);
    if (Object.keys(scores).length === 0) continue;
    
    const name = entry.name;
    const confidence = {};
    // Mark confidence based on available data
    if (entry.gpqa != null) confidence.gpqa = 'cross-verified';
    if (entry.aime != null) confidence.aime = 'cross-verified';
    if (entry.hle != null) confidence.hle = 'cross-verified';
    if (entry.arcAgi2 != null) confidence.arcAgi2 = 'cross-verified';
    if (entry.sweV != null) confidence.sweV = 'cross-verified';
    if (entry.mmluPro != null) confidence.mmluPro = 'single-source';
    if (entry.swePro != null) confidence.swePro = 'single-source';
    if (entry.ifeval != null) confidence.ifeval = 'single-source';
    if (entry.lcb != null) confidence.lcb = 'single-source';
    if (entry.mmmlu != null) confidence.mmmlu = 'single-source';

    const record = {
      scores,
      confidence,
      _type: entry.type || 'unknown',
      _provider: entry.provider || 'unknown',
      _priceIn: entry.priceIn,
      _priceOut: entry.priceOut,
      _group: entry.group,
      _elo: entry.elo,
      composite,
      coverage,
      _raw: {
        mmluPro: entry.mmluPro,
        gpqa: entry.gpqa,
        aime: entry.aime,
        hle: entry.hle,
        arcAgi2: entry.arcAgi2,
        metacog: entry.metacog,
        sweV: entry.sweV,
        swePro: entry.swePro,
        ifeval: entry.ifeval,
        lcb: entry.lcb,
        bfcl: entry.bfcl,
        mmmlu: entry.mmmlu
      }
    };
    
    // Preserve existing notes
    if (existing[name]?._note) record._note = existing[name]._note;
    
    if (existing[name]) {
      updated++;
    } else {
      added++;
    }
    result[name] = record;
  }

  // Sort by composite descending
  const sorted = Object.fromEntries(
    Object.entries(result).sort((a, b) => (b[1].composite || 0) - (a[1].composite || 0))
  );

  fs.writeFileSync(ALLBENCH_PATH, JSON.stringify(sorted, null, 2));
  console.log(`Done! ${Object.keys(sorted).length} models total (${added} new, ${updated} updated)`);
  
  // Show top 10
  console.log('\nTop 10 by composite:');
  Object.entries(sorted).slice(0, 10).forEach(([name, d], i) => {
    console.log(`  ${i + 1}. ${name.padEnd(25)} composite: ${String(d.composite).padEnd(6)} coverage: ${d.coverage}%`);
  });
  
  // Show confidence summary
  const confidenceData = data.confidence;
  if (confidenceData) {
    console.log('\nConfidence metadata:', JSON.stringify(confidenceData).slice(0, 200));
  }
}

main().catch(e => console.error('Error:', e.message));
