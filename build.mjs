#!/usr/bin/env node
/**
 * The Daily Edition - build script.
 *
 * Fetches every feed in feeds.json, parses RSS and Atom without any external
 * dependency, clusters the same story across outlets, scores and ranks what
 * survives, applies per-section quotas, and writes edition.json.
 *
 * Deliberately dependency-free: nothing to npm-audit, nothing to break on a
 * transitive update, and the whole thing is readable in one sitting.
 *
 * Usage:
 *   node build.mjs                 normal build
 *   node build.mjs --offline DIR   build from XML files in DIR instead of the network (testing)
 *   node build.mjs --dry           build but print to stdout instead of writing
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const OFFLINE_DIR = args.includes('--offline') ? args[args.indexOf('--offline') + 1] : null;
const DRY = args.includes('--dry');

const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'DailyEdition/1.0 (personal news aggregator; +https://github.com/)';

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

/** Strip CDATA wrappers and decode the handful of entities that matter. */
function decode(s) {
  if (!s) return '';
  let out = String(s);
  out = out.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  out = out.replace(/<[^>]+>/g, ' ');
  out = out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
  return out.replace(/\s+/g, ' ').trim();
}

/** Pull the first occurrence of <tag>...</tag>, namespace-tolerant. */
function pick(xml, ...tags) {
  for (const tag of tags) {
    const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<(?:[\\w-]+:)?${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${esc}>`, 'i');
    const m = xml.match(re);
    if (m && m[1] != null && decode(m[1])) return m[1];
  }
  return '';
}

/** Atom links are attributes, not element text. */
function pickLink(xml) {
  const rss = pick(xml, 'link');
  const rssDecoded = decode(rss);
  if (rssDecoded && /^https?:\/\//i.test(rssDecoded)) return rssDecoded;

  const alt = xml.match(/<(?:[\w-]+:)?link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)
    || xml.match(/<(?:[\w-]+:)?link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i)
    || xml.match(/<(?:[\w-]+:)?link\b[^>]*\bhref=["']([^"']+)["']/i);
  if (alt) return decode(alt[1]);

  const guid = decode(pick(xml, 'guid', 'id'));
  return /^https?:\/\//i.test(guid) ? guid : '';
}

function parseDate(raw) {
  if (!raw) return null;
  const t = Date.parse(decode(raw));
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Split a document into <item> or <entry> blocks and normalise each. */
function parseFeed(xml, feed) {
  const blocks = [
    ...xml.matchAll(/<(?:[\w-]+:)?item\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?item>/gi),
    ...xml.matchAll(/<(?:[\w-]+:)?entry\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?entry>/gi),
  ];

  const items = [];
  for (const [, block] of blocks) {
    const title = decode(pick(block, 'title'));
    const link = pickLink(block);
    if (!title || !link) continue;

    const summaryRaw = pick(block, 'description', 'summary', 'encoded', 'content');
    const summary = decode(summaryRaw).slice(0, 400);
    const published =
      parseDate(pick(block, 'pubDate', 'published', 'updated', 'date', 'created')) || null;

    items.push({
      title,
      link: link.split('#')[0],
      summary,
      published: published ? published.toISOString() : null,
      publishedMs: published ? published.getTime() : null,
      feedId: feed.id,
      source: feed.name,
      section: feed.section,
      sourceWeight: feed.weight ?? 1,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchFeed(feed) {
  if (OFFLINE_DIR) {
    const file = path.join(OFFLINE_DIR, `${feed.id}.xml`);
    if (!existsSync(file)) return { ok: false, error: 'no fixture' };
    return { ok: true, xml: await readFile(file, 'utf8') };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const xml = await res.text();
    if (!/<(?:[\w-]+:)?(item|entry)\b/i.test(xml)) return { ok: false, error: 'no items in response' };
    return { ok: true, xml };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  ('a an the and or but of to in on at for with from by as is are was were be been being it its this that ' +
   'these those he she they them his her their we you i not no says said say new after before over under ' +
   'about into more most than then there here what which who whom how why when where all any some such own ' +
   'so up out if can will just should now').split(' ')
);

function tokenise(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

/**
 * Two different outlets rewrite the same headline rather than copying it, so
 * a single similarity measure misses obvious matches. Jaccard punishes length
 * differences; the overlap coefficient does not but is loose on short strings.
 * Requiring a floor of shared tokens and then accepting either measure catches
 * genuine rewrites without collapsing unrelated stories.
 */
const MIN_SHARED_TOKENS = 4;
const JACCARD_THRESHOLD = 0.34;
const OVERLAP_THRESHOLD = 0.5;

function similarity(a, b) {
  if (!a.size || !b.size) return { shared: 0, jaccard: 0, overlap: 0 };
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return {
    shared,
    jaccard: shared / (a.size + b.size - shared),
    overlap: shared / Math.min(a.size, b.size),
  };
}

function isSameStory(a, b) {
  const s = similarity(a, b);
  if (s.shared < MIN_SHARED_TOKENS) return false;
  return s.jaccard >= JACCARD_THRESHOLD || s.overlap >= OVERLAP_THRESHOLD;
}

/**
 * Greedy clustering, comparing each item against every member of a candidate
 * cluster rather than only its head, so a chain of rewrites still merges.
 * Two items from the same outlet never corroborate each other: one BBC story
 * is one source, however many times they file it.
 */
function cluster(items) {
  const clusters = [];
  let sameOutletDuplicates = 0;

  for (const item of items) {
    const tokens = tokenise(`${item.title} ${item.summary.slice(0, 160)}`);
    let placed = false;

    for (const c of clusters) {
      if (c.section !== item.section) continue;
      if (!c.tokenSets.some((t) => isSameStory(tokens, t))) continue;

      if (c.items.some((i) => i.feedId === item.feedId)) {
        sameOutletDuplicates++;
      } else {
        c.items.push(item);
        c.tokenSets.push(tokens);
      }
      placed = true;
      break;
    }

    if (!placed) clusters.push({ section: item.section, tokenSets: [tokens], items: [item] });
  }

  return { clusters, sameOutletDuplicates };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function keywordScore(text, rules, feedIds) {
  const hay = text.toLowerCase();
  let total = 0;
  const hits = [];
  for (const rule of rules || []) {
    // A rule can exempt outlets that use a phrase innocently. Carbon Brief
    // prefixes its data explainers with "Analysis:", which is the opposite of
    // the comment-page filler the demote rule is aimed at.
    if (rule.exceptFeeds?.length && feedIds.every((id) => rule.exceptFeeds.includes(id))) continue;
    for (const term of rule.terms) {
      if (hay.includes(term)) {
        total += rule.weight;
        hits.push(term);
        break; // one hit per rule group, not per synonym
      }
    }
  }
  return { total, hits };
}

/**
 * A block is not a heavy demote. Demoted items still occupy the pool and can
 * surface on a quiet day; blocked items never enter it. Use blocks for subjects
 * you never want to see, and the 'unless' list to let the genuinely serious
 * version of that subject through.
 */
function blockedBy(item, rules) {
  const hay = `${item.title} ${item.summary}`.toLowerCase();
  for (const rule of rules || []) {
    if (!rule.terms.some((t) => hay.includes(t))) continue;
    if (rule.unless?.some((t) => hay.includes(t))) continue; // reprieved
    return rule.terms.find((t) => hay.includes(t));
  }
  return null;
}

function scoreCluster(c, config, nowMs) {
  const w = config.weights;
  const lead = c.items[0];
  const text = c.items.map((i) => `${i.title} ${i.summary}`).join(' ');

  const outlets = new Set(c.items.map((i) => i.feedId)).size;
  const corroboration = Math.log2(outlets + 1) * w.corroboration;

  const bestSourceWeight = Math.max(...c.items.map((i) => i.sourceWeight)) * w.sourceWeight;

  const newestMs = Math.max(...c.items.map((i) => i.publishedMs ?? 0));
  const ageHours = newestMs ? (nowMs - newestMs) / 3.6e6 : 48;
  const recency = w.recencyMax * Math.pow(0.5, Math.max(0, ageHours) / w.recencyHalfLifeHours);

  const feedIds = c.items.map((i) => i.feedId);
  const up = keywordScore(text, config.promote, feedIds);
  const down = keywordScore(text, config.demote, feedIds);

  const score = corroboration + bestSourceWeight + recency + up.total - down.total;

  return {
    score,
    outlets,
    ageHours,
    reasons: {
      corroboration: round(corroboration),
      source: round(bestSourceWeight),
      recency: round(recency),
      promoted: up.hits,
      demoted: down.hits,
    },
    lead,
  };
}

const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function romeDateString(d, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

async function main() {
  const config = JSON.parse(await readFile(path.join(ROOT, 'feeds.json'), 'utf8'));
  // --now lets the fixtures keep fixed dates and still fall inside the freshness
  // window whenever you run the offline test, however long from now that is.
  const nowArg = args.includes('--now') ? args[args.indexOf('--now') + 1] : null;
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now: not a date: ${nowArg}`);
  const nowMs = now.getTime();
  const tz = config.edition.timezone || 'Europe/Rome';

  // Skip if an edition was already built today in the edition's own timezone.
  // This lets the workflow run twice (once for each DST offset) without
  // producing two editions.
  const editionPath = path.join(ROOT, 'edition.json');
  const today = romeDateString(now, tz);
  if (!DRY && !OFFLINE_DIR && !args.includes('--force') && existsSync(editionPath)) {
    try {
      const prev = JSON.parse(await readFile(editionPath, 'utf8'));
      if (prev.editionDate === today) {
        console.log(`Edition for ${today} already built. Nothing to do. (Use --force to rebuild.)`);
        return;
      }
    } catch { /* corrupt or absent previous edition: rebuild */ }
  }

  console.log(`Building edition for ${today} (${tz})`);

  const results = await Promise.all(
    config.feeds.map(async (feed) => {
      const res = await fetchFeed(feed);
      if (!res.ok) {
        console.warn(`  FAIL  ${feed.name.padEnd(18)} ${res.error}`);
        return { feed, ok: false, error: res.error, items: [] };
      }
      let items = parseFeed(res.xml, feed);

      if (feed.urlMustContain?.length) {
        const before = items.length;
        const kept = items.filter((i) => feed.urlMustContain.some((frag) => i.link.includes(frag)));
        if (feed.spillover) {
          const rest = items
            .filter((i) => !feed.urlMustContain.some((frag) => i.link.includes(frag)))
            .map((i) => ({ ...i, section: feed.spillover.section }));
          items = [...kept, ...rest];
        } else {
          items = kept;
        }
        console.log(`  ok    ${feed.name.padEnd(18)} ${items.length} items (${before} before URL filter)`);
      } else {
        console.log(`  ok    ${feed.name.padEnd(18)} ${items.length} items`);
      }
      return { feed, ok: true, items };
    })
  );

  const maxAgeMs = (config.edition.maxAgeHours ?? 36) * 3.6e6;
  const blocked = [];
  const all = results
    .flatMap((r) => r.items)
    .filter((i) => !i.publishedMs || nowMs - i.publishedMs <= maxAgeMs)
    .filter((i) => {
      const term = blockedBy(i, config.block);
      if (term) { blocked.push({ title: i.title, source: i.source, term }); return false; }
      return true;
    })
    .sort((a, b) => (b.publishedMs ?? 0) - (a.publishedMs ?? 0));

  if (blocked.length) {
    console.log(`Blocked ${blocked.length}:`);
    for (const b of blocked) console.log(`  [${b.term}] ${b.source}: ${b.title.slice(0, 70)}`);
  }

  const { clusters: rawClusters, sameOutletDuplicates } = cluster(all);
  const clusters = rawClusters.map((c) => {
    const s = scoreCluster(c, config, nowMs);
    return {
      title: s.lead.title,
      link: s.lead.link,
      summary: s.lead.summary,
      published: s.lead.published,
      section: c.section,
      score: round(s.score),
      outlets: s.outlets,
      reasons: s.reasons,
      sources: c.items.map((i) => ({ name: i.source, link: i.link, title: i.title })),
    };
  });

  const sections = config.sections.map((sec) => {
    const pool = clusters
      .filter((c) => c.section === sec.id)
      .sort((a, b) => b.score - a.score);
    return {
      id: sec.id,
      name: sec.name,
      total: pool.length,
      items: pool.slice(0, sec.quota),
      dropped: Math.max(0, pool.length - sec.quota),
    };
  });

  const edition = {
    title: config.edition.title,
    editionDate: today,
    builtAt: now.toISOString(),
    timezone: tz,
    longformShelfSize: config.edition.longformShelfSize ?? 3,
    stats: {
      feedsConfigured: config.feeds.length,
      feedsOk: results.filter((r) => r.ok).length,
      itemsFetched: results.reduce((n, r) => n + r.items.length, 0),
      itemsInWindow: all.length,
      blocked: blocked.length,
      clusters: clusters.length,
      merged: all.length - clusters.length - sameOutletDuplicates,
      sameOutletDuplicates,
      shown: sections.reduce((n, s) => n + s.items.length, 0),
    },
    failures: results.filter((r) => !r.ok).map((r) => ({ name: r.feed.name, id: r.feed.id, error: r.error })),
    sections,
  };

  const summary = `${edition.stats.itemsFetched} fetched, ${edition.stats.clusters} clusters, ${edition.stats.shown} shown, ${edition.failures.length} feeds down`;
  console.log(summary);

  if (DRY) {
    console.log(JSON.stringify(edition, null, 2).slice(0, 4000));
    return;
  }
  await writeFile(editionPath, JSON.stringify(edition, null, 2));
  console.log(`Wrote ${editionPath}`);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
