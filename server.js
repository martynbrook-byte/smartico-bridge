/**
 * server.js — Smartico Data Bridge
 *
 * Ingests winners CSVs from Smartico, stores each import as a dataset record,
 * applies named rule sets, and serves a dashboard UI for managing it all.
 *
 * Env vars:
 *   PORT      — HTTP port (default 3001)
 *   DATA_DIR  — Directory for persisted data (default ./data)
 *
 * Endpoints:
 *   POST   /upload                         — multipart CSV upload; creates a dataset
 *   GET    /api/datasets                   — list all dataset records (metadata)
 *   GET    /api/datasets/:id               — fetch a single dataset with rows
 *   PATCH  /api/datasets/:id               — update a dataset (label only)
 *   DELETE /api/datasets/:id               — remove a dataset
 *   GET    /api/settings                   — read column mappings + rule sets
 *   POST   /api/settings                   — save column mappings + rule sets
 *   POST   /api/rule-sets                  — create a rule set
 *   PATCH  /api/rule-sets/:id              — update a rule set
 *   DELETE /api/rule-sets/:id              — delete a rule set
 *   POST   /api/apply-rules                — evaluate rules against a payload
 *   POST   /api/datasets/:id/apply-rules   — evaluate a rule set against a dataset
 *   GET    /api/health                     — health snapshot for firewatch widget
 */

try { require('dotenv').config(); } catch (_) {}

const express    = require('express');
const multer     = require('multer');
const csvParser  = require('csv-parser');
const fs         = require('fs');
const fsp        = require('fs/promises');
const path       = require('path');
const crypto     = require('crypto');

const app       = express();
const PORT      = process.env.PORT || 3001;
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATASETS_DIR = path.join(DATA_DIR, 'datasets');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// ── Bootstrap folders & files ────────────────────────────────────────────────
for (const dir of [DATA_DIR, DATASETS_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ columnMappings: {}, ruleSets: [] }, null, 2));
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// CORS — allow the Figma plugin UI (runs on Figma's HTTPS origin) to reach
// every API endpoint. The dashboard and any other browser client also benefit.
// We allow all origins here because the plugin can be opened from any Figma
// workspace; tighten this to a specific origin if you need stricter security.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// In active dev we want the browser to always re-fetch the dashboard HTML/JS.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const stamp = Date.now();
      const safe  = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${stamp}-${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const ok = /\.csv$/i.test(file.originalname) || file.mimetype === 'text/csv';
    cb(ok ? null : new Error('Only .csv files are accepted'), ok);
  },
});

// ── Settings shape & migration ───────────────────────────────────────────────
// {
//   columnMappings: { [from]: to },
//   ruleSets: [
//     { id, name, description, rules: [{ id, type, name, config }] }
//   ],
//   profileApi: {
//     // brandMap takes the raw value from a dataset row (e.g. crm_brand_name)
//     // and resolves to an internal brand key used by endpoints/defaultAvatars.
//     brandMap:      { [rawName]: brandKey },
//     endpoints:     { [brandKey]: url },
//     defaultAvatars:{ [brandKey]: url },
//     pidColumn:     'PID',  // column in the dataset that holds the user id
//     batchSize:     1000,    // PIDs per POST
//   }
// }

// Seed values mirror the Google Apps Script in getProfileData.js so a fresh
// install lights up without hand-editing settings.json. The Angola endpoint
// is intentionally the same as Mozambique — the Apps Script has a comment
// flagging that as a placeholder. Edit in the Bridge settings UI.
const DEFAULT_PROFILE_API = {
  brandMap: {
    // What Smartico exports (crm_brand_name)          → internal brand key
    '888-Mozambique':      '888bets Mozambique',
    '888bets Mozambique':  '888bets Mozambique',
    '888-Angola':          '888bets Angola',
    '888bets Angola':      '888bets Angola',
    'BetLion':             'BetLion Zambia',
    'BetLion Zambia':      'BetLion Zambia',
  },
  endpoints: {
    '888bets Mozambique': 'https://888africa.com/888bets-mozambique/wp-json/profiles/v1/profile-names-by-pids',
    '888bets Angola':     'https://888africa.com/888bets-mozambique/wp-json/profiles/v1/profile-names-by-pids',
    'BetLion Zambia':     'https://gamepage.betlion.co.zm/wp-json/betlion-zambia/profile-names-by-pids',
  },
  defaultAvatars: {
    '888bets Mozambique': 'https://blaze.888bets.co.mz/wp-content/uploads/2025/02/Property-1Mystery.png',
    '888bets Angola':     'https://blaze.888bets.co.mz/wp-content/uploads/2025/02/Property-1Mystery.png',
    'BetLion Zambia':     'https://gamepage.betlion.co.zm/wp-content/themes/megamission/images/avatars/avatardefault.webp',
  },
  pidColumn: 'PID',
  batchSize: 1000,
};

function normalizeProfileApi(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const pick = (key, def) =>
    (src[key] && typeof src[key] === 'object' && !Array.isArray(src[key]))
      ? { ...def, ...src[key] }
      : { ...def };
  const bs = Number(src.batchSize);
  return {
    brandMap:       pick('brandMap',       DEFAULT_PROFILE_API.brandMap),
    endpoints:      pick('endpoints',      DEFAULT_PROFILE_API.endpoints),
    defaultAvatars: pick('defaultAvatars', DEFAULT_PROFILE_API.defaultAvatars),
    pidColumn:      typeof src.pidColumn === 'string' && src.pidColumn ? src.pidColumn : DEFAULT_PROFILE_API.pidColumn,
    batchSize:      (Number.isFinite(bs) && bs > 0) ? Math.floor(bs) : DEFAULT_PROFILE_API.batchSize,
  };
}

