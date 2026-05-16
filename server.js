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
const DATASETS_DIR  = path.join(DATA_DIR, 'datasets');
const PIPELINES_DIR = path.join(DATA_DIR, 'pipelines');
const DROPZONES_DIR = path.join(DATA_DIR, 'dropzones');
const ASSETS_DIR    = path.join(DATA_DIR, 'assets');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// ── Bootstrap folders & files ────────────────────────────────────────────────
for (const dir of [DATA_DIR, DATASETS_DIR, PIPELINES_DIR, DROPZONES_DIR, ASSETS_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(SETTINGS_FILE)) {
  // Restore from the committed seed file if one exists (recovery after accidental
  // git-tracked deletion), otherwise boot with an empty config.
  const seedFile = path.join(DATA_DIR, 'settings-seed.json');
  if (fs.existsSync(seedFile)) {
    fs.copyFileSync(seedFile, SETTINGS_FILE);
    console.log('[boot] settings.json restored from settings-seed.json');
  } else {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ columnMappings: {}, ruleSets: [] }, null, 2));
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '25mb' }));

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
    '888-Tanzania':        '888bets Tanzania',
    '888bets Tanzania':    '888bets Tanzania',
    '888-Kenya':           '888bets Kenya',
    '888bets Kenya':       '888bets Kenya',
  },
  // Auto country code — derived from brand key, no rule needed.
  // Written into `country_code` column during enrichment automatically.
  countryMap: {
    '888bets Mozambique': 'MZ',
    '888bets Angola':     'AO',
    'BetLion Zambia':     'ZM',
    '888bets Tanzania':   'TZ',
    '888bets Kenya':      'KE',
  },
  endpoints: {
    '888bets Mozambique': 'https://888africa.com/888bets-mozambique/wp-json/profiles/v1/profile-names-by-pids',
    '888bets Angola':     'https://888africa.com/888bets-mozambique/wp-json/profiles/v1/profile-names-by-pids',
    'BetLion Zambia':     'https://gamepage.betlion.co.zm/wp-json/betlion-zambia/profile-names-by-pids',
    '888bets Tanzania':   'https://888africa.com/888bets-mozambique/wp-json/profiles/v1/profile-names-by-pids',
    '888bets Kenya':      'https://888africa.com/888bets-mozambique/wp-json/profiles/v1/profile-names-by-pids',
  },
  defaultAvatars: {
    '888bets Mozambique': 'https://blaze.888bets.co.mz/wp-content/uploads/2025/02/Property-1Mystery.png',
    '888bets Angola':     'https://blaze.888bets.co.mz/wp-content/uploads/2025/02/Property-1Mystery.png',
    'BetLion Zambia':     'https://gamepage.betlion.co.zm/wp-content/themes/megamission/images/avatars/avatardefault.webp',
    '888bets Tanzania':   'https://blaze.888bets.co.mz/wp-content/uploads/2025/02/Property-1Mystery.png',
    '888bets Kenya':      'https://blaze.888bets.co.mz/wp-content/uploads/2025/02/Property-1Mystery.png',
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
    countryMap:     pick('countryMap',     DEFAULT_PROFILE_API.countryMap),
    endpoints:      pick('endpoints',      DEFAULT_PROFILE_API.endpoints),
    defaultAvatars: pick('defaultAvatars', DEFAULT_PROFILE_API.defaultAvatars),
    pidColumn:      typeof src.pidColumn === 'string' && src.pidColumn ? src.pidColumn : DEFAULT_PROFILE_API.pidColumn,
    batchSize:      (Number.isFinite(bs) && bs > 0) ? Math.floor(bs) : DEFAULT_PROFILE_API.batchSize,
  };
}

// Build a normalised mappingSets array + activeMappingSetId from raw settings.
// Migration rules:
//   1. If raw.mappingSets is an array, trust it. Coerce each entry's shape.
//   2. Otherwise, if raw.columnMappings has keys, wrap them into a single
//      "Default" set (id=ms_default) so previously-saved mappings survive.
//   3. Otherwise return an empty list.
// columnMappings (the legacy flat object) is then *derived* from the active
// set so any code path that still reads settings.columnMappings keeps working.
function normalizeMappingSets(raw) {
  const incomingSets = Array.isArray(raw && raw.mappingSets) ? raw.mappingSets : null;
  const incomingCM   = (raw && typeof raw.columnMappings === 'object' && raw.columnMappings) || null;
  let sets = [];

  if (incomingSets) {
    sets = incomingSets.map(s => ({
      id:       s.id || `ms_${crypto.randomBytes(4).toString('hex')}`,
      name:     s.name || 'Untitled mappings',
      mappings: (s.mappings && typeof s.mappings === 'object') ? { ...s.mappings } : {},
    }));
  } else if (incomingCM && Object.keys(incomingCM).length) {
    sets = [{ id: 'ms_default', name: 'Default', mappings: { ...incomingCM } }];
  }

  // Pick active id: prefer raw.activeMappingSetId if it points at a real set,
  // otherwise fall back to the first set, otherwise null.
  let activeId = (raw && typeof raw.activeMappingSetId === 'string' && raw.activeMappingSetId) || null;
  if (activeId && !sets.find(s => s.id === activeId)) activeId = null;
  if (!activeId && sets.length) activeId = sets[0].id;

  // Derive flat columnMappings from the active set so legacy code keeps working
  const active = sets.find(s => s.id === activeId);
  const columnMappings = active ? { ...active.mappings } : {};

  return { mappingSets: sets, activeMappingSetId: activeId, columnMappings };
}

// Coerce column-visibility presets. Each preset stores the columns to *hide*
// (rather than the columns to show) so a saved preset still works after new
// columns are added — newly appearing columns default to visible.
function normalizeColumnPresets(raw) {
  const list = Array.isArray(raw && raw.columnPresets) ? raw.columnPresets : [];
  return list.map(p => ({
    id:     p.id || `cp_${crypto.randomBytes(4).toString('hex')}`,
    name:   p.name || 'Untitled preset',
    hidden: Array.isArray(p.hidden) ? p.hidden.map(String) : [],
  }));
}

