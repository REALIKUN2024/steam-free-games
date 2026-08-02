import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Steam 免费内容数据构建脚本（快速管线 · 断点续跑版）
 * 直接解析 Steam 搜索页 HTML（category1=998 游戏 / category1=10 试玩）。
 * - 分页进度落盘 data/cache/{feed}.pages.json，重跑自动跳过已完成页
 * - 429 限流自适应退避，日志实时输出，可随时中断后续跑
 * 产出：public/data/games.json / demos.json / meta.json
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "public", "data");
const CACHE_DIR = path.join(ROOT, "data", "cache");
const PAGE_SIZE = 100;
const BACKOFF_MS = [6000, 15000, 30000];
const COOLDOWN_MS = 90000;

const BASE = "https://store.steampowered.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

let TAG_MAP = {};

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

function parseRows(html, kind) {
  const rows = [];
  const parts = html.split('data-ds-appid="');
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i];
    const id = c.match(/^(\d+)/)?.[1];
    if (!id) continue;
    if (!/discount_final_price\s+free|>免费</.test(c)) continue;
    const name = decodeHtml(c.match(/<span class="title">([\s\S]*?)<\/span>/)?.[1]?.trim() || "");
    const image = c.match(/<img src="([^"]+)"\s*>/)?.[1] || "";
    const release = c.match(/class="search_released[^"]*">([\s\S]*?)<\/div>/)?.[1]?.trim() || "";
    const tooltip = c.match(/data-tooltip-html="([\s\S]*?)"/)?.[1] || "";
    const pct = tooltip.match(/(\d+(?:\.\d+)?)%/)?.[1];
    const tagRaw = c.match(/data-ds-tagids="\[([\d,\s]*)\]"/)?.[1] || "";
    const tagids = tagRaw.split(",").map((s) => s.trim()).filter(Boolean);
    rows.push({
      id: Number(id),
      name,
      image,
      release,
      rating: pct ? Number(pct) : null,
      win: /platform_img win/.test(c),
      mac: /platform_img mac/.test(c),
      linux: /platform_img linux/.test(c),
      kind,
      tagids,
    });
  }
  return rows;
}

// 从搜索页侧边栏提取「标签 id -> 中文名」映射（一次请求）
async function buildTagMap() {
  const map = {};
  try {
    const res = await fetchJson(`${BASE}/search/?category1=998&maxprice=free&cc=CN&l=schinese`);
    const html = await res.text();
    const re = /data-param="tags" data-value="(\d+)" data-loc="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      map[m[1]] = decodeHtml(m[2]);
    }
    log(`标签映射：${Object.keys(map).length} 个`);
  } catch (e) {
    log(`标签映射获取失败：${e.message}`);
  }
  return map;
}

function attachGenres(items, tagMap) {
  for (const g of items) {
    const names = (g.tagids || []).map((id) => tagMap[String(id)]).filter(Boolean);
    g.genres = [...new Set(names)].slice(0, 4);
    delete g.tagids;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
  });
  return res;
}

async function crawlFeed({ label, category, outFile, skipIfExists }) {
  const startedAt = Date.now();
  const map = new Map();
  const pagesFile = path.join(CACHE_DIR, `${label}.pages.json`);
  const rowsFile = path.join(CACHE_DIR, `${label}.rows.jsonl`);
  const curated = process.env.CURATED === "1";
  const sortBy = curated ? "&sort_by=Reviews_DESC" : "";

  const donePages = new Set(existsSync(pagesFile) ? JSON.parse(readFileSync(pagesFile, "utf8")) : []);
  if (existsSync(rowsFile)) {
    for (const line of readFileSync(rowsFile, "utf8").split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        map.set(r.id, r);
      } catch { /* skip */ }
    }
  }

  if (skipIfExists && existsSync(path.join(DATA_DIR, outFile)) && map.size > 0) {
    log(`[${label}] 已有数据 ${map.size} 条且文件存在，跳过（SKIP=1 时）`);
  }

  const firstRes = await fetchJson(
    `${BASE}/search/results/?query=&start=0&count=${PAGE_SIZE}&category1=${category}&maxprice=free${sortBy}&cc=CN&l=schinese&infinite=1`
  );
  if (!firstRes.ok) throw new Error(`首次请求 HTTP ${firstRes.status}`);
  const first = await firstRes.json();
  const total = Number(/"total_count":(\d+)/.exec(JSON.stringify(first))?.[1]) || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  log(`[${label}] 目标 ${total} 条 / ${pages} 页，已完成 ${donePages.size} 页（${map.size} 条）`);

  function savePage(pageIdx, rows) {
    donePages.add(pageIdx);
    writeFileSync(pagesFile, JSON.stringify([...donePages]), "utf8");
    const lines = rows.map((r) => JSON.stringify(r)).join("\n");
    appendFileSync(rowsFile, (lines ? lines + "\n" : ""), "utf8");
    for (const r of rows) map.set(r.id, r);
  }

  // 首页单独处理（已在上面请求过）
  const firstRows = parseRows(first.results_html || "", label);
  if (!donePages.has(0)) savePage(0, firstRows);

  for (let p = 1; p < pages; p++) {
    if (donePages.has(p)) continue;
    const start = p * PAGE_SIZE;
    const url = `${BASE}/search/results/?query=&start=${start}&count=${PAGE_SIZE}&category1=${category}&maxprice=free${sortBy}&cc=CN&l=schinese&infinite=1`;
    let rows = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchJson(url);
        if (res.status === 429) throw Object.assign(new Error("429"), { code: 429 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        rows = parseRows(j.results_html || "", label);
        break;
      } catch (e) {
        if (e.code === 429) {
          log(`[${label}] 页 ${p + 1}/${pages} 被限流(429)，第 ${attempt + 1} 次，等待 ${BACKOFF_MS[attempt]}ms`);
          await sleep(BACKOFF_MS[attempt]);
        } else {
          log(`[${label}] 页 ${p + 1}/${pages} 请求异常：${e.message}`);
          await sleep(3000);
        }
      }
    }
    if (rows === null) {
      log(`[${label}] 页 ${p + 1}/${pages} 连续限流，进入冷却 ${COOLDOWN_MS / 1000}s`);
      await sleep(COOLDOWN_MS);
      continue;
    }
    savePage(p, rows);
    log(`[${label}] 页 ${p + 1}/${pages} 完成，累计 ${map.size}`);
    await sleep(1400);
  }

  const items = [...map.values()].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  attachGenres(items, TAG_MAP);
  const payload = { updatedAt: new Date().toISOString(), source: "steam", count: items.length, games: items };
  writeFileSync(path.join(DATA_DIR, outFile), JSON.stringify(payload), "utf8");
  log(`[${label}] 完成：${items.length} 条，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s -> ${outFile}`);
  return items.length;
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  TAG_MAP = await buildTagMap();
  const skipGames = process.env.SKIP_GAMES === "1";
  const skipDemos = process.env.SKIP_DEMOS === "1";

  const counts = {};
  if (!skipGames) counts.games = await crawlFeed({ label: "game", category: "998", outFile: "games.json" });
  if (!skipDemos) counts.demos = await crawlFeed({ label: "demo", category: "10", outFile: "demos.json" });
  const meta = { updatedAt: new Date().toISOString(), source: "steam", games: counts.games ?? 0, demos: counts.demos ?? 0 };
  writeFileSync(path.join(DATA_DIR, "meta.json"), JSON.stringify(meta), "utf8");
  log(`meta.json：${JSON.stringify(meta)}`);
  log("全部完成");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