function normalizeSettings(raw) {
  const columnMappings = (raw && typeof raw.columnMappings === 'object' && raw.columnMappings) || {};
  const profileApi     = normalizeProfileApi(raw && raw.profileApi);

  // 1) If ruleSets already exists, trust it (coerce shape)
  if (Array.isArray(raw && raw.ruleSets)) {
    const ruleSets = raw.ruleSets.map(rs => ({
      id:          rs.id || `rs_${crypto.randomBytes(4).toString('hex')}`,
      name:        rs.name || 'Untitled set',
      description: rs.description || '',
      rules:       Array.isArray(rs.rules) ? rs.rules : [],
    }));
    return { columnMappings, ruleSets, profileApi };
  }

  // 2) Legacy schema: flat rules[] → wrap as "Default" rule set
  if (Array.isArray(raw && raw.rules)) {
    return {
      columnMappings,
      ruleSets: [{
        id:          `rs_default`,
        name:        'Default',
        description: 'Migrated from legacy settings.',
        rules:       raw.rules,
      }],
      profileApi,
    };
  }

  // 3) Empty
  return { columnMappings, ruleSets: [], profileApi };
}

async function readSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_FILE, 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch (_) {
    return normalizeSettings({});
  }
}

async function writeSettings(settings) {
  const clean = normalizeSettings(settings);
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(clean, null, 2));
  return clean;
}

// ── Dataset storage ──────────────────────────────────────────────────────────

// Columns we surface in dataset summaries (shown in the dashboard list and
// the Firewatch widget). Add to this map to expose more fields without
// touching call sites — computeSummary walks the map.
const SUMMARY_COLUMNS = {
  templateUiName: 'saw_template_ui_name',
  gameName:       'saw_game_name',
  brandName:      'crm_brand_name',
  templateId:     'saw_template_id',
  createDate:     'create_date',
};

// Pull the summary fields off a dataset record. For create_date we also
// compute min/max so the UI can show the tournament date range even when
// the dataset spans multiple days.
function computeSummary(record) {
  const rows = Array.isArray(record?.rows) ? record.rows : [];
  if (!rows.length) return null;
  const first = rows[0] || {};
  const out = {};
  for (const [key, col] of Object.entries(SUMMARY_COLUMNS)) {
    const v = first[col];
    out[key] = (v === undefined || v === null || v === '') ? null : String(v);
  }
  const dates = rows
    .map(r => r[SUMMARY_COLUMNS.createDate])
    .filter(v => v !== undefined && v !== null && v !== '');
  if (dates.length) {
    let min = String(dates[0]);
    let max = String(dates[0]);
    for (const d of dates) {
      const s = String(d);
      if (s < min) min = s;
      if (s > max) max = s;
    }
    out.createDateMin = min;
    out.createDateMax = max;
  } else {
    out.createDateMin = null;
    out.createDateMax = null;
  }
  return out;
}

async function saveDataset(record) {
  // Keep summary in sync with the current rows on every save so rules that
  // mutate the data (column renames, mappings) still produce usable chips.
  if (Array.isArray(record.rows)) record.summary = computeSummary(record);
  const file = path.join(DATASETS_DIR, `${record.id}.json`);
  await fsp.writeFile(file, JSON.stringify(record, null, 2));
  return record;
}

// ── Profile enrichment ───────────────────────────────────────────────────────
// Ports the Google Apps Script in getProfileData.js: takes the PIDs from a
// dataset, groups them by brand (looked up from a row's crm_brand_name via
// settings.profileApi.brandMap), POSTs each batch to the right WordPress
// endpoint, and writes four new columns into each row: profile_name, avatar,
// avatar_image, phone. Enrichment is stored on the dataset file so the Figma
// plugin can consume it without re-hitting the API.

const ENRICH_COLUMNS = ['profile_name', 'avatar', 'avatar_image', 'phone'];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Post { pids: [...] } to a profile endpoint. Uses the global fetch
// available in Node 18+. Returns a { [pid]: { name, avatar, phone } } map,
// or throws if the server responds non-2xx.
async function fetchProfilesForBrand(endpoint, pids) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pids: pids.map(String) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from ${endpoint}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`Expected array response, got ${typeof json}`);
  const map = {};
  for (const r of json) {
    if (!r || r.pid === undefined || r.pid === null) continue;
    map[String(r.pid)] = {
      name:   r.profile_name || '',
      avatar: r.avatar || '',
      phone:  r.phone_number || '',
    };
  }
  return map;
}