function normalizeSettings(raw) {
  const profileApi              = normalizeProfileApi(raw && raw.profileApi);
  const mappingBlock            = normalizeMappingSets(raw);
  const columnPresets           = normalizeColumnPresets(raw);
  const defaultColumnPresetId   = (raw && raw.defaultColumnPresetId) || null;

  // 1) If ruleSets already exists, trust it (coerce shape)
  if (Array.isArray(raw && raw.ruleSets)) {
    const ruleSets = raw.ruleSets.map(rs => ({
      id:          rs.id || `rs_${crypto.randomBytes(4).toString('hex')}`,
      name:        rs.name || 'Untitled set',
      description: rs.description || '',
      rules:       Array.isArray(rs.rules) ? rs.rules : [],
    }));
    return { ...mappingBlock, ruleSets, profileApi, columnPresets, defaultColumnPresetId };
  }

  // 2) Legacy schema: flat rules[] → wrap as "Default" rule set
  if (Array.isArray(raw && raw.rules)) {
    return {
      ...mappingBlock,
      ruleSets: [{
        id:          `rs_default`,
        name:        'Default',
        description: 'Migrated from legacy settings.',
        rules:       raw.rules,
      }],
      profileApi,
      columnPresets,
      defaultColumnPresetId,
    };
  }

  // 3) Empty
  return { ...mappingBlock, ruleSets: [], profileApi, columnPresets, defaultColumnPresetId };
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

// Avatar pool sourced from the 888bets Mozambique profile system — these are
// the same images assigned to real user profiles on the brand sites.
const AVATAR_POOL_888 = [
  'Arsenal', 'Barcelona', 'Benfica', 'Big-Plane', 'Cheetah', 'Chelsea',
  'Diamond', 'Elephant', 'Emrald', 'Football', 'Giraffe', 'Gorilla',
  'MALAWI', 'Orange-Diamond', 'Plane', 'Porto', 'Propeller-Plane',
  'Propeller', 'Ruby', 'Simba', 'ZAMBIA',
].map(n => `https://888africa.com/888bets-mozambique/wp-content/uploads/sites/2/2025/09/${n}.webp`);

// Pick a deterministic avatar from the pool based on the PID so the same
// winner always gets the same avatar, but different winners get different ones.
function poolAvatarForPid(pid) {
  const str = String(pid);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return AVATAR_POOL_888[hash % AVATAR_POOL_888.length];
}

// Return a fallback avatar for a winner with no profile image. Uses the pool
// avatar for the PID so each winner gets a unique but consistent image.
function brandDefaultAvatar(cfg, brandKey, pid) {
  if (pid) return poolAvatarForPid(pid);
  if (brandKey && cfg.defaultAvatars && cfg.defaultAvatars[brandKey]) {
    return cfg.defaultAvatars[brandKey];
  }
  const vals = Object.values((cfg && cfg.defaultAvatars) || {});
  return vals.length ? vals[0] : '';
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

  // Write enrichment back onto rows.
  // ALL rows get profile_name / avatar / avatar_image / phone / country_code —
  // even rows that were skipped due to missing brand (they get safe fallbacks).
  // This mirrors the Google Apps Script behaviour: every row ends up with
  // "ID: <pid>" when no real name is found, and the brand default avatar.
  let enriched = 0;
  let missing  = 0;

  // First pass: write brand-matched rows with real (or fallback) profile data.
  for (const [brandKey, { rowIdx }] of byBrand) {
    const profiles   = profilesByBrand.get(brandKey) || {};
    const countryCode = (cfg.countryMap || {})[brandKey] || '';
    for (const i of rowIdx) {
      const row = rows[i];
      const pid = String(row[pidCol]);
      const hit = profiles[pid];
      const hasRealName = hit && hit.name && String(hit.name).trim() !== pid;
      const profileName = hasRealName ? hit.name : `ID: ${pid}`;
      // If the API returned no avatar, fall back to the brand's own default
      // placeholder image (same image the enrichment API uses for unknown users).
      const avatarUrl = (hit && hit.avatar) ? hit.avatar : brandDefaultAvatar(cfg, brandKey, pid);
      const phone     = (hit && hit.phone)  ? hit.phone  : '';
      row.profile_name  = profileName;
      row.avatar        = avatarUrl;
      row.avatar_image  = avatarUrl;
      row.phone         = phone;
      row.country_code  = countryCode;
      if (hasRealName) enriched++; else missing++;
    }
  }

  // Second pass: rows that had no brand match still need the columns written
  // so no row is missing profile_name / avatar / country_code after enrichment.
  const enrichedIdx = new Set([...byBrand.values()].flatMap(b => b.rowIdx));
  for (let i = 0; i < rows.length; i++) {
    if (enrichedIdx.has(i)) continue;
    const row = rows[i];
    const pid = String(row[pidCol] || i + 1);
    const rawBrand = String(row?.crm_brand_name || '').trim();
    const countryCode = (cfg.countryMap || {})[rawBrand] || '';
    // Resolve brand key from the raw brand name (if any) so we can use the
    // brand's own default avatar rather than an external placeholder service.
    const resolvedBrandKey = (cfg.brandMap || {})[rawBrand] || null;
    if (!row.profile_name) row.profile_name = `ID: ${pid}`;
    if (!row.avatar)        row.avatar       = brandDefaultAvatar(cfg, resolvedBrandKey, pid);
    if (!row.avatar_image)  row.avatar_image = row.avatar;
    if (!row.phone)         row.phone        = '';
    if (!row.country_code)  row.country_code = countryCode;
  }

  // Keep headers in sync so the dataset-view UI picks up new columns.
  if (rows.length) {
    const headerSet = new Set(Array.isArray(record.headers) ? record.headers : Object.keys(rows[0]));
    for (const c of [...ENRICH_COLUMNS, 'country_code']) headerSet.add(c);
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
      // Extract unique country codes from any column whose name matches
      // /country/i (typically `country_code` written by the country-code rule).
      let countryCodes = [];
      if (Array.isArray(r.headers) && Array.isArray(r.rows)) {
        const ccCol = r.headers.find(h => /country/i.test(h));
        if (ccCol) {
          const seen = new Set();
          for (const row of r.rows) {
            const v = String(row[ccCol] ?? '').trim();
            if (v) seen.add(v);
          }
          countryCodes = [...seen].sort();
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
        pipelineId:      r.pipelineId   || null,
        pipelineName:    r.pipelineName || null,
        metrics:         r.metrics || null,
        ruleTable:       Array.isArray(r.ruleTable) ? r.ruleTable : (r.metrics ? buildRuleTable(r.metrics) : []),
        maxRows:         r.maxRows ?? null,
        sort:            r.sort || null,
        hiddenRows:      Array.isArray(r.hiddenRows) ? r.hiddenRows : [],
        countryCodes,
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
  // Backfill hiddenRows for records saved before the field existed.
  if (!Array.isArray(rec.hiddenRows)) rec.hiddenRows = [];
  return rec;
}

async function deleteDataset(id) {
  const file = path.join(DATASETS_DIR, `${id}.json`);
  await fsp.unlink(file);
}

// ── Pipelines storage ────────────────────────────────────────────────────────
// A pipeline is an ordered chain of saved rule sets. Storage shape:
//   {
//     id, name, description, filenameTemplate,
//     nodes: [{ id, ruleSetId, x, y }],
//     edges: [{ from, to }],   // node-id → node-id, defines run order
//     createdAt, updatedAt,
//   }
// The canvas editor in the UI persists node positions (x/y) here so the
// layout survives reloads.
async function listPipelines() {
  const files = (await fsp.readdir(PIPELINES_DIR)).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const raw = await fsp.readFile(path.join(PIPELINES_DIR, f), 'utf8');
      const r   = JSON.parse(raw);
      out.push({
        id:               r.id,
        name:             r.name || 'Untitled pipeline',
        description:      r.description || '',
        filenameTemplate: r.filenameTemplate || '{pipelineName}',
        mappingSetId:     typeof r.mappingSetId === 'string' ? r.mappingSetId : null,
        columnPresetId:   typeof r.columnPresetId === 'string' ? r.columnPresetId : null,
        // When true the pipeline appears as a drop-zone card on the homepage
        // and in the Figma plugin pipeline dropdown.
        isDropzone:       !!r.isDropzone,
        // Max rows sent to the Figma plugin (null = unlimited).
        outputRowLimit:   Number.isFinite(Number(r.outputRowLimit)) && Number(r.outputRowLimit) > 0
          ? Math.floor(Number(r.outputRowLimit))
          : null,
        nodeCount:        Array.isArray(r.nodes) ? r.nodes.length : 0,
        edgeCount:        Array.isArray(r.edges) ? r.edges.length : 0,
        createdAt:        r.createdAt || null,
        updatedAt:        r.updatedAt || null,
      });
    } catch (e) {
      console.warn(`[pipelines] skipping unreadable file ${f}: ${e.message}`);
    }
  }
  // Most-recently-updated first matches the dataset list ordering.
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

async function getPipeline(id) {
  const file = path.join(PIPELINES_DIR, `${id}.json`);
  const raw  = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function savePipeline(record) {
  record.updatedAt = new Date().toISOString();
  if (!record.createdAt) record.createdAt = record.updatedAt;
  const file = path.join(PIPELINES_DIR, `${record.id}.json`);
  await fsp.writeFile(file, JSON.stringify(record, null, 2));
  return record;
}

async function deletePipeline(id) {
  const file = path.join(PIPELINES_DIR, `${id}.json`);
  await fsp.unlink(file);
}

// Topo-order the nodes given the edge list. For the linear-chain MVP we just
// follow `from → to` greedily — but using a proper Kahn's algorithm here
// future-proofs us for the day pipelines branch. Returns nodes in the order
// they should run; cycles are detected and throw.
function orderPipelineNodes(nodes, edges) {
  if (!Array.isArray(nodes) || !nodes.length) return [];
  const safeEdges = Array.isArray(edges) ? edges : [];
  const indeg = {};
  const outAdj = {};
  for (const n of nodes) { indeg[n.id] = 0; outAdj[n.id] = []; }
  for (const e of safeEdges) {
    if (!e || !(e.from in indeg) || !(e.to in indeg)) continue;
    indeg[e.to] = (indeg[e.to] || 0) + 1;
    outAdj[e.from].push(e.to);
  }
  const queue = nodes.filter(n => indeg[n.id] === 0).map(n => n.id);
  const ordered = [];
  const idToNode = Object.fromEntries(nodes.map(n => [n.id, n]));
  while (queue.length) {
    const id = queue.shift();
    ordered.push(idToNode[id]);
    for (const next of outAdj[id]) {
      indeg[next]--;
      if (indeg[next] === 0) queue.push(next);
    }
  }
  if (ordered.length !== nodes.length) {
    throw new Error('Pipeline has a cycle — every node must be reachable in a non-circular order.');
  }
  return ordered;
}

// ── Drop zones storage ───────────────────────────────────────────────────────
// A drop zone is a named card on the dashboard that runs a specific pipeline
// when a CSV is dropped onto it. Storage shape:
//   { id, name, pipelineId, position, createdAt, updatedAt }
async function listDropZones() {
  const files = (await fsp.readdir(DROPZONES_DIR)).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const raw = await fsp.readFile(path.join(DROPZONES_DIR, f), 'utf8');
      out.push(JSON.parse(raw));
    } catch (e) {
      console.warn(`[dropzones] skipping unreadable file ${f}: ${e.message}`);
    }
  }
  // Sort by position (manual user ordering), then by createdAt as a tiebreaker.
  out.sort((a, b) => {
    const pa = Number.isFinite(a.position) ? a.position : 9999;
    const pb = Number.isFinite(b.position) ? b.position : 9999;
    if (pa !== pb) return pa - pb;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
  return out;
}

async function getDropZone(id) {
  const file = path.join(DROPZONES_DIR, `${id}.json`);
  const raw  = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function saveDropZone(record) {
  record.updatedAt = new Date().toISOString();
  if (!record.createdAt) record.createdAt = record.updatedAt;
  const file = path.join(DROPZONES_DIR, `${record.id}.json`);
  await fsp.writeFile(file, JSON.stringify(record, null, 2));
  return record;
}

async function deleteDropZone(id) {
  const file = path.join(DROPZONES_DIR, `${id}.json`);
  await fsp.unlink(file);
}

// Resolve a filename template against a pipeline run. Supported tokens
// (always lowercased {curly} form): {pipelineName}, {sourceFilename}, {date},
// {time}, {dropZoneName}, {iteration}. Unknown tokens are left in place so a
// typo is at least visible.
//
// {iteration} is zero-padded to 3 digits (e.g. 001) — a friendlier default
// than a raw counter, and 999 runs is enough headroom that designers never
// see overflow on practical CSV drop cards.
function renderFilenameTemplate(template, ctx) {
  const safeTpl = String(template || '{pipelineName}').trim() || '{pipelineName}';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const iterRaw = Number(ctx.iteration);
  const iterStr = Number.isFinite(iterRaw) && iterRaw > 0
    ? String(iterRaw).padStart(3, '0')
    : '001';
  const vars = {
    pipelinename:   ctx.pipelineName || 'Pipeline',
    sourcefilename: (ctx.sourceFilename || 'data').replace(/\.csv$/i, ''),
    dropzonename:   ctx.dropZoneName || '',
    iteration:      iterStr,
    date:           dateStr,
    time:           timeStr,
  };
  return safeTpl.replace(/\{([a-zA-Z]+)\}/g, (whole, key) => {
    const v = vars[String(key).toLowerCase()];
    return v !== undefined ? v : whole;
  });
}

function parseCsv(filepath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;
    fs.createReadStream(filepath)
      // mapHeaders trims whitespace and strips BOM from every header name so
      // that mappings typed in the UI match even when the CSV came from Excel
      // (which often adds a UTF-8 BOM to the first column) or has trailing spaces.
      .pipe(csvParser({ mapHeaders: ({ header }) => header.trim().replace(/^﻿/, '') }))
      .on('headers', (h) => { headers = h; })
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve({ rows, headers: headers || (rows[0] ? Object.keys(rows[0]) : []) }))
      .on('error', reject);
  });
}

function applyColumnMappings(rows, mappings) {
  if (!mappings || !Object.keys(mappings).length) return rows;
  // Build a normalised lookup so matching is case-insensitive and
  // whitespace-tolerant. CSV headers often have invisible leading/trailing
  // spaces or BOM bytes; mapping keys entered by hand may differ in case.
  const normMap = {};
  for (const k of Object.keys(mappings)) {
    normMap[k.trim().toLowerCase()] = mappings[k];
  }
  return rows.map(row => {
    const out = {};
    for (const key of Object.keys(row)) {
      const norm   = key.trim().toLowerCase();
      const mapped = normMap[norm] || key;  // fall back to original key if no mapping
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
        //
        // If any formatting config is set on this rule (format/rounded/
        // currency...) we also emit a companion column `<targetColumn>_display`
        // with the formatted string. The raw column stays numeric for sort and
        // aggregation; the _display column is what designers bind in Figma
        // when they want the formatted view ("$50,000" vs 50000).
        const { sourceColumn, targetColumn } = cfg;
        if (!sourceColumn || !targetColumn) break;
        const fmt     = cfg.format     || 'plain';
        const code    = cfg.currencyCode || 'USD';
        const pos     = cfg.currencyPosition || 'before';
        const rounded = !!cfg.rounded;
        // Only produce a display column when there's something to format —
        // plain+no-rounding is identical to raw number. Avoid cluttering the
        // schema with a duplicate column in that case.
        const wantDisplay = fmt !== 'plain' || rounded;
        const displayCol  = wantDisplay ? `${targetColumn}_display` : null;

        rows = rows.map(row => {
          const out = { ...row };
          const num = extractFirstNumber(row[sourceColumn]);
          out[targetColumn] = num;
          if (displayCol) {
            out[displayCol] = num === null ? '' : formatTotal(num, fmt, code, pos, rounded);
          }
          return out;
        });
        if (!headers.includes(targetColumn)) headers = [...headers, targetColumn];
        if (displayCol && !headers.includes(displayCol)) headers = [...headers, displayCol];
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
          currencyPosition: cfg.currencyPosition || null, rounded: !!cfg.rounded,
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
          currencyPosition: cfg.currencyPosition || null, rounded: !!cfg.rounded,
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
          currencyPosition: cfg.currencyPosition || null, rounded: !!cfg.rounded,
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
          currencyPosition: cfg.currencyPosition || null, rounded: !!cfg.rounded,
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
          currencyPosition: cfg.currencyPosition || null, rounded: !!cfg.rounded,
        });
        break;
      }

      case 'country-code': {
        // Reads `sourceColumn`, looks up each value in `mapping` (an object of
        // { [rawValue]: countryCode }), and writes the result to `targetColumn`.
        // Values not found in the mapping are written as an empty string unless
        // `fallback` is set, in which case that string is used.
        // The new column is appended after the source column (or at the end).
        const { sourceColumn, targetColumn = 'country_code', mapping = {}, fallback = '' } = cfg;
        if (!sourceColumn) break;
        const insertAfter = headers.indexOf(sourceColumn);
        if (!headers.includes(targetColumn)) {
          if (insertAfter !== -1) {
            headers.splice(insertAfter + 1, 0, targetColumn);
          } else {
            headers.push(targetColumn);
          }
        }
        for (const row of rows) {
          const raw = String(row[sourceColumn] ?? '').trim();
          row[targetColumn] = mapping[raw] ?? mapping[raw.toLowerCase()] ?? fallback;
        }
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
//   - plain      → raw number, no commas, no currency          → 1234.56
//   - financial  → commas, negatives in parens, no currency    → 1,234.56 / (1,234.56)
//   - currency   → commas + currency symbol/code (position-aware)
//                  position=before → native locale symbol      → $1,234.56
//                  position=after  → ISO code with a space     → 1,234.56 MZN
//
// `rounded=true` strips the fraction digits (applies to financial and currency).
// `currencyPosition` defaults to 'before'. Ignored for plain/financial.
//
// Backward compat: the old 'currency-rounded' value is treated as currency
// with rounded=true so existing saved rules still format the same way.
function formatTotal(value, fmt, currencyCode, currencyPosition, rounded) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return value === undefined || value === null ? '' : String(value);
  }
  const code = currencyCode || 'USD';
  const pos  = currencyPosition === 'after' ? 'after' : 'before';

  // Legacy format key → new shape
  let effFmt = fmt;
  let effRounded = !!rounded;
  if (effFmt === 'currency-rounded') { effFmt = 'currency'; effRounded = true; }

  const frac = effRounded ? 0 : 2;
  const val  = effRounded ? Math.round(n) : n;

  try {
    switch (effFmt) {
      case 'plain':
        // No commas. Honour rounded even here (rare, but consistent).
        return String(effRounded ? Math.round(n) : n);
      case 'financial': {
        const body = new Intl.NumberFormat('en-US', {
          minimumFractionDigits: frac, maximumFractionDigits: frac,
        }).format(Math.abs(val));
        return n < 0 ? `(${body})` : body;
      }
      case 'currency': {
        if (pos === 'after') {
          // Number with commas + space + ISO code (e.g. "1,234.56 MZN").
          // Kept explicit so it works for any code regardless of whether Intl
          // has a locale-native symbol for it.
          const body = new Intl.NumberFormat('en-US', {
            minimumFractionDigits: frac, maximumFractionDigits: frac,
          }).format(val);
          return body + ' ' + code;
        }
        // Position: before → use locale currency style (produces native symbol
        // when one is known, falls back to the code otherwise).
        return new Intl.NumberFormat('en-US', {
          style: 'currency', currency: code,
          minimumFractionDigits: frac, maximumFractionDigits: frac,
        }).format(val);
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
    const fmt     = m.format || 'plain';
    const code    = m.currencyCode || 'USD';
    const pos     = m.currencyPosition || 'before';
    // Legacy 'currency-rounded' implies rounded=true regardless of the flag.
    const rounded = !!m.rounded || fmt === 'currency-rounded';

    if (m.type === 'count-by' && m.value && typeof m.value === 'object') {
      const entries = Object.entries(m.value)
        .map(([k, v]) => [k, Number(v) || 0])
        .sort((a, b) => b[1] - a[1]);
      for (const [key, count] of entries) {
        out.push({
          RULE:              `${baseName} · ${key || '(empty)'}`,
          TOTALS:            formatTotal(count, fmt, code, pos, rounded),
          TOTALS_raw:        count,
          TOTALS_format:     fmt,
          TOTALS_currency:   code,
          TOTALS_position:   pos,
          TOTALS_rounded:    rounded,
        });
      }
      continue;
    }

    const n = Number(m.value);
    const raw = Number.isFinite(n) ? n : (m.value ?? null);
    out.push({
      RULE:              baseName,
      TOTALS:            formatTotal(raw, fmt, code, pos, rounded),
      TOTALS_raw:        raw,
      TOTALS_format:     fmt,
      TOTALS_currency:   code,
      TOTALS_position:   pos,
      TOTALS_rounded:    rounded,
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

// Patch a dataset (rename / add a label / update hidden rows).
app.patch('/api/datasets/:id', async (req, res) => {
  try {
    const record = await getDataset(req.params.id);
    if (typeof req.body?.label === 'string') {
      record.label = req.body.label.trim() || null;
    }
    // hiddenRows: array of 0-based row indices to exclude from injection/export.
    // Accept null to clear all hidden rows.
    if (req.body && 'hiddenRows' in req.body) {
      const hr = req.body.hiddenRows;
      if (hr === null || hr === undefined) {
        record.hiddenRows = [];
      } else if (Array.isArray(hr)) {
        record.hiddenRows = hr.filter(n => typeof n === 'number' && Number.isFinite(n) && n >= 0).map(Math.floor);
      }
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
        hiddenRows: record.hiddenRows || [],
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

// Export full settings as a downloadable JSON file — use as a manual backup
// before committing so you can restore without rebuilding rules/mappings.
// Includes the full asset library (nodes + preview images + type summaries).
app.get('/api/settings/export', async (_req, res) => {
  try {
    const [s, pipelines] = await Promise.all([readSettings(), listPipelines()]);
    // Fetch full pipeline records (including nodes/edges) for the export
    const fullPipelines = await Promise.all(
      pipelines.map(p => getPipeline(p.id).catch(() => null))
    ).then(ps => ps.filter(Boolean));
    // Fetch full asset records (including nodes tree and preview images)
    let fullAssets = [];
    try {
      const assetFiles = (await fsp.readdir(ASSETS_DIR)).filter(f => f.endsWith('.json'));
      fullAssets = (await Promise.all(
        assetFiles.map(f => fsp.readFile(path.join(ASSETS_DIR, f), 'utf8')
          .then(raw => JSON.parse(raw)).catch(() => null))
      )).filter(Boolean);
    } catch (_) {}
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="smartico-backup-${stamp}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ settings: s, pipelines: fullPipelines, assets: fullAssets }, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import settings from a JSON file upload — restores rules, mappings, presets.
// Also writes a fresh seed file so the next cold deploy starts with this snapshot.
app.post('/api/settings/import', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Expected JSON body' });

    // Support both old format (bare settings object) and new format ({ settings, pipelines }).
    const settingsPayload  = body.settings || body;
    const pipelinesPayload = Array.isArray(body.pipelines) ? body.pipelines : [];

    const saved = await writeSettings(settingsPayload);
    // Keep the seed in sync so cold-start deploys get this snapshot.
    const seedFile = path.join(DATA_DIR, 'settings-seed.json');
    await fsp.writeFile(seedFile, JSON.stringify(saved, null, 2));

    // Restore pipelines — write each one back to its file.
    let restoredPipelines = 0;
    for (const p of pipelinesPayload) {
      if (!p || !p.id) continue;
      await savePipeline(p);
      restoredPipelines++;
    }

    // Restore assets if present in the backup
    let restoredAssets = 0;
    const assetsPayload = Array.isArray(body.assets) ? body.assets : [];
    for (const a of assetsPayload) {
      if (!a || !a.id || !a.nodes) continue;
      await fsp.writeFile(path.join(ASSETS_DIR, `${a.id}.json`), JSON.stringify(a, null, 2));
      restoredAssets++;
    }

    res.json({
      ok:               true,
      ruleSets:         (saved.ruleSets || []).length,
      mappingSets:      (saved.mappingSets || []).length,
      restoredPipelines,
      restoredAssets,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const current  = await readSettings();
    const incoming = normalizeSettings(req.body || {});
    const rewrites = buildMappingRewrites(current.columnMappings, incoming.columnMappings);

    // Start from what the client sent, then sweep its rule sets so any
    // references to now-renamed columns follow the mapping change.
    const next = {
      mappingSets:        incoming.mappingSets,
      activeMappingSetId: incoming.activeMappingSetId,
      columnPresets:      incoming.columnPresets,
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

// ── Mapping sets CRUD ───────────────────────────────────────────────────────
// Each set is a named bundle of {from: to} column mappings. The active set's
// mappings get applied at upload time. Switching the active set sweeps rule
// sets so any column references follow the rename — same logic the legacy
// settings POST used.
app.get('/api/mapping-sets', async (_req, res) => {
  const settings = await readSettings();
  res.json({
    mappingSets: settings.mappingSets || [],
    activeMappingSetId: settings.activeMappingSetId || null,
  });
});

app.post('/api/mapping-sets', async (req, res) => {
  try {
    const settings = await readSettings();
    const body = req.body || {};
    const newSet = {
      id:       `ms_${crypto.randomBytes(4).toString('hex')}`,
      name:     (body.name && String(body.name).trim()) || 'New mapping set',
      mappings: (body.mappings && typeof body.mappings === 'object') ? { ...body.mappings } : {},
    };
    const next = {
      ...settings,
      mappingSets: [...(settings.mappingSets || []), newSet],
      activeMappingSetId: settings.activeMappingSetId || newSet.id,
    };
    const saved = await writeSettings(next);
    res.status(201).json({ mappingSet: newSet, settings: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/mapping-sets/:id', async (req, res) => {
  try {
    const settings = await readSettings();
    const body = req.body || {};
    const sets = (settings.mappingSets || []).slice();
    const idx = sets.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Mapping set not found' });

    const before = sets[idx];
    const after  = {
      ...before,
      name:     body.name != null ? String(body.name).trim() || before.name : before.name,
      mappings: (body.mappings && typeof body.mappings === 'object') ? { ...body.mappings } : before.mappings,
    };
    sets[idx] = after;

    // If we're editing the active set, sweep rule-set column refs to follow
    // any renames the user just made.
    let rewrites = {};
    if (settings.activeMappingSetId === after.id) {
      rewrites = buildMappingRewrites(before.mappings, after.mappings);
    }

    const next = {
      ...settings,
      mappingSets: sets,
      ruleSets: sweepRuleSets(settings.ruleSets, rewrites),
    };
    const saved = await writeSettings(next);
    res.json({ mappingSet: after, settings: saved, rewrites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/mapping-sets/:id', async (req, res) => {
  try {
    const settings = await readSettings();
    const sets = (settings.mappingSets || []).filter(s => s.id !== req.params.id);
    if (sets.length === (settings.mappingSets || []).length) {
      return res.status(404).json({ error: 'Mapping set not found' });
    }
    let activeId = settings.activeMappingSetId;
    if (activeId === req.params.id) activeId = sets[0]?.id || null;
    const next = { ...settings, mappingSets: sets, activeMappingSetId: activeId };
    const saved = await writeSettings(next);
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Switch the active mapping set. Triggers a rule-set sweep so column refs
// follow the rename diff between the old and new active set.
app.post('/api/mapping-sets/:id/activate', async (req, res) => {
  try {
    const settings = await readSettings();
    const sets = settings.mappingSets || [];
    const next = sets.find(s => s.id === req.params.id);
    if (!next) return res.status(404).json({ error: 'Mapping set not found' });
    if (req.params.id === settings.activeMappingSetId) {
      return res.json({ ok: true, settings, rewrites: {} });
    }
    const before = sets.find(s => s.id === settings.activeMappingSetId);
    const rewrites = buildMappingRewrites(before ? before.mappings : {}, next.mappings);
    const updated = {
      ...settings,
      activeMappingSetId: req.params.id,
      ruleSets: sweepRuleSets(settings.ruleSets, rewrites),
    };
    const saved = await writeSettings(updated);
    res.json({ ok: true, settings: saved, rewrites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Column visibility presets CRUD ──────────────────────────────────────────
// Set (or clear) the default column preset that auto-applies on View tab load.
app.patch('/api/settings/default-column-preset', async (req, res) => {
  try {
    const settings = await readSettings();
    const { id } = req.body; // null to clear
    const next = { ...settings, defaultColumnPresetId: id || null };
    await writeSettings(next);
    res.json({ settings: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Each preset stores the columns to *hide*. Applied client-side on the View
// tab — server just persists the named list.
app.get('/api/column-presets', async (_req, res) => {
  const settings = await readSettings();
  res.json({ columnPresets: settings.columnPresets || [] });
});

app.post('/api/column-presets', async (req, res) => {
  try {
    const settings = await readSettings();
    const body = req.body || {};
    const newPreset = {
      id:     `cp_${crypto.randomBytes(4).toString('hex')}`,
      name:   (body.name && String(body.name).trim()) || 'New preset',
      hidden: Array.isArray(body.hidden) ? body.hidden.map(String) : [],
    };
    const next = { ...settings, columnPresets: [...(settings.columnPresets || []), newPreset] };
    const saved = await writeSettings(next);
    res.status(201).json({ columnPreset: newPreset, settings: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/column-presets/:id', async (req, res) => {
  try {
    const settings = await readSettings();
    const body = req.body || {};
    const list = (settings.columnPresets || []).slice();
    const idx = list.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Column preset not found' });
    const before = list[idx];
    list[idx] = {
      ...before,
      name:   body.name != null ? String(body.name).trim() || before.name : before.name,
      hidden: Array.isArray(body.hidden) ? body.hidden.map(String) : before.hidden,
    };
    const next = { ...settings, columnPresets: list };
    const saved = await writeSettings(next);
    res.json({ columnPreset: list[idx], settings: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/column-presets/:id', async (req, res) => {
  try {
    const settings = await readSettings();
    const list = (settings.columnPresets || []).filter(p => p.id !== req.params.id);
    if (list.length === (settings.columnPresets || []).length) {
      return res.status(404).json({ error: 'Column preset not found' });
    }
    const next = { ...settings, columnPresets: list };
    const saved = await writeSettings(next);
    res.json({ ok: true, settings: saved });
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

// ── Pipelines ────────────────────────────────────────────────────────────────
// A pipeline = an ordered chain of saved rule sets. Drop-zone cards on the
// dashboard run a pipeline against a CSV the user drops onto them.

// List pipelines (summaries only — no nodes/edges)
app.get('/api/pipelines', async (_req, res) => {
  try {
    res.json({ pipelines: await listPipelines() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single pipeline with its full node + edge graph.
app.get('/api/pipelines/:id', async (req, res) => {
  try {
    res.json(await getPipeline(req.params.id));
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Create a pipeline. Body: { name, description?, filenameTemplate?, nodes?, edges? }
app.post('/api/pipelines', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || typeof body.name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    const record = {
      id:               crypto.randomUUID(),
      name:             body.name,
      description:      typeof body.description === 'string' ? body.description : '',
      filenameTemplate: typeof body.filenameTemplate === 'string' && body.filenameTemplate.trim()
        ? body.filenameTemplate.trim()
        : '{dropZoneName} - {iteration} {date}',
      // Pin a specific mapping set or leave null to use the active one at run time.
      mappingSetId:     typeof body.mappingSetId === 'string' ? body.mappingSetId : null,
      // Optional column preset applied to the final output (drops hidden columns).
      columnPresetId:   typeof body.columnPresetId === 'string' ? body.columnPresetId : null,
      enrichAfterRun:   !!body.enrichAfterRun,
      // Show this pipeline as a dropzone card on the homepage / Figma dropdown.
      isDropzone:       !!body.isDropzone,
      // Cap rows sent to the Figma plugin (null = unlimited).
      outputRowLimit:   Number.isFinite(Number(body.outputRowLimit)) && Number(body.outputRowLimit) > 0
        ? Math.floor(Number(body.outputRowLimit))
        : null,
      nodes:            Array.isArray(body.nodes) ? body.nodes : [],
      edges:            Array.isArray(body.edges) ? body.edges : [],
    };
    await savePipeline(record);
    res.json({ pipeline: record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Patch a pipeline. Any of: name, description, filenameTemplate, nodes, edges.
app.patch('/api/pipelines/:id', async (req, res) => {
  try {
    const record = await getPipeline(req.params.id);
    const body   = req.body || {};
    if (typeof body.name === 'string') record.name = body.name;
    if (typeof body.description === 'string') record.description = body.description;
    if (typeof body.filenameTemplate === 'string') {
      record.filenameTemplate = body.filenameTemplate.trim() || '{pipelineName}';
    }
    // mappingSetId: explicit null clears the pin (revert to active set);
    // a string pins to that set; undefined leaves the existing value alone.
    if ('mappingSetId' in body) {
      record.mappingSetId = (typeof body.mappingSetId === 'string' && body.mappingSetId)
        ? body.mappingSetId
        : null;
    }
    // columnPresetId: same semantics — null clears, string pins.
    if ('columnPresetId' in body) {
      record.columnPresetId = (typeof body.columnPresetId === 'string' && body.columnPresetId)
        ? body.columnPresetId
        : null;
    }
    if (Array.isArray(body.nodes)) record.nodes = body.nodes;
    if (Array.isArray(body.edges)) record.edges = body.edges;
    if ('enrichAfterRun' in body) record.enrichAfterRun = !!body.enrichAfterRun;
    if ('isDropzone' in body)     record.isDropzone = !!body.isDropzone;
    if ('outputRowLimit' in body) {
      const n = Number(body.outputRowLimit);
      record.outputRowLimit = (Number.isFinite(n) && n > 0) ? Math.floor(n) : null;
    }
    if (body.bookends && typeof body.bookends === 'object') record.bookends = body.bookends;
    await savePipeline(record);
    res.json({ pipeline: record });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.delete('/api/pipelines/:id', async (req, res) => {
  try {
    await deletePipeline(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Run a pipeline against an uploaded CSV. Multipart form with field name 'file'.
// Steps: parse CSV → mapping → for each node in topo order, apply that rule
// set's rules (carry metrics across) → save as a processed dataset → return.
app.post('/api/pipelines/:id/run', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const pipeline = await getPipeline(req.params.id);
    const settings = await readSettings();

    // Optional drop-zone context. When the run is triggered by a Bridge drop
    // card the UI passes ?dropZoneId=… so we can (a) bump the card's run
    // counter and (b) expose {dropZoneName}/{iteration} to the filename
    // template. If the id refers to a zone that's been deleted, we don't blow
    // up the run — just fall back to the pipeline-only context.
    const dropZoneIdRaw = (req.body && (req.body.dropZoneId || req.body.dropzoneId)) || null;
    let dropZone = null;
    if (dropZoneIdRaw) {
      try {
        dropZone = await getDropZone(String(dropZoneIdRaw));
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn('[pipelines/run] drop-zone lookup failed:', e.message);
        dropZone = null;
      }
    }
    // Iteration increments on every run — against the drop zone when one is
    // present, otherwise against the pipeline itself so direct uploads also
    // get a monotonically increasing counter instead of always showing 001.
    const iteration = dropZone
      ? (Number.isFinite(Number(dropZone.runCount))   ? Number(dropZone.runCount)   : 0) + 1
      : (Number.isFinite(Number(pipeline.runCount))   ? Number(pipeline.runCount)   : 0) + 1;

    // Resolve which mapping set to use:
    //   pipeline.mappingSetId  → pinned set (override the active one for this run)
    //   null                   → fall back to settings.columnMappings (the active set)
    // If the pinned set was deleted we silently fall back to the active one
    // rather than blowing up — drop zones shouldn't fail because of an admin
    // deleting a mapping set.
    let runMappings = settings.columnMappings || {};
    let runMappingSetName = null;
    if (pipeline.mappingSetId) {
      const pinned = (settings.mappingSets || []).find(s => s.id === pipeline.mappingSetId);
      if (pinned) {
        runMappings = pinned.mappings || {};
        runMappingSetName = pinned.name;
      }
    }

    // 1. Parse the dropped CSV and apply column mappings.
    const parsed       = await parseCsv(req.file.path);
    const mappedRows   = applyColumnMappings(parsed.rows, runMappings);
    let mappedHeaders = mappedRows.length
      ? Object.keys(mappedRows[0])
      : parsed.headers.map(h => runMappings[h] || h);

    // 1b. Enrich player profiles BEFORE rules run (MAP → ENRICH → RULES).
    //     This gives rule sets access to avatar_image, display_name, phone etc.
    let enrichResult = null;
    if (pipeline.enrichAfterRun) {
      const tempRecord = { rows: mappedRows, headers: mappedHeaders };
      enrichResult = await enrichDataset(tempRecord, settings);
      // enrichDataset mutates tempRecord.rows in place AND updates tempRecord.headers
      // to include enriched columns (profile_name, avatar, avatar_image, phone).
      mappedHeaders = tempRecord.headers;
    }

    // 2. Order the pipeline nodes — bail out cleanly on cycles or unknown rule sets.
    let ordered;
    try {
      ordered = orderPipelineNodes(pipeline.nodes || [], pipeline.edges || []);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // 3. Walk the chain. For each step, look up the rule set and run it against
    // the rows produced by the previous step. Metrics from every step are
    // concatenated in run order so the {RULE,TOTALS} table reflects the chain
    // as it ran (so e.g. a "count of winners" computed late still appears).
    let rows    = mappedRows;
    let headers = mappedHeaders;
    const allMetrics = [];
    const stepLog = [];
    for (const node of ordered) {
      const ruleSet = findRuleSet(settings, node.ruleSetId);
      if (!ruleSet) {
        return res.status(400).json({
          error: `Pipeline references missing rule set ${node.ruleSetId} (node ${node.id}). Edit the pipeline and re-link the step.`,
        });
      }
      const out = applyRules(rows, headers, ruleSet.rules || []);
      rows    = out.rows;
      headers = out.headers;
      if (Array.isArray(out.metrics)) {
        for (const m of out.metrics) allMetrics.push({ ...m, _stepRuleSet: ruleSet.name });
      }
      stepLog.push({ nodeId: node.id, ruleSetId: ruleSet.id, ruleSetName: ruleSet.name, ruleCount: (ruleSet.rules || []).length });
    }

    const ruleTable = buildRuleTable(allMetrics);

    // 3b. Apply the optional column-preset filter — drops columns from the
    // final output before save. The RULE/TOTALS table is built from the
    // metrics produced during the rule-set chain so it's unaffected.
    let columnPresetName = null;
    if (pipeline.columnPresetId) {
      const preset = (settings.columnPresets || []).find(cp => cp.id === pipeline.columnPresetId);
      if (preset && Array.isArray(preset.hidden) && preset.hidden.length) {
        const hidden = new Set(preset.hidden);
        headers = headers.filter(h => !hidden.has(h));
        rows = rows.map(row => {
          const out = {};
          for (const h of headers) out[h] = row[h];
          return out;
        });
        columnPresetName = preset.name;
      } else if (preset) {
        columnPresetName = preset.name;
      }
    }

    // 4. Build the processed dataset record and save it. Filename template is
    // resolved against the source CSV name + pipeline name + date/time tokens
    // and (when triggered via a drop card) the drop-zone name + run counter.
    const filenameLabel = renderFilenameTemplate(pipeline.filenameTemplate, {
      pipelineName:   pipeline.name,
      sourceFilename: req.file.originalname,
      dropZoneName:   dropZone ? dropZone.name : '',
      iteration:      iteration,
    });

    // Persist the bumped iteration counter back onto the drop-zone record so the
    // next drop renders the next number. We do this AFTER the run succeeds —
    // failed runs shouldn't burn iteration numbers.
    if (dropZone) {
      dropZone.runCount = iteration;
      try { await saveDropZone(dropZone); } catch (e) {
        console.warn('[pipelines/run] saving drop-zone runCount failed:', e.message);
      }
    } else {
      // Direct upload — bump the pipeline's own counter
      pipeline.runCount = iteration;
      try { await savePipeline(pipeline); } catch (e) {
        console.warn('[pipelines/run] saving pipeline runCount failed:', e.message);
      }
    }

    const processed = {
      id:              crypto.randomUUID(),
      filename:        `${filenameLabel}.csv`,
      label:           filenameLabel,
      storedAs:        null,
      uploadedAt:      new Date().toISOString(),
      rowCount:        rows.length,
      headers,
      rows,
      isProcessed:    true,
      sourceDatasetId: null,
      sourceFilename:  req.file.originalname,
      pipelineId:      pipeline.id,
      pipelineName:    pipeline.name,
      mappingSetId:    pipeline.mappingSetId || settings.activeMappingSetId || null,
      mappingSetName:  runMappingSetName || null,
      columnPresetId:  pipeline.columnPresetId || null,
      columnPresetName: columnPresetName,
      ruleSetId:       null,
      ruleSetName:     ordered.length === 1 ? stepLog[0].ruleSetName : `${ordered.length} steps`,
      pipelineSteps:   stepLog,
      enrichment:      enrichResult,   // null if enrich not enabled
      metrics:         allMetrics,
      ruleTable,
      visibleColumns:  headers,
      maxRows:         null,
      sort:            null,
    };
    processed.summary = computeSummary(processed);
    await saveDataset(processed);

    res.json({
      ok:      true,
      dataset: {
        id:           processed.id,
        filename:     processed.filename,
        label:        processed.label,
        uploadedAt:   processed.uploadedAt,
        rowCount:     processed.rowCount,
        headers:      processed.headers,
        pipelineId:   processed.pipelineId,
        pipelineName: processed.pipelineName,
        steps:        stepLog,
        ruleTable:    processed.ruleTable,
      },
    });
  } catch (err) {
    console.error('[pipelines/run] error:', err);
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Drop zones ───────────────────────────────────────────────────────────────
// Drop zones are persisted cards on the dashboard, each linked to one pipeline.
// Drag a CSV onto a card → POST /api/pipelines/:pipelineId/run.

app.get('/api/dropzones', async (_req, res) => {
  try {
    res.json({ dropzones: await listDropZones() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dropzones', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name || typeof body.name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    const existing = await listDropZones();
    const record = {
      id:         crypto.randomUUID(),
      name:       body.name,
      pipelineId: body.pipelineId || null,
      // Append to the end of the list by default; UI can patch position later.
      position:   Number.isFinite(Number(body.position)) ? Number(body.position) : existing.length,
      // Iteration counter — bumps on each successful pipeline run from this card.
      // Surfaced to filename templates as {iteration} (zero-padded to 3 digits).
      runCount:   0,
    };
    await saveDropZone(record);
    res.json({ dropzone: record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/dropzones/:id', async (req, res) => {
  try {
    const record = await getDropZone(req.params.id);
    const body   = req.body || {};
    if (typeof body.name === 'string') record.name = body.name;
    if ('pipelineId' in body) record.pipelineId = body.pipelineId || null;
    if (Number.isFinite(Number(body.position))) record.position = Number(body.position);
    // Allow explicit reset / override of the run counter (e.g. "reset to 1").
    if ('runCount' in body) {
      const n = Number(body.runCount);
      record.runCount = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }
    await saveDropZone(record);
    res.json({ dropzone: record });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.delete('/api/dropzones/:id', async (req, res) => {
  try {
    await deleteDropZone(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Asset library ────────────────────────────────────────────────────────────
// Stores serialised Figma node trees so designers can save selections from the
// plugin and restore them onto the canvas later.
//   GET    /api/assets          — list all saved assets (metadata only)
//   POST   /api/assets          — save a new asset (full node tree in body)
//   GET    /api/assets/:id      — fetch a single asset with full node data
//   DELETE /api/assets/:id      — delete an asset

app.get('/api/assets', async (_req, res) => {
  try {
    const files = (await fsp.readdir(ASSETS_DIR)).filter(f => f.endsWith('.json'));
    const list = [];
    for (const f of files) {
      try {
        const raw = await fsp.readFile(path.join(ASSETS_DIR, f), 'utf8');
        const r = JSON.parse(raw);
        list.push({ id: r.id, name: r.name, type: r.type, nodeCount: r.nodeCount || 1, typeSummary: r.typeSummary || null, savedAt: r.savedAt, preview: r.preview || null, category: r.category || 'General', exportSettings: r.exportSettings || null });
      } catch (_) {}
    }
    list.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    res.json({ assets: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/assets', express.json({ limit: '30mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.nodes) return res.status(400).json({ error: 'nodes is required' });
    const record = {
      id:        crypto.randomUUID(),
      name:      typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled asset',
      type:      typeof body.type === 'string' ? body.type : 'FRAME',
      nodeCount:   typeof body.nodeCount === 'number' ? body.nodeCount : 1,
      typeSummary: typeof body.typeSummary === 'string' ? body.typeSummary : null,
      nodes:       body.nodes,
      preview:     typeof body.preview === 'string' ? body.preview : null,
      savedAt:     new Date().toISOString(),
      category:       typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'General',
      exportSettings: body.exportSettings && typeof body.exportSettings === 'object' ? body.exportSettings : null,
    };
    await fsp.writeFile(path.join(ASSETS_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
    res.json({ asset: { id: record.id, name: record.name, type: record.type, nodeCount: record.nodeCount, typeSummary: record.typeSummary, savedAt: record.savedAt, category: record.category, exportSettings: record.exportSettings } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/assets/:id', async (req, res) => {
  try {
    const raw = await fsp.readFile(path.join(ASSETS_DIR, `${req.params.id}.json`), 'utf8');
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.message });
  }
});

app.patch('/api/assets/:id', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const filePath = path.join(ASSETS_DIR, `${req.params.id}.json`);
    const raw = await fsp.readFile(filePath, 'utf8');
    const record = JSON.parse(raw);
    if (typeof req.body.name === 'string' && req.body.name.trim()) record.name = req.body.name.trim();
    if (typeof req.body.category === 'string' && req.body.category.trim()) record.category = req.body.category.trim();
    await fsp.writeFile(filePath, JSON.stringify(record, null, 2));
    res.json({ ok: true, id: record.id, name: record.name, category: record.category });
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.message });
  }
});

app.delete('/api/assets/:id', async (req, res) => {
  try {
    await fsp.unlink(path.join(ASSETS_DIR, `${req.params.id}.json`));
    res.json({ ok: true });
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.message });
  }
});

// ── Image proxy ──────────────────────────────────────────────────────────────
// The Figma plugin UI iframe cannot fetch cross-origin images (CORS). This
// endpoint fetches any image server-side (no CORS restriction) and streams it
// back to the plugin, letting it obtain bytes for figma.createImage().
//   GET /api/proxy-image?url=https%3A%2F%2F...
app.get('/api/proxy-image', async (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: 'url query param required (must start with http)' });
  }
  try {
    const response = await fetch(target, {
      headers: { 'User-Agent': 'Smartico-Bridge-Proxy/1.0' },
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      return res.status(502).json({ error: `Remote returned ${response.status}` });
    }
    const ct = response.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache — avatars don't change often
    const buf = await response.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(502).json({ error: 'Proxy fetch failed: ' + err.message });
  }
});

// Download the Figma plugin as a ZIP archive.
app.get('/api/plugin/download', (_req, res) => {
  const archiver = require('archiver');
  const pluginDir = path.join(__dirname, 'figma-plugin');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="smartico-bridge-plugin.zip"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { console.error('[plugin-download]', err); res.end(); });
  archive.pipe(res);
  archive.directory(pluginDir, 'smartico-bridge');
  archive.finalize();
});

// Health snapshot for the Firewatch widget.
app.get('/api/health', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [datasets, settings, pipelines, dropzones] = await Promise.all([
      listDatasets(), readSettings(), listPipelines(), listDropZones(),
    ]);
    const processed = datasets.filter(d => d.isProcessed);
    const latest    = datasets[0] || null;
    const latestProcessed = processed[0] || null;

    // Recent processed datasets (last 5) for the widget list
    const recentProcessed = processed.slice(0, 5).map(d => ({
      id:          d.id,
      label:       d.label || d.filename,
      rowCount:    d.rowCount,
      uploadedAt:  d.uploadedAt,
      pipelineName: d.pipelineName || null,
      headers:     (d.headers || []).length,
    }));

    res.json({
      ok: true,
      service: 'smartico-bridge',
      uptimeSec: Math.round(process.uptime()),
      datasets: {
        total:     datasets.length,
        processed: processed.length,
        latest: latest
          ? {
              id:          latest.id,
              label:       latest.label || latest.filename,
              uploadedAt:  latest.uploadedAt,
              rowCount:    latest.rowCount,
              isProcessed: latest.isProcessed || false,
              ruleSetName: latest.ruleSetName || null,
              pipelineName: latest.pipelineName || null,
            }
          : null,
        latestProcessed: latestProcessed
          ? {
              id:          latestProcessed.id,
              label:       latestProcessed.label || latestProcessed.filename,
              uploadedAt:  latestProcessed.uploadedAt,
              rowCount:    latestProcessed.rowCount,
              pipelineName: latestProcessed.pipelineName || null,
              headers:     (latestProcessed.headers || []).length,
            }
          : null,
        recentProcessed,
      },
      pipelines: {
        total: pipelines.length,
        names: pipelines.slice(0, 5).map(p => p.name),
      },
      dropzones: {
        total: dropzones.length,
      },
      ruleSets: {
        total: (settings.ruleSets || []).length,
        names: (settings.ruleSets || []).map(r => r.name),
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// EXTERNAL PUSH API  — lets the main 888africa website POST data directly
// into the Bridge without going through the CSV upload flow.
//
// Authentication: every request must carry  X-Bridge-Key: <key>  header.
// The key is stored in settings.json under  externalApiKey.
// Generate one via  POST /api/external/generate-key  (no auth needed once —
// do this once from the dashboard during setup, then store the key safely).
//
// Typical flow from the main site:
//   POST /api/external/push-data
//   Content-Type: application/json
//   X-Bridge-Key: <key>
//   { "pipelineId": "abc123", "label": "Winners Jan 2025",
//     "rows": [ { "PID": "123", "name": "Alice", ... }, ... ] }
// ════════════════════════════════════════════════════════════════════════════

// Middleware: verify X-Bridge-Key header against stored key.
async function requireBridgeKey(req, res, next) {
  const s = await readSettings().catch(() => ({}));
  const stored = s.externalApiKey;
  if (!stored) return res.status(401).json({ error: 'No API key configured. POST /api/external/generate-key first.' });
  const supplied = req.headers['x-bridge-key'];
  if (!supplied || supplied !== stored) return res.status(403).json({ error: 'Invalid or missing X-Bridge-Key header.' });
  next();
}

// One-time key generation — call this from the dashboard setup page.
// Returns the generated key so you can copy it into your main website config.
app.post('/api/external/generate-key', express.json(), async (req, res) => {
  try {
    const s = await readSettings();
    const key = require('crypto').randomBytes(32).toString('hex');
    s.externalApiKey = key;
    await writeSettings(s);
    res.json({ ok: true, key, message: 'Store this key in your main website config as X-Bridge-Key. It will not be shown again.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reveal whether a key exists (not the key itself).
app.get('/api/external/key-status', async (_req, res) => {
  try {
    const s = await readSettings();
    res.json({ configured: !!s.externalApiKey });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Main push endpoint — receives JSON rows from the main website.
//
// Body schema:
//   pipelineId  string   optional — run the rows through this pipeline
//   label       string   optional — human label for the resulting dataset
//   rows        array    required — array of plain objects (one per row)
//
// On success the rows are stored as a new dataset (and optionally processed
// through a pipeline), exactly as if a CSV had been uploaded.
app.post('/api/external/push-data', express.json({ limit: '20mb' }), requireBridgeKey, async (req, res) => {
  try {
    const { rows, label, pipelineId } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: '`rows` must be a non-empty array.' });

    // Derive headers from the union of all row keys (preserves first-row order).
    const headerSet = new Set();
    for (const row of rows) for (const k of Object.keys(row)) headerSet.add(k);
    const headers = [...headerSet];

    // Normalise every row to the full header set (fill missing with '').
    const normRows = rows.map(row => {
      const out = {};
      for (const h of headers) out[h] = row[h] !== undefined ? String(row[h]) : '';
      return out;
    });

    // Persist as a raw dataset.
    const dsId  = require('crypto').randomUUID();
    const dsDir = path.join(DATA_DIR, 'datasets', dsId);
    await fs.mkdir(dsDir, { recursive: true });

    const meta = {
      id: dsId,
      label: label || `Push ${new Date().toISOString().slice(0, 10)}`,
      filename: 'push.json',
      rowCount: normRows.length,
      headers,
      uploadedAt: new Date().toISOString(),
      isProcessed: false,
      source: 'external-push',
      pipelineId: pipelineId || null,
    };
    await fs.writeFile(path.join(dsDir, 'meta.json'), JSON.stringify(meta, null, 2));
    await fs.writeFile(path.join(dsDir, 'raw.json'),  JSON.stringify(normRows, null, 2));

    // Validate the pipelineId if supplied (so the caller gets a clear error
    // rather than a silent mismatch when they later run the pipeline).
    if (pipelineId) {
      try { await getPipeline(pipelineId); }
      catch (_) { return res.status(400).json({ error: `Pipeline "${pipelineId}" not found.` }); }
    }

    res.json({
      ok:        true,
      datasetId: dsId,
      rowCount:  normRows.length,
      note:      pipelineId
        ? `Data saved. Run pipeline "${pipelineId}" from the dashboard to process it.`
        : 'Data saved as a raw dataset. Assign and run a pipeline from the dashboard.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ════════════════════════════════════════════════════════════════════════════
// DIRECT INJECT — push pre-processed rows straight to the Figma plugin,
// bypassing all pipeline rules, column mappings, and filters.
//
//   POST /api/pipelines/:id/inject
//   Header:  X-Bridge-Key: <your-api-key>
//   Body:    { "rows": [...], "label": "optional name" }
//
// Use this when your source system has already done the transformations and
// you just need the data to appear under this pipeline in the Figma plugin.
// The rows are saved as a processed dataset immediately — no rules are applied.
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/pipelines/:id/inject', express.json({ limit: '20mb' }), requireBridgeKey, async (req, res) => {
  try {
    const pipeline = await getPipeline(req.params.id);
    const { rows, label } = req.body || {};
    if (!Array.isArray(rows) || !rows.length)
      return res.status(400).json({ error: '`rows` must be a non-empty array of objects.' });

    // Derive column headers from the union of all row keys.
    const headerSet = new Set();
    for (const row of rows) for (const k of Object.keys(row)) headerSet.add(k);
    const headers = [...headerSet];

    // Normalise every row to the full header set (fill missing fields with '').
    const normRows = rows.map(row => {
      const out = {};
      for (const h of headers) out[h] = row[h] !== undefined ? String(row[h]) : '';
      return out;
    });

    const dsId  = require('crypto').randomUUID();
    const ts    = new Date().toISOString();
    const record = {
      id:           dsId,
      label:        label || `${pipeline.name} — ${ts.slice(0, 10)}`,
      filename:     'inject.json',
      rowCount:     normRows.length,
      headers,
      rows:         normRows,
      uploadedAt:   ts,
      isProcessed:  true,          // makes it visible to the Figma plugin immediately
      source:       'direct-inject',
      pipelineId:   pipeline.id,
      pipelineName: pipeline.name,
      metrics:      [],
      ruleTable:    [],
    };

    await saveDataset(record);

    res.json({
      ok:        true,
      datasetId: dsId,
      rowCount:  normRows.length,
      label:     record.label,
      note:      `Dataset is live in the Figma plugin under "${pipeline.name}".`,
    });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: `Pipeline "${req.params.id}" not found.` });
    res.status(500).json({ error: e.message });
  }
});


// ════════════════════════════════════════════════════════════════════════════
// PIPELINE DESCRIBER — plain-English + SQL summary of what a pipeline does.
//
//   GET /api/pipelines/:id/describe
//
// Returns a JSON object with:
//   title       — pipeline name
//   summary     — one-paragraph plain-English overview
//   steps[]     — per-rule-set steps, each with:
//       name        — rule set name
//       english     — plain-English description of what this step does
//       sql         — approximate SQL that would produce the same result
// ════════════════════════════════════════════════════════════════════════════

// Returns { english, sql, outputColumns } for a single rule.
// outputColumns lists columns added/removed so the caller can track lineage.
function describeRule(rule) {
  const cfg = rule.config || {};
  const q   = s => `"${s}"`;  // double-quote column names (ANSI SQL standard)

  switch (rule.type) {

    case 'rename':
      return {
        english: `Rename column ${q(cfg.from)} to ${q(cfg.to)}. ` +
          `All existing values are preserved — only the column header changes. ` +
          `Any downstream step should reference the column as ${q(cfg.to)}.`,
        sql: `-- Rename: "${cfg.from}" → "${cfg.to}"\n` +
          `SELECT\n  * EXCEPT(${q(cfg.from)}),\n  ${q(cfg.from)} AS ${q(cfg.to)}\nFROM data;`,
        adds:    [cfg.to],
        removes: [cfg.from],
      };

    case 'sort': {
      const dir = cfg.direction === 'desc' ? 'DESC' : 'ASC';
      const dirLabel = cfg.direction === 'desc' ? 'descending (highest first)' : 'ascending (lowest first)';
      return {
        english: `Sort all rows by ${q(cfg.column)} in ${dirLabel} order. ` +
          `Row count and columns are unchanged — only the row order changes. ` +
          `This determines the order rows appear in Figma templates (row 1 = first place, etc.).`,
        sql: `-- Sort by "${cfg.column}" ${dir}\nSELECT * FROM data\nORDER BY ${q(cfg.column)} ${dir};`,
        adds: [], removes: [],
      };
    }

    case 'select-columns': {
      const cols = (cfg.columns || []);
      return {
        english: `Keep only the following ${cols.length} column${cols.length === 1 ? '' : 's'} and drop all others: ` +
          cols.map(c => q(c)).join(', ') + '. ' +
          `This is a column-level filter — row count is unchanged. ` +
          `If the database query already returns only these columns, this step is unnecessary.`,
        sql: `-- Select specific columns only\nSELECT\n  ${cols.map(q).join(',\n  ')}\nFROM data;`,
        adds: [], removes: ['(all columns not in the list above)'],
      };
    }

    case 'extract-number': {
      const hasFmt   = cfg.format && cfg.format !== 'plain';
      const dispCol  = `${cfg.targetColumn}_display`;
      const fmtDesc  = hasFmt
        ? ` A human-readable formatted version (${cfg.format} style${cfg.currencyCode ? ', currency: ' + cfg.currencyCode : ''}) ` +
          `is also stored in a second new column ${q(dispCol)}.`
        : '';
      return {
        english: `Read ${q(cfg.sourceColumn)}, strip any currency symbols, spaces, and thousand-separator commas, ` +
          `then cast the result to a numeric value and store it in a new column ${q(cfg.targetColumn)}.${fmtDesc} ` +
          `If the source column already contains clean numeric values in the database, output it directly as ${q(cfg.targetColumn)} ` +
          `(and optionally format it as ${q(dispCol)}).`,
        sql: `-- Extract numeric value from "${cfg.sourceColumn}"\nSELECT\n  *,\n` +
          `  CAST(REGEXP_REPLACE(${q(cfg.sourceColumn)}, '[^0-9.\\-]', '', 'g') AS NUMERIC) AS ${q(cfg.targetColumn)}` +
          (hasFmt ? `,\n  -- formatted display (apply your locale formatting):\n  TO_CHAR(CAST(REGEXP_REPLACE(${q(cfg.sourceColumn)}, '[^0-9.\\-]', '', 'g') AS NUMERIC), 'FM999,999,990.00') AS ${q(dispCol)}` : '') +
          `\nFROM data;`,
        adds: hasFmt ? [cfg.targetColumn, dispCol] : [cfg.targetColumn],
        removes: [],
      };
    }

    case 'count': {
      const exact = cfg.matchMode === 'exact';
      const pred  = exact ? `= '${cfg.value}'` : `LIKE '%${cfg.value}%'`;
      return {
        english: `Count rows where ${q(cfg.column)} ${exact ? `exactly equals "${cfg.value}"` : `contains "${cfg.value}"`}. ` +
          `The result is a single integer metric (not a row-level column). ` +
          `In the database this can be computed as a scalar subquery and returned alongside the main result set.`,
        sql: `-- Metric: count rows matching "${cfg.value}" in "${cfg.column}"\nSELECT COUNT(*) AS metric_count\nFROM data\nWHERE ${q(cfg.column)} ${pred};`,
        adds: [], removes: [],
      };
    }

    case 'count-times': {
      const exact = cfg.matchMode === 'exact';
      const pred  = exact ? `= '${cfg.value}'` : `LIKE '%${cfg.value}%'`;
      return {
        english: `Count rows where ${q(cfg.column)} ${exact ? `exactly equals "${cfg.value}"` : `contains "${cfg.value}"`}, ` +
          `then multiply that count by ${cfg.multiplier}. ` +
          `The result is a single numeric metric. ` +
          `Use this when a row represents multiple units (e.g. each entry equals ${cfg.multiplier} points).`,
        sql: `-- Metric: count × ${cfg.multiplier} for "${cfg.value}" in "${cfg.column}"\nSELECT COUNT(*) * ${cfg.multiplier} AS metric_value\nFROM data\nWHERE ${q(cfg.column)} ${pred};`,
        adds: [], removes: [],
      };
    }

    case 'sum':
      return {
        english: `Sum all values in ${q(cfg.column)}. ` +
          `The column must contain numeric data (or data cleaned by an extract-number step). ` +
          `The result is a single numeric metric — the grand total of that column across all rows.`,
        sql: `-- Metric: sum of "${cfg.column}"\nSELECT SUM(CAST(${q(cfg.column)} AS NUMERIC)) AS metric_sum\nFROM data;`,
        adds: [], removes: [],
      };

    case 'avg':
      return {
        english: `Calculate the arithmetic mean of ${q(cfg.column)} across all rows. ` +
          `The result is a single numeric metric. NULL / empty values are excluded from the average.`,
        sql: `-- Metric: average of "${cfg.column}"\nSELECT AVG(CAST(${q(cfg.column)} AS NUMERIC)) AS metric_avg\nFROM data\nWHERE ${q(cfg.column)} IS NOT NULL AND ${q(cfg.column)} <> '';`,
        adds: [], removes: [],
      };

    case 'min':
      return {
        english: `Find the minimum (smallest) value in ${q(cfg.column)} across all rows. ` +
          `The result is a single metric — useful for showing the lowest score, earliest date, etc.`,
        sql: `-- Metric: minimum of "${cfg.column}"\nSELECT MIN(CAST(${q(cfg.column)} AS NUMERIC)) AS metric_min\nFROM data;`,
        adds: [], removes: [],
      };

    case 'max':
      return {
        english: `Find the maximum (largest) value in ${q(cfg.column)} across all rows. ` +
          `The result is a single metric — useful for showing the top score, latest date, etc.`,
        sql: `-- Metric: maximum of "${cfg.column}"\nSELECT MAX(CAST(${q(cfg.column)} AS NUMERIC)) AS metric_max\nFROM data;`,
        adds: [], removes: [],
      };

    case 'count-by': {
      return {
        english: `Group rows by the distinct values in ${q(cfg.column)} and count how many rows fall into each group. ` +
          `The result is a breakdown table (multiple rows: one per distinct value). ` +
          `This is returned as a metric object — the database should return this as a separate result set ` +
          `or a JSON aggregation alongside the main rows.`,
        sql: `-- Metric: row count grouped by "${cfg.column}"\nSELECT\n  ${q(cfg.column)},\n  COUNT(*) AS count\nFROM data\nGROUP BY ${q(cfg.column)}\nORDER BY count DESC;`,
        adds: [], removes: [],
      };
    }

    case 'aggregate-metrics': {
      const op    = (cfg.op || 'sum').toUpperCase();
      const ids   = (cfg.ruleIds || []);
      return {
        english: `Combine the numeric results of ${ids.length} earlier metric${ids.length === 1 ? '' : 's'} using ${op}. ` +
          `This does not operate on the row data directly — it aggregates previously computed scalar metric values ` +
          `into a single rolled-up number. If the database is computing all metrics natively, ` +
          `replace this with: ${op}(metric_a, metric_b, ...).`,
        sql: `-- Aggregate previously computed metric values using ${op}\n` +
          `-- Replace metric_a, metric_b, ... with the actual computed values from earlier steps.\nSELECT ${op}(v) AS aggregated_metric\nFROM (VALUES\n  (metric_a),\n  (metric_b)\n) AS t(v);`,
        adds: [], removes: [],
      };
    }

    case 'country-code': {
      const entries = Object.entries(cfg.mapping || {});
      const mappingLines = entries.slice(0, 8).map(([k, v]) => `  '${k}' → '${v}'`).join('\n');
      const more = entries.length > 8 ? `\n  ... and ${entries.length - 8} more` : '';
      const fallback = cfg.fallback || '';
      return {
        english: `Look up each value in ${q(cfg.sourceColumn)} against the mapping table below and write the result into a new column ${q(cfg.targetColumn || 'country_code')}. ` +
          `Values not found in the table are set to "${fallback || '(empty string)'}".\n\nMapping (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}):\n${mappingLines}${more}`,
        sql: `-- Country-code lookup: "${cfg.sourceColumn}" → "${cfg.targetColumn || 'country_code'}"\n` +
          `-- Create a VALUES-based lookup table with all ${entries.length} mapping entries:\nWITH country_map(raw, code) AS (\n  VALUES\n` +
          entries.map(([k, v]) => `    (LOWER('${k}'), '${v}')`).join(',\n') +
          `\n)\nSELECT\n  d.*,\n  COALESCE(cm.code, '${fallback}') AS ${q(cfg.targetColumn || 'country_code')}\nFROM data d\nLEFT JOIN country_map cm\n  ON LOWER(d.${q(cfg.sourceColumn)}) = cm.raw;`,
        adds: [cfg.targetColumn || 'country_code'],
        removes: [],
      };
    }

    default:
      return {
        english: `Apply rule "${rule.name || rule.type}" (type: ${rule.type}).`,
        sql: `-- Rule type "${rule.type}" has no SQL equivalent defined.`,
        adds: [], removes: [],
      };
  }
}

app.get('/api/pipelines/:id/describe', async (req, res) => {
  const q = col => `"${col}"`;  // ANSI SQL double-quote column names
  try {
    const pipeline = await getPipeline(req.params.id);
    const s        = await readSettings();
    const allRS    = s.ruleSets || [];

    // Resolve which mapping set applies to this pipeline.
    let activeMappings     = s.columnMappings || {};
    let activeMappingName  = 'Active mapping set (configured in Settings)';
    if (pipeline.mappingSetId) {
      const pinned = (s.mappingSets || []).find(m => m.id === pipeline.mappingSetId);
      if (pinned) { activeMappings = pinned.mappings || {}; activeMappingName = pinned.name; }
    }
    const mappingEntries = Object.entries(activeMappings).filter(([k, v]) => k !== v && v);

    // Resolve column filter preset.
    let filterCols     = null;
    let filterPreset   = null;
    if (pipeline.columnFilterPresetId) {
      const preset = (s.columnPresets || []).find(p => p.id === pipeline.columnFilterPresetId);
      if (preset) { filterCols = preset.columns || []; filterPreset = preset.name; }
    }

    // Walk the pipeline nodes in topological order.
    const ordered = orderPipelineNodes(pipeline.nodes || [], pipeline.edges || []);

    const steps = [];
    for (const node of ordered) {
      const rs = allRS.find(r => r.id === node.ruleSetId);
      if (!rs) continue;

      const rules = (rs.rules || []).map((rule, idx) => {
        const d = describeRule(rule);
        return {
          index:   idx + 1,
          name:    rule.name || rule.type,
          type:    rule.type,
          english: d.english,
          sql:     d.sql,
          adds:    d.adds    || [],
          removes: d.removes || [],
        };
      });

      // Plain-English step summary — one paragraph per rule, clearly numbered.
      const stepEnglish = rules.length === 0
        ? `Step "${rs.name}" has no rules configured yet.`
        : `Step "${rs.name}" (${rules.length} rule${rules.length === 1 ? '' : 's'}):\n` +
          rules.map(r => `  ${r.index}. ${r.english}`).join('\n');

      // Per-step SQL block (each rule on its own labelled query).
      const stepSql = rules.length === 0
        ? `-- Step "${rs.name}": no rules configured.`
        : `-- ─── Step: ${rs.name} ${'─'.repeat(Math.max(0, 50 - rs.name.length))}\n\n` +
          rules.map(r => `${r.sql}`).join('\n\n');

      steps.push({
        stepNumber: steps.length + 1,
        ruleSetId:  rs.id,
        name:       rs.name,
        ruleCount:  rules.length,
        english:    stepEnglish,
        sql:        stepSql,
        rules,
      });
    }

    // ── Column mapping section ───────────────────────────────────────────────
    let mappingEnglish = '';
    let mappingSql     = '';
    if (mappingEntries.length > 0) {
      mappingEnglish =
        `Before any rule steps run, the following column renames (mappings) are applied to normalise ` +
        `incoming column names from the source data:\n` +
        mappingEntries.map(([from, to]) => `  "${from}" → "${to}"`).join('\n') + '\n' +
        `Mapping set: "${activeMappingName}". ` +
        `If the database query already outputs columns with the final names, this step can be skipped.`;
      mappingSql =
        `-- ─── Column Mapping: ${activeMappingName} ${'─'.repeat(Math.max(0, 40 - activeMappingName.length))}\n` +
        `-- Rename source columns to match the pipeline's expected names.\nSELECT\n` +
        mappingEntries.map(([from, to]) => `  ${q(from)} AS ${q(to)}`).join(',\n') +
        `,\n  * EXCEPT(${mappingEntries.map(([from]) => q(from)).join(', ')})\nFROM source_data;`;
    }

    // ── Enrichment section ───────────────────────────────────────────────────
    let enrichEnglish = '';
    if (pipeline.enrichAfterRun) {
      enrichEnglish =
        `After column mapping and before any rule steps, the pipeline enriches each row with player ` +
        `profile data by looking up the player ID against the 888 profile API. ` +
        `Four columns are added to every row:\n` +
        `  "profile_name"  — player's display name\n` +
        `  "avatar"        — avatar URL (thumbnail)\n` +
        `  "avatar_image"  — full-resolution avatar URL\n` +
        `  "phone"         — player's phone number\n` +
        `If the database owns the player data, JOIN to the player/profile table on the player ID column ` +
        `and include these four fields in the output instead.`;
    }

    // ── Column filter section ────────────────────────────────────────────────
    let filterEnglish = '';
    let filterSql     = '';
    if (filterCols && filterCols.length > 0) {
      filterEnglish =
        `As a final step, only the following ${filterCols.length} column${filterCols.length === 1 ? '' : 's'} ` +
        `are kept in the output (preset: "${filterPreset}"). All other columns are dropped before the ` +
        `dataset is saved and made available to the Figma plugin:\n` +
        filterCols.map(c => `  "${c}"`).join('\n') + '\n' +
        `If the database query already returns only these columns, this step is unnecessary.`;
      filterSql =
        `-- ─── Final Column Filter: ${filterPreset} ${'─'.repeat(Math.max(0, 38 - (filterPreset || '').length))}\n` +
        `SELECT\n  ${filterCols.map(q).join(',\n  ')}\nFROM pipeline_output;`;
    }

    // ── Combined pipeline SQL ────────────────────────────────────────────────
    // One CTE per step, chained together into a single query the DBA can run.
    const cteParts = [];
    if (mappingEntries.length > 0) {
      cteParts.push(
        `step_0_mapped AS (\n` +
        `  -- Column mapping: normalise source column names\n` +
        `  SELECT\n` +
        mappingEntries.map(([from, to]) => `    ${q(from)} AS ${q(to)}`).join(',\n') +
        `,\n    * EXCEPT(${mappingEntries.map(([from]) => q(from)).join(', ')})\n` +
        `  FROM source_data\n)`
      );
    }
    if (pipeline.enrichAfterRun) {
      const prev = cteParts.length ? `step_${cteParts.length - 1}_${cteParts.length === 1 ? 'mapped' : steps[cteParts.length - 2]?.name.replace(/\W+/g,'_').toLowerCase() || 'prev'}` : 'source_data';
      cteParts.push(
        `step_enriched AS (\n` +
        `  -- Enrich with player profile data (JOIN to your player/profile table)\n` +
        `  SELECT d.*, p.display_name AS "profile_name", p.avatar_url AS "avatar_image",\n` +
        `         p.avatar_thumb AS "avatar", p.phone AS "phone"\n` +
        `  FROM ${prev} d\n` +
        `  LEFT JOIN players p ON d.player_id = p.id\n)`
      );
    }
    for (let i = 0; i < steps.length; i++) {
      const step   = steps[i];
      const prev   = cteParts.length > 0
        ? `step_${cteParts.length - 1}_${i === 0 ? (pipeline.enrichAfterRun ? 'enriched' : (mappingEntries.length ? 'mapped' : 'source_data')) : steps[i-1].name.replace(/\W+/g,'_').toLowerCase()}`
        : 'source_data';
      const alias  = `step_${cteParts.length}_${step.name.replace(/\W+/g,'_').toLowerCase()}`;
      const rulesSql = step.rules.map(r => `  -- Rule ${r.index}: ${r.name}\n  ${r.sql.replace(/\n/g, '\n  ')}`).join('\n\n');
      cteParts.push(
        `${alias} AS (\n` +
        `  -- ${step.name}\n` +
        (step.rules.length === 0
          ? `  SELECT * FROM ${prev} -- no rules configured\n`
          : step.rules.map(r => {
              // Inline each rule's SQL into the CTE, reading from prev alias.
              const inlined = r.sql.replace(/\bFROM data\b/gi, `FROM ${prev}`);
              return `  -- Rule ${r.index}: ${r.name}\n  ${inlined.replace(/\n/g, '\n  ')}`;
            }).join('\n\n  -- ↓ feeds into next rule\n\n')) +
        `)`
      );
    }
    const lastAlias = cteParts.length > 0
      ? `step_${cteParts.length - 1}_${steps.length > 0 ? steps[steps.length-1].name.replace(/\W+/g,'_').toLowerCase() : 'source_data'}`
      : 'source_data';
    const finalSelect = filterCols && filterCols.length > 0
      ? `SELECT\n  ${filterCols.map(q).join(',\n  ')}\nFROM ${lastAlias};`
      : `SELECT * FROM ${lastAlias};`;

    const combinedSql = cteParts.length > 0
      ? `-- ═══════════════════════════════════════════════════════════════════════\n` +
        `-- Pipeline: ${pipeline.name}\n` +
        `-- Generated by Smartico Bridge — replicate this in your database to\n` +
        `-- bypass the pipeline and send pre-processed data via the inject API.\n` +
        `-- ═══════════════════════════════════════════════════════════════════════\n\n` +
        `WITH\n${cteParts.join(',\n\n')}\n\n${finalSelect}`
      : `-- Pipeline "${pipeline.name}" has no steps to replicate.\nSELECT * FROM source_data;`;

    // ── Brief summary (shown in the desc bar) ────────────────────────────────
    const transformSteps = steps.filter(st => st.rules.some(r => ['rename','sort','select-columns','extract-number','country-code'].includes(r.type)));
    const metricSteps    = steps.filter(st => st.rules.some(r => ['count','count-times','sum','avg','min','max','count-by','aggregate-metrics'].includes(r.type)));

    let summary = '';
    if (steps.length === 0 && !pipeline.enrichAfterRun) {
      summary = `"${pipeline.name}" has no steps configured yet.`;
    } else {
      const parts = [];
      if (mappingEntries.length)   parts.push(`renames ${mappingEntries.length} incoming column${mappingEntries.length === 1 ? '' : 's'}`);
      if (pipeline.enrichAfterRun) parts.push('enriches rows with player profile data');
      if (transformSteps.length)   parts.push(`applies ${transformSteps.length} transform step${transformSteps.length === 1 ? '' : 's'} (${transformSteps.map(s => s.name).join(', ')})`);
      if (metricSteps.length)      parts.push(`computes ${metricSteps.length} metric step${metricSteps.length === 1 ? '' : 's'} (${metricSteps.map(s => s.name).join(', ')})`);
      if (filterCols)              parts.push(`then filters to ${filterCols.length} output column${filterCols.length === 1 ? '' : 's'}`);
      summary = `"${pipeline.name}" — ` + parts.join(', then ') + '.';
    }

    res.json({
      ok:           true,
      pipelineId:   pipeline.id,
      title:        pipeline.name,
      summary,
      mappingEnglish,
      enrichEnglish,
      filterEnglish,
      stepCount:    steps.length,
      steps,
      combinedSql,
    });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Pipeline not found.' });
    res.status(500).json({ error: e.message });
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