// Enrich a single dataset record in place. Returns a summary object with
// per-brand counts and any errors encountered so the UI can show what
// happened. Rows whose crm_brand_name doesn't resolve to a known brand key
// stay untouched (they get empty strings in the enrichment columns).
async function enrichDataset(record, settings) {
  const cfg = settings.profileApi || normalizeProfileApi({});
  const pidCol = cfg.pidColumn;
  const rows = Array.isArray(record.rows) ? record.rows : [];
  if (!rows.length) return { enriched: 0, missing: 0, byBrand: {}, errors: [], skippedRows: 0 };

  // Bucket rows by brand key, deduping PIDs per brand.
  const byBrand = new Map(); // brandKey -> { rowIdx: Set<int>, pids: Set<string> }
  let skippedRows = 0;
  let skippedNoBrand = 0;   // brand column missing or not in brandMap
  let skippedNoPid   = 0;   // pidCol missing/empty on this row
  const unmappedBrands = new Map(); // rawBrand -> count (for user-visible debug)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rawBrand = String(row?.crm_brand_name || '').trim();
    const brandKey = cfg.brandMap[rawBrand] || null;
    const pid = row?.[pidCol];
    if (!brandKey) {
      skippedRows++;
      skippedNoBrand++;
      // Track what raw values we saw so the UI can tell the user exactly
      // which brandMap keys they're missing — the #1 cause of empty enrich.
      const k = rawBrand || '(empty)';
      unmappedBrands.set(k, (unmappedBrands.get(k) || 0) + 1);
      continue;
    }
    if (pid === undefined || pid === null || pid === '') {
      skippedRows++;
      skippedNoPid++;
      continue;
    }
    if (!byBrand.has(brandKey)) byBrand.set(brandKey, { rowIdx: [], pids: new Set() });
    const bucket = byBrand.get(brandKey);
    bucket.rowIdx.push(i);
    bucket.pids.add(String(pid));
  }

  const errors = [];
  const byBrandReport = {};
  const profilesByBrand = new Map(); // brandKey -> { [pid]: {name, avatar, phone} }

  for (const [brandKey, { pids }] of byBrand) {
    const endpoint = cfg.endpoints[brandKey];
    const pidArr = [...pids];
    byBrandReport[brandKey] = { pids: pidArr.length, matched: 0, endpoint: endpoint || null };
    if (!endpoint) {
      errors.push({ brandKey, error: `No endpoint configured for brand "${brandKey}"` });
      continue;
    }
    const merged = {};
    try {
      for (const batch of chunk(pidArr, cfg.batchSize)) {
        const m = await fetchProfilesForBrand(endpoint, batch);
        Object.assign(merged, m);
      }
      byBrandReport[brandKey].matched = Object.keys(merged).length;
      profilesByBrand.set(brandKey, merged);
    } catch (err) {
      errors.push({ brandKey, error: err.message });
    }
  }

  // Write enrichment back onto rows. Rows in a brand whose request failed
  // still get default avatars so the Figma plugin has something to show.
  let enriched = 0;
  let missing  = 0;
  for (const [brandKey, { rowIdx }] of byBrand) {
    const profiles    = profilesByBrand.get(brandKey) || {};
    const defaultAv   = cfg.defaultAvatars[brandKey] || '';
    for (const i of rowIdx) {
      const row = rows[i];
      const pid = String(row[pidCol]);
      const hit = profiles[pid];
      const hasRealName = hit && hit.name && String(hit.name).trim() !== pid;
      const profileName = hasRealName ? hit.name : `ID: ${pid}`;
      const avatarUrl   = (hit && hit.avatar) ? hit.avatar : defaultAv;
      const phone       = (hit && hit.phone)  ? hit.phone  : '';
      row.profile_name  = profileName;
      row.avatar        = avatarUrl;
      row.avatar_image  = avatarUrl; // URL form — rules/Figma can use either
      row.phone         = phone;
      if (hasRealName) enriched++; else missing++;
    }
  }

  // Keep headers in sync so the dataset-view UI picks up new columns.
  if (rows.length) {
    const headerSet = new Set(Array.isArray(record.headers) ? record.headers : Object.keys(rows[0]));
    for (const c of ENRICH_COLUMNS) headerSet.add(c);
    record.headers = [...headerSet];
  }

  record.enrichment = {
    lastRunAt: new Date().toISOString(),
    enriched,
    missing,
    skippedRows,
    skippedNoBrand,
    skippedNoPid,
    // Show the most common raw brand values we couldn't map — designer can
    // then add the missing key to settings.profileApi.brandMap and re-enrich.
    unmappedBrands: [...unmappedBrands.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value, count })),
    pidColumnSeen: rows[0] ? Object.prototype.hasOwnProperty.call(rows[0], pidCol) : false,
    brandColumnSeen: rows[0] ? Object.prototype.hasOwnProperty.call(rows[0], 'crm_brand_name') : false,
    byBrand: byBrandReport,
    errors,
    pidColumn: pidCol,
  };

  return record.enrichment;
}

async function listDatasets() {
  const files = (await fsp.readdir(DATASETS_DIR)).filter(f => f.endsWith('.json'));
  const records = [];
  for (const f of files) {
    try {
      const raw = await fsp.readFile(path.join(DATASETS_DIR, f), 'utf8');
      const r   = JSON.parse(raw);
      // Backfill summary for datasets saved before we started tracking it.
      // We already have the parsed file in memory here, so computing is free
      // and we avoid a second disk read on the /api/health hot path. Persist
      // the backfilled value so subsequent list calls skip the recompute.
      let summary = r.summary;
      if (!summary) {
        summary = computeSummary(r);
        if (summary) {
          r.summary = summary;
          try { await saveDataset(r); } catch (e) {
            console.warn(`[datasets] failed to persist summary for ${r.id}: ${e.message}`);
          }
        }
      }
      records.push({
        id:              r.id,
        filename:        r.filename,
        label:           r.label || null,
        uploadedAt:      r.uploadedAt,
        rowCount:        r.rowCount,
        headers:         r.headers,
        summary:         summary || null,
        enrichment:      r.enrichment || null,
        isProcessed:     r.isProcessed || false,
        sourceDatasetId: r.sourceDatasetId || null,
        ruleSetName:     r.ruleSetName || null,
        metrics:         r.metrics || null,
        ruleTable:       Array.isArray(r.ruleTable) ? r.ruleTable : (r.metrics ? buildRuleTable(r.metrics) : []),
        maxRows:         r.maxRows ?? null,
        sort:            r.sort || null,
      });
    } catch (e) {
      console.warn(`[datasets] skipping unreadable file ${f}: ${e.message}`);
    }
  }
  records.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
  return records;
}

async function getDataset(id) {
  const file = path.join(DATASETS_DIR, `${id}.json`);
  const raw  = await fsp.readFile(file, 'utf8');
  const rec  = JSON.parse(raw);
  // Backfill ruleTable for processed records saved before the field existed.
  // Derived from metrics, so no new server-side work — just a format rehash.
  if (rec.isProcessed && !Array.isArray(rec.ruleTable) && Array.isArray(rec.metrics)) {
    rec.ruleTable = buildRuleTable(rec.metrics);
  }
  return rec;
}

async function deleteDataset(id) {
  const file = path.join(DATASETS_DIR, `${id}.json`);
  await fsp.unlink(file);
}

function parseCsv(filepath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;
    fs.createReadStream(filepath)
      .pipe(csvParser())
      .on('headers', (h) => { headers = h; })
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve({ rows, headers: headers || (rows[0] ? Object.keys(rows[0]) : []) }))
      .on('error', reject);
  });
}

function applyColumnMappings(rows, mappings) {
  if (!mappings || !Object.keys(mappings).length) return rows;
  return rows.map(row => {
    const out = {};
    for (const key of Object.keys(row)) {
      const mapped = mappings[key] || key;
      out[mapped] = row[key];
    }
    return out;
  });
}

// ── Rule engine ──────────────────────────────────────────────────────────────
// Rule shape: { id, name, type, config }
// Supported types:
//   rename             → config: { from, to }
//   sort               → config: { column, direction: 'asc'|'desc' }
//   select-columns     → config: { columns: [string] }                              (keeps only those columns, in order)
//   extract-number     → config: { sourceColumn, targetColumn }                     (parses first number out of sourceColumn into a new numeric targetColumn)
//   count              → config: { column, value, matchMode: 'exact'|'contains' }   (metric)
//   count-times        → config: { column, value, matchMode, multiplier: number }   (metric: count × multiplier)
//   sum/avg/min/max    → config: { column }                                         (metric)
//   count-by           → config: { column }                                         (metric: {val: count})
//   aggregate-metrics  → config: { op: 'sum'|'avg'|'min'|'max', ruleIds: [string] } (metric: op over earlier metrics)

// Pull the first numeric token out of a string, honoring commas and decimals.
// "50,000 Cash"     → 50000
// "Free Flight 20MT" → 20
// "$1,234.56 prize" → 1234.56
// "no number here"  → null
function extractFirstNumber(input) {
  if (input === undefined || input === null) return null;
  const s = String(input);
  // Match: optional minus, then digits with optional comma groups, optional decimal.
  const m = s.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function applyRules(inputRows, inputHeaders, rules) {
  let rows    = Array.isArray(inputRows) ? inputRows.map(r => ({ ...r })) : [];
  let headers = Array.isArray(inputHeaders) && inputHeaders.length
    ? [...inputHeaders]
    : (rows[0] ? Object.keys(rows[0]) : []);
  const metrics = [];
  const safeRules = Array.isArray(rules) ? rules : [];

  for (const rule of safeRules) {
    const cfg = rule.config || {};
    switch (rule.type) {
      case 'rename': {
        const { from, to } = cfg;
        if (!from || !to || from === to) break;
        headers = headers.map(h => (h === from ? to : h));
        rows = rows.map(row => {
          if (!(from in row)) return row;
          const out = {};
          for (const k of Object.keys(row)) out[k === from ? to : k] = row[k];
          return out;
        });
        break;
      }

      case 'sort': {
        const { column, direction = 'asc' } = cfg;
        if (!column) break;
        const dir = direction === 'desc' ? -1 : 1;
        rows.sort((a, b) => {
          const av = a[column], bv = b[column];
          const an = Number(av), bn = Number(bv);
          const bothNumeric = !isNaN(an) && !isNaN(bn) && av !== '' && bv !== '';
          if (bothNumeric) return (an - bn) * dir;
          return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
        });
        break;
      }

      case 'select-columns': {
        const cols = Array.isArray(cfg.columns) ? cfg.columns.filter(Boolean) : [];
        if (!cols.length) break;
        // Preserve the requested order; drop any missing columns silently from headers.
        const headerSet = new Set(headers);
        const nextHeaders = cols.filter(c => headerSet.has(c));
        headers = nextHeaders;
        rows = rows.map(row => {
          const out = {};
          for (const c of nextHeaders) out[c] = row[c];
          return out;
        });
        break;
      }

      case 'extract-number': {
        // Reads sourceColumn, pulls the first numeric token, writes a real
        // Number into targetColumn (so downstream `sort` and sum/avg/min/max
        // rules work natively without comma-aware hacks).
        const { sourceColumn, targetColumn } = cfg;
        if (!sourceColumn || !targetColumn) break;
        rows = rows.map(row => {
          const out = { ...row };
          out[targetColumn] = extractFirstNumber(row[sourceColumn]);
          return out;
        });
        if (!headers.includes(targetColumn)) headers = [...headers, targetColumn];
        break;
      }

      case 'count': {
        const { column, value, matchMode = 'contains' } = cfg;
        if (!column || value === undefined || value === null || value === '') break;
        const needle = String(value).toLowerCase();
        const count = rows.reduce((acc, row) => {
          const v = String(row[column] ?? '').toLowerCase();
          const match = matchMode === 'exact' ? v === needle : v.includes(needle);
          return acc + (match ? 1 : 0);
        }, 0);
        metrics.push({
          ruleId: rule.id, ruleName: rule.name, type: 'count',
          column, matchValue: value, matchMode, value: count,
          format: cfg.format || null, currencyCode: cfg.currencyCode || null,
          currencyPosition: cfg.currencyPosition || null,
        });
        break;
      }

      case 'count-times': {
        const { column, value, matchMode = 'contains', multiplier } = cfg;
        if (!column || value === undefined || value === null || value === '') break;
        const mult = Number(multiplier);
        if (!Number.isFinite(mult)) break;
        const needle = String(value).toLowerCase();
        const count = rows.reduce((acc, row) => {
          const v = String(row[column] ?? '').toLowerCase();
          const match = matchMode === 'exact' ? v === needle : v.includes(needle);
          return acc + (match ? 1 : 0);
        }, 0);
        metrics.push({
          ruleId: rule.id, ruleName: rule.name, type: 'count-times',
          column, matchValue: value, matchMode, multiplier: mult,
          count, value: count * mult,
          format: cfg.format || null, currencyCode: cfg.currencyCode || null,
          currencyPosition: cfg.currencyPosition || null,
        });
        break;
      }

      case 'sum':
      case 'avg':
      case 'min':
      case 'max': {
        const { column } = cfg;
        if (!column) break;
        const nums = rows
          .map(r => Number(r[column]))
          .filter(n => Number.isFinite(n));
        let val = null;
        if (nums.length) {
          if (rule.type === 'sum') val = nums.reduce((a, b) => a + b, 0);
          if (rule.type === 'avg') val = nums.reduce((a, b) => a + b, 0) / nums.length;
          if (rule.type === 'min') val = Math.min(...nums);
          if (rule.type === 'max') val = Math.max(...nums);
        }
        metrics.push({
          ruleId: rule.id, ruleName: rule.name, type: rule.type,
          column, sampleCount: nums.length, value: val,
          format: cfg.format || null, currencyCode: cfg.currencyCode || null,
          currencyPosition: cfg.currencyPosition || null,
        });
        break;
      }

      case 'count-by': {
        const { column } = cfg;
        if (!column) break;
        const map = {};
        for (const row of rows) {
          const k = String(row[column] ?? '');
          map[k] = (map[k] || 0) + 1;
        }
        metrics.push({
          ruleId: rule.id, ruleName: rule.name, type: 'count-by',
          column, value: map,
          format: cfg.format || null, currencyCode: cfg.currencyCode || null,
          currencyPosition: cfg.currencyPosition || null,
        });
        break;
      }

      case 'aggregate-metrics': {
        // Roll up the numeric values of earlier metrics in this run.
        const op = cfg.op || 'sum';
        const ruleIds = Array.isArray(cfg.ruleIds) ? cfg.ruleIds : [];
        if (!ruleIds.length) break;
        const sources = [];
        for (const id of ruleIds) {
          const m = metrics.find(x => x.ruleId === id);
          if (!m) { sources.push({ id, name: null, sourceType: null, value: null, missing: true }); continue; }
          // count-times exposes both `count` and `value`; use `value` (the computed total).
          const n = Number(m.value);
          sources.push({
            id,
            name: m.ruleName,
            sourceType: m.type,
            value: Number.isFinite(n) ? n : null,
          });
        }
        const nums = sources.map(s => s.value).filter(n => Number.isFinite(n));
        let val = null;
        if (nums.length) {
          if (op === 'sum') val = nums.reduce((a, b) => a + b, 0);
          if (op === 'avg') val = nums.reduce((a, b) => a + b, 0) / nums.length;
          if (op === 'min') val = Math.min(...nums);
          if (op === 'max') val = Math.max(...nums);
        }
        metrics.push({
          ruleId: rule.id, ruleName: rule.name, type: 'aggregate-metrics',
          op, sources, value: val,
          format: cfg.format || null, currencyCode: cfg.currencyCode || null,
          currencyPosition: cfg.currencyPosition || null,
        });
        break;
      }

      default:
        // unknown rule type — skip silently
        break;
    }
  }
  return { rows, headers, metrics };
}

// Format a number for the TOTALS column. The raw numeric value is always kept
// under `TOTALS_raw` so downstream consumers (the Figma plugin, future API
// clients) can re-format independently — the `TOTALS` string is the display
// form designers typically want to bind directly to text.
//
// Supported formats:
//   - plain              → raw number, no commas, no currency          → 1234.56
//   - financial          → commas, negatives in parens, no currency     → 1,234.56 / (1,234.56)
//   - currency           → commas + currency symbol/code (position-aware)
//                          position=before → native locale symbol     → $1,234.56
//                          position=after  → ISO code with a space    → 1,234.56 MZN
//   - currency-rounded   → same as currency but 0 fraction digits     → $1,235 / 1,235 MZN
//
// `currencyPosition` defaults to 'before'. It's ignored for plain/financial.
function formatTotal(value, fmt, currencyCode, currencyPosition) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return value === undefined || value === null ? '' : String(value);
  }
  const code = currencyCode || 'USD';
  const pos  = currencyPosition === 'after' ? 'after' : 'before';
  try {
    switch (fmt) {
      case 'plain':
        // No commas. Strip any trailing .0 introduced by Number() for whole values.
        return String(n);
      case 'financial': {
        const body = new Intl.NumberFormat('en-US', {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }).format(Math.abs(n));
        return n < 0 ? `(${body})` : body;
      }
      case 'currency':
      case 'currency-rounded': {
        const rounded = fmt === 'currency-rounded' ? Math.round(n) : n;
        const frac    = fmt === 'currency-rounded' ? 0 : 2;
        if (pos === 'after') {
          // Number with commas + space + ISO code (e.g. "1,234.56 MZN").
          // Kept explicit so it works for any code regardless of whether Intl
          // has a locale-native symbol for it.
          const body = new Intl.NumberFormat('en-US', {
            minimumFractionDigits: frac, maximumFractionDigits: frac,
          }).format(rounded);
          return body + ' ' + code;
        }
        // Position: before → use locale currency style (produces native symbol
        // when one is known, falls back to the code otherwise).
        return new Intl.NumberFormat('en-US', {
          style: 'currency', currency: code,
          minimumFractionDigits: frac, maximumFractionDigits: frac,
        }).format(rounded);
      }
      default:
        return String(n);
    }
  } catch (_) {
    // Unknown currency code or Intl failure — fall back to a readable number.
    return n.toLocaleString('en-US');
  }
}

// Collapse the metrics array into a flat two-column table — {RULE, TOTALS} —
// that the Figma plugin can bind to directly without caring which metric type
// produced each value. Rules that produce a single number become one row;
// count-by (which yields a per-value histogram) expands into one row per key.
//
// Rows now include TOTALS_raw (numeric, unformatted) and TOTALS_format so the
// Figma plugin can choose whether to take the pre-formatted string or redo the
// formatting client-side. Default TOTALS is the formatted display string.
function buildRuleTable(metrics) {
  if (!Array.isArray(metrics) || !metrics.length) return [];
  const out = [];
  for (const m of metrics) {
    const baseName = m.ruleName && String(m.ruleName).trim()
      ? m.ruleName
      : autoMetricLabel(m);
    const fmt  = m.format || 'plain';
    const code = m.currencyCode || 'USD';
    const pos  = m.currencyPosition || 'before';

    if (m.type === 'count-by' && m.value && typeof m.value === 'object') {
      const entries = Object.entries(m.value)
        .map(([k, v]) => [k, Number(v) || 0])
        .sort((a, b) => b[1] - a[1]);
      for (const [key, count] of entries) {
        out.push({
          RULE:              `${baseName} · ${key || '(empty)'}`,
          TOTALS:            formatTotal(count, fmt, code, pos),
          TOTALS_raw:        count,
          TOTALS_format:     fmt,
          TOTALS_currency:   code,
          TOTALS_position:   pos,
        });
      }
      continue;
    }

    const n = Number(m.value);
    const raw = Number.isFinite(n) ? n : (m.value ?? null);
    out.push({
      RULE:              baseName,
      TOTALS:            formatTotal(raw, fmt, code, pos),
      TOTALS_raw:        raw,
      TOTALS_format:     fmt,
      TOTALS_currency:   code,
      TOTALS_position:   pos,
    });
  }
  return out;
}

function autoMetricLabel(m) {
  if (!m) return 'rule';
  const t = m.type || 'rule';
  if (t === 'count' || t === 'count-times') {
    const col = m.column ? `${m.column}` : '';
    const val = m.matchValue ? `:"${m.matchValue}"` : '';
    const mult = (t === 'count-times' && m.multiplier) ? ` × ${m.multiplier}` : '';
    return `${t}(${col}${val})${mult}`;
  }
  if (t === 'count-by') return `count-by(${m.column || ''})`;
  if (t === 'aggregate-metrics') return `${m.op || 'aggregate'}(metrics)`;
  if (m.column) return `${t}(${m.column})`;
  return t;
}

// Find a rule set by id inside a settings object. Returns null if not found.
function findRuleSet(settings, ruleSetId) {
  if (!ruleSetId) return null;
  return (settings.ruleSets || []).find(rs => rs.id === ruleSetId) || null;
}

// ── Column-mapping drift sweep ───────────────────────────────────────────────
// When columnMappings change, rule configs that reference canonical (mapped)
// column names need their references rewritten so they keep pointing at the
// right data. For each CSV source column `k`:
//   - before: rows carry the column as (oldMappings[k] || k)
//   - after:  rows carry the column as (newMappings[k] || k)
// If `before !== after`, rewrite `before` → `after` everywhere in the rules.
function buildMappingRewrites(oldMappings, newMappings) {
  const rewrites = {};
  const allKeys = new Set([
    ...Object.keys(oldMappings || {}),
    ...Object.keys(newMappings || {}),
  ]);
  for (const k of allKeys) {
    const before = (oldMappings && oldMappings[k]) || k;
    const after  = (newMappings && newMappings[k]) || k;
    if (before !== after) rewrites[before] = after;
  }
  return rewrites;
}

function rewriteRuleConfig(rule, rewrites) {
  const cfg = { ...(rule.config || {}) };
  const rw  = (name) => (name && rewrites[name]) || name;

  if (cfg.column) cfg.column = rw(cfg.column);
  if (cfg.from)   cfg.from   = rw(cfg.from);
  if (cfg.to)     cfg.to     = rw(cfg.to);
  if (Array.isArray(cfg.columns)) cfg.columns = cfg.columns.map(rw);

  return { ...rule, config: cfg };
}

function sweepRuleSets(ruleSets, rewrites) {
  if (!Object.keys(rewrites).length) return ruleSets;
  return (ruleSets || []).map(rs => ({
    ...rs,
    rules: (rs.rules || []).map(r => rewriteRuleConfig(r, rewrites)),
  }));
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Upload a CSV and create a dataset record
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { rows, headers } = await parseCsv(req.file.path);
    const settings = await readSettings();
    const mapped   = applyColumnMappings(rows, settings.columnMappings);

    const record = {
      id:         crypto.randomUUID(),
      filename:   req.file.originalname,
      storedAs:   path.basename(req.file.path),
      uploadedAt: new Date().toISOString(),
      rowCount:   mapped.length,
      headers:    mapped[0] ? Object.keys(mapped[0]) : headers,
      rows:       mapped,
    };
    await saveDataset(record);

    res.json({
      ok: true,
      id: record.id,
      rowCount: record.rowCount,
      headers: record.headers,
    });
  } catch (err) {
    console.error('[upload] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List datasets (metadata only)
app.get('/api/datasets', async (req, res) => {
  try {
    // ?processed=true|1 restricts the list to processed (Figma-ready) datasets.
    // The Figma plugin uses this to guarantee it can never pick a raw upload.
    const onlyProcessed = /^(1|true|yes)$/i.test(String(req.query.processed || ''));
    let datasets = await listDatasets();
    if (onlyProcessed) datasets = datasets.filter(d => d.isProcessed);
    res.json({ datasets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dedicated endpoint the Figma plugin hits. Identical to /api/datasets?processed=true
// but more discoverable and future-proof — we can slim the payload here without
// risking the dashboard view.
app.get('/api/figma/datasets', async (_req, res) => {
  try {
    const datasets = (await listDatasets()).filter(d => d.isProcessed);
    res.json({ datasets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single-record fetch for the Figma plugin — 404s on any non-processed dataset
// so a Bridge URL won't smuggle a raw upload in.
app.get('/api/figma/datasets/:id', async (req, res) => {
  try {
    const record = await getDataset(req.params.id);
    if (!record || !record.isProcessed) {
      return res.status(404).json({ error: 'Only processed datasets are available to the Figma plugin.' });
    }
    res.json(record);
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Fetch a dataset with its rows
app.get('/api/datasets/:id', async (req, res) => {
  try {
    res.json(await getDataset(req.params.id));
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Delete a dataset
app.delete('/api/datasets/:id', async (req, res) => {
  try {
    await deleteDataset(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Patch a dataset (rename / add a label). Only `label` is editable right now.
app.patch('/api/datasets/:id', async (req, res) => {
  try {
    const record = await getDataset(req.params.id);
    if (typeof req.body?.label === 'string') {
      record.label = req.body.label.trim() || null;
    }
    await saveDataset(record);
    res.json({
      ok: true,
      dataset: {
        id: record.id,
        filename: record.filename,
        label: record.label || null,
        uploadedAt: record.uploadedAt,
        rowCount: record.rowCount,
        headers: record.headers,
        summary: record.summary || null,
      },
    });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Enrich a dataset with profile data (name/avatar/phone) from the
// brand-specific WordPress endpoint. Idempotent — re-running refreshes.
app.post('/api/datasets/:id/enrich', async (req, res) => {
  try {
    const settings = await readSettings();
    const record   = await getDataset(req.params.id);
    const report   = await enrichDataset(record, settings);
    await saveDataset(record);
    res.json({
      ok: true,
      enrichment: report,
      dataset: {
        id: record.id,
        filename: record.filename,
        label: record.label || null,
        uploadedAt: record.uploadedAt,
        rowCount: record.rowCount,
        headers: record.headers,
        summary: record.summary || null,
      },
    });
  } catch (err) {
    console.error('[enrich] error:', err);
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Generate a processed dataset: apply column mappings + a rule set + column
// visibility filter, then save as a new standalone dataset. The Figma plugin
// only shows processed datasets so it always works with clean, ready-to-inject
// data rather than raw CSV rows.
app.post('/api/datasets/:id/process', async (req, res) => {
  try {
    const record   = await getDataset(req.params.id);
    const settings = await readSettings();
    const { ruleSetId, visibleColumns, label, maxRows, sort } = req.body || {};

    // 1. Apply column mappings
    const mappedRows    = applyColumnMappings(record.rows, settings.columnMappings);
    const mappedHeaders = mappedRows.length
      ? Object.keys(mappedRows[0])
      : record.headers.map(h => settings.columnMappings[h] || h);

    // 2. Apply rule set (transforms + metrics)
    let rules   = [];
    let ruleSet = null;
    if (ruleSetId) {
      ruleSet = findRuleSet(settings, ruleSetId);
      if (!ruleSet) return res.status(404).json({ error: 'Rule set not found' });
      rules = ruleSet.rules;
    }
    // NOTE: rules run on the FULL mapped row set (all columns), so toggling
    // columns off in the View tab does NOT change which fields the rules can
    // read. The {RULE, TOTALS} table is therefore stable regardless of column
    // visibility — exactly the behaviour Brooky asked for.
    const { rows: ruledRows, headers: ruledHeaders, metrics } = applyRules(mappedRows, mappedHeaders, rules);
    const ruleTable = buildRuleTable(metrics);

    // 3. Filter to visible columns (default: all)
    const cols = (Array.isArray(visibleColumns) && visibleColumns.length)
      ? visibleColumns.filter(c => ruledHeaders.includes(c))
      : ruledHeaders;

    let finalRows = ruledRows.map(row => {
      const out = {};
      for (const c of cols) out[c] = row[c];
      return out;
    });

    // Apply the preview-time sort (if any) so the saved order matches the
    // order the user saw on screen when they hit Save.
    if (sort && sort.column && cols.includes(sort.column)) {
      const dir = sort.direction === 'desc' ? -1 : 1;
      const col = sort.column;
      // Numeric sort if every non-empty value parses as a number.
      const allNumeric = finalRows.every(r => {
        const v = r[col];
        if (v === undefined || v === null || v === '') return true;
        return Number.isFinite(Number(v));
      });
      finalRows = [...finalRows].sort((a, b) => {
        const av = a[col], bv = b[col];
        if (av === bv) return 0;
        if (av === undefined || av === null || av === '') return 1;
        if (bv === undefined || bv === null || bv === '') return -1;
        if (allNumeric) return (Number(av) - Number(bv)) * dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
      });
    }

    // Max rows cap — applied AFTER sort so the Figma plugin gets the top N
    // of the sorted order, not a random N.
    const cap = Number.isFinite(Number(maxRows)) && Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : null;
    if (cap !== null) finalRows = finalRows.slice(0, cap);

    const sourceName = record.label || record.filename;
    const processed  = {
      id:             crypto.randomUUID(),
      filename:       `${sourceName} (processed)`,
      label:          label || `${sourceName} — processed`,
      storedAs:       null,
      uploadedAt:     new Date().toISOString(),
      rowCount:       finalRows.length,
      headers:        cols,
      rows:           finalRows,
      isProcessed:    true,
      sourceDatasetId: record.id,
      sourceFilename:  record.filename,
      ruleSetId:       ruleSetId || null,
      ruleSetName:     ruleSet ? ruleSet.name : null,
      metrics,
      ruleTable,       // [{RULE, TOTALS}, …] — Figma-friendly flat form of `metrics`
      visibleColumns:  cols,
      maxRows:         cap,  // persisted cap; null means no limit
      sort:            (sort && sort.column) ? { column: sort.column, direction: sort.direction || 'asc' } : null,
    };
    processed.summary = computeSummary(processed);
    await saveDataset(processed);

    res.json({
      ok: true,
      dataset: {
        id:              processed.id,
        filename:        processed.filename,
        label:           processed.label,
        uploadedAt:      processed.uploadedAt,
        rowCount:        processed.rowCount,
        headers:         processed.headers,
        isProcessed:     true,
        sourceDatasetId: processed.sourceDatasetId,
        ruleSetName:     processed.ruleSetName,
        metrics:         processed.metrics,
        ruleTable:       processed.ruleTable,
        maxRows:         processed.maxRows,
        sort:            processed.sort,
      },
    });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Re-apply current column mappings to a stored dataset.
// Useful when mappings were added/changed after the CSV was originally uploaded.
// Idempotent — running twice is safe (already-mapped columns pass through unchanged).
app.post('/api/datasets/:id/remap', async (req, res) => {
  try {
    const settings = await readSettings();
    const record   = await getDataset(req.params.id);
    const mappings = settings.columnMappings || {};

    if (!Object.keys(mappings).length) {
      return res.json({ ok: true, renamedCount: 0, message: 'No column mappings configured.' });
    }

    const before = record.rows.length ? Object.keys(record.rows[0]) : [];
    record.rows    = applyColumnMappings(record.rows, mappings);
    record.headers = record.rows.length
      ? Object.keys(record.rows[0])
      : record.headers.map(h => mappings[h] || h);

    // Count how many headers actually changed
    const after        = record.rows.length ? Object.keys(record.rows[0]) : [];
    const renamedCount = before.filter((h, i) => h !== after[i]).length;

    record.summary = computeSummary(record);
    await saveDataset(record);

    res.json({
      ok: true,
      renamedCount,
      headers: record.headers,
      dataset: {
        id: record.id,
        filename: record.filename,
        label: record.label || null,
        uploadedAt: record.uploadedAt,
        rowCount: record.rowCount,
        headers: record.headers,
        summary: record.summary || null,
      },
    });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Settings (column mappings + rule sets)
app.get('/api/settings', async (_req, res) => {
  res.json(await readSettings());
});

app.post('/api/settings', async (req, res) => {
  try {
    const current  = await readSettings();
    const incoming = normalizeSettings(req.body || {});
    const rewrites = buildMappingRewrites(current.columnMappings, incoming.columnMappings);

    // Start from what the client sent, then sweep its rule sets so any
    // references to now-renamed columns follow the mapping change.
    const next = {
      columnMappings: incoming.columnMappings,
      ruleSets: sweepRuleSets(incoming.ruleSets, rewrites),
      // Persist profileApi alongside the other settings so the enrich
      // pipeline and UI share a single source of truth.
      profileApi: incoming.profileApi,
    };

    const saved = await writeSettings(next);
    res.json({
      ok: true,
      settings: saved,
      rewrites,            // let the UI show what was rewritten (empty if no drift)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rule set CRUD ────────────────────────────────────────────────────────────
// Create a new rule set
app.post('/api/rule-sets', async (req, res) => {
  try {
    const settings = await readSettings();
    const body = req.body || {};
    const ruleSet = {
      id:          body.id || `rs_${crypto.randomBytes(4).toString('hex')}`,
      name:        (body.name || 'Untitled set').trim() || 'Untitled set',
      description: (body.description || '').trim(),
      rules:       Array.isArray(body.rules) ? body.rules : [],
    };
    settings.ruleSets = [...(settings.ruleSets || []), ruleSet];
    await writeSettings(settings);
    res.json({ ok: true, ruleSet });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update an existing rule set (rename, replace rules/description)
app.patch('/api/rule-sets/:id', async (req, res) => {
  try {
    const settings = await readSettings();
    const idx = (settings.ruleSets || []).findIndex(rs => rs.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Rule set not found' });

    const current = settings.ruleSets[idx];
    const body = req.body || {};
    const updated = {
      ...current,
      ...(typeof body.name === 'string'        ? { name: body.name.trim() || current.name } : {}),
      ...(typeof body.description === 'string' ? { description: body.description.trim() }  : {}),
      ...(Array.isArray(body.rules)            ? { rules: body.rules }                     : {}),
    };
    settings.ruleSets[idx] = updated;
    await writeSettings(settings);
    res.json({ ok: true, ruleSet: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a rule set
app.delete('/api/rule-sets/:id', async (req, res) => {
  try {
    const settings = await readSettings();
    const before = (settings.ruleSets || []).length;
    settings.ruleSets = (settings.ruleSets || []).filter(rs => rs.id !== req.params.id);
    if (settings.ruleSets.length === before) {
      return res.status(404).json({ error: 'Rule set not found' });
    }
    await writeSettings(settings);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Apply rules to a payload (stateless). Used for live previews.
app.post('/api/apply-rules', (req, res) => {
  const { data = [], headers = [], rules = [] } = req.body || {};
  res.json(applyRules(data, headers, rules));
});

// Apply a rule set (or inline rules) to a stored dataset.
// Body: { ruleSetId?: string, rules?: Rule[] }
//   - If ruleSetId is provided, use that set's rules.
//   - Else if rules is provided, use those.
//   - Else: no rules applied (returns dataset rows as-is with empty metrics).
app.post('/api/datasets/:id/apply-rules', async (req, res) => {
  try {
    const record   = await getDataset(req.params.id);
    const settings = await readSettings();

    let rules = [];
    let ruleSet = null;
    if (req.body && typeof req.body.ruleSetId === 'string' && req.body.ruleSetId) {
      ruleSet = findRuleSet(settings, req.body.ruleSetId);
      if (!ruleSet) return res.status(404).json({ error: 'Rule set not found' });
      rules = ruleSet.rules;
    } else if (req.body && Array.isArray(req.body.rules)) {
      rules = req.body.rules;
    }

    // Apply column mappings before running rules so that rules referencing
    // mapped column names work even if the dataset was uploaded before the
    // mappings were configured (or if mappings changed since upload).
    const mappedRows    = applyColumnMappings(record.rows, settings.columnMappings);
    const mappedHeaders = mappedRows.length
      ? Object.keys(mappedRows[0])
      : record.headers.map(h => settings.columnMappings[h] || h);

    const result = applyRules(mappedRows, mappedHeaders, rules);
    const ruleTable = buildRuleTable(result.metrics);
    res.json({
      dataset: {
        id: record.id,
        filename: record.filename,
        label: record.label || null,
        uploadedAt: record.uploadedAt,
        rowCount: record.rowCount,
      },
      ruleSet: ruleSet
        ? { id: ruleSet.id, name: ruleSet.name, ruleCount: ruleSet.rules.length }
        : null,
      ...result,
      ruleTable,
    });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Health snapshot for the Firewatch widget.
app.get('/api/health', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [datasets, settings] = await Promise.all([listDatasets(), readSettings()]);
    const latest = datasets[0] || null;
    res.json({
      ok: true,
      service: 'smartico-bridge',
      uptimeSec: Math.round(process.uptime()),
      datasets: {
        total:  datasets.length,
        latest: latest
          ? {
              id:         latest.id,
              filename:    latest.filename,
              label:       latest.label || null,
              uploadedAt:  latest.uploadedAt,
              rowCount:    latest.rowCount,
              summary:     latest.summary || null,
              isProcessed: latest.isProcessed || false,
              maxRows:     latest.maxRows ?? null,
              ruleSetName: latest.ruleSetName || null,
            }
          : null,
      },
      ruleSets: {
        total: (settings.ruleSets || []).length,
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Error handler (catches multer rejections etc.) ───────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[server error]', err.message);
  res.status(400).json({ error: err.message });
});

// ── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🎰 Smartico Bridge running on http://localhost:${PORT}`);
    console.log(`   Data directory: ${DATA_DIR}`);
  });
}

module.exports = app;
