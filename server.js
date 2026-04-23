require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const PIPELINE_NAME = 'Enterprise - New Sales';

// Hardcoded stage IDs for this pipeline (metadata probability not set)
const CLOSED_WON_IDS  = new Set(['67215543']);
const CLOSED_LOST_IDS = new Set(['67215544']);

if (!process.env.HUBSPOT_TOKEN) {
  console.warn('WARNING: HUBSPOT_TOKEN not set — HubSpot API calls will fail until configured.');
}

// ─── Data directory ───────────────────────────────────────────────────────────
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── HubSpot client ───────────────────────────────────────────────────────────
const hs = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}` },
  timeout: 30000,
});

// ─── Rate limiter (8 req/sec, retry on 429) ───────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
let _reqLog = [];

async function enforceRateLimit() {
  const now = Date.now();
  _reqLog = _reqLog.filter(t => now - t < 1000);
  if (_reqLog.length >= 8) {
    const wait = 1000 - (now - _reqLog[0]) + 10;
    await sleep(wait);
    return enforceRateLimit();
  }
  _reqLog.push(Date.now());
}

async function hsCall(fn, retries = 5) {
  await enforceRateLimit();
  try {
    return await fn();
  } catch (err) {
    if (err.response?.status === 429 && retries > 0) {
      const wait = parseInt(err.response.headers['retry-after'] || '2', 10) * 1000;
      console.warn(`  Rate limited (429) — waiting ${wait / 1000}s (${retries} retries left)`);
      await sleep(wait);
      return hsCall(fn, retries - 1);
    }
    throw err;
  }
}

const hsGet  = (url, cfg)       => hsCall(() => hs.get(url, cfg));
const hsPost = (url, data, cfg) => hsCall(() => hs.post(url, data, cfg));

// ─── Cache ────────────────────────────────────────────────────────────────────
let cache = null;

function loadCache() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log(`Cache loaded: ${cache.deals?.length || 0} deals, last refreshed ${cache.lastRefreshed}`);
    }
  } catch (e) {
    console.warn('Could not load cache:', e.message);
  }
}

function saveCache(data) {
  cache = data;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
}

// ─── HubSpot API helpers ──────────────────────────────────────────────────────

/**
 * Find the "Enterprise New Sales" pipeline and classify its stages.
 * Returns { id, name, stages: [...], stageMap: { stageId: stageObj } }
 */
async function findPipeline() {
  const res      = await hsGet('/crm/v3/pipelines/deals');
  const pipeline = res.data.results.find(
    p => p.label.toLowerCase() === PIPELINE_NAME.toLowerCase()
  );
  if (!pipeline) {
    const names = res.data.results.map(p => p.label).join(', ');
    throw new Error(`Pipeline "${PIPELINE_NAME}" not found. Available: ${names}`);
  }

  const stageMap = {};
  const stages   = (pipeline.stages || []).map(s => {
    const isClosedWon  = CLOSED_WON_IDS.has(s.id);
    const isClosedLost = CLOSED_LOST_IDS.has(s.id);
    const isClosed     = isClosedWon || isClosedLost;
    const stage = {
      id: s.id,
      label: s.label,
      isClosedWon,
      isClosedLost,
      isClosed,
      probability: isClosedWon ? 1.0 : isClosedLost ? 0.0 : null,
      displayOrder: s.displayOrder ?? 0,
    };
    stageMap[s.id] = stage;
    return stage;
  });

  stages.sort((a, b) => a.displayOrder - b.displayOrder);
  return { id: pipeline.id, name: pipeline.label, stages, stageMap };
}

/**
 * Fetch all deals in the pipeline (with stage history).
 * Pass afterDate (ISO string) for incremental syncs.
 */
async function fetchAllDeals(pipelineId, stageMap, afterDate = null) {
  const deals   = [];
  let   cursor  = undefined;

  const filters = [
    { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
  ];
  if (afterDate) {
    filters.push({
      propertyName: 'hs_lastmodifieddate',
      operator: 'GTE',
      value: afterDate,
    });
  }

  console.log(`Fetching deals${afterDate ? ` modified since ${afterDate}` : ' (full)'} ...`);

  while (true) {
    const body = {
      filterGroups: [{ filters }],
      properties: [
        'dealname',
        'amount',
        'createdate',
        'closedate',
        'hubspot_owner_id',
        'dealstage',
        'hs_lastmodifieddate',
      ],
      sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (cursor) body.after = cursor;

    const res = await hsPost('/crm/v3/objects/deals/search', body);
    const { results, paging } = res.data;

    for (const deal of results) {
      const props = deal.properties;
      const stage = props.dealstage || null;

      // Derive closed dates from currentStage + closedate (fallback to createdate)
      // These deals were bulk-imported so hs_date_entered_ isn't populated
      const isClosedWon  = CLOSED_WON_IDS.has(stage);
      const isClosedLost = CLOSED_LOST_IDS.has(stage);
      const closingDate  = props.closedate || props.createdate;

      deals.push({
        id:             deal.id,
        name:           props.dealname || 'Unnamed Deal',
        amount:         props.amount ? parseFloat(props.amount) : 0,
        createdate:     props.createdate,
        closedate:      props.closedate || null,
        ownerId:        props.hubspot_owner_id ? String(props.hubspot_owner_id) : null,
        currentStage:   stage,
        lastModified:   props.hs_lastmodifieddate || null,
        closedWonDate:  isClosedWon  ? closingDate : null,
        closedLostDate: isClosedLost ? closingDate : null,
      });
    }

    console.log(`  → ${deals.length} deals fetched`);
    if (!paging?.next?.after) break;
    cursor = paging.next.after;
  }

  return deals;
}

/**
 * Fetch the HubSpot portal ID (for building app URLs)
 */
async function fetchPortalId() {
  try {
    const res = await hsGet('/account-info/v3/details');
    return String(res.data.portalId);
  } catch (e) {
    console.warn('Could not fetch portal ID:', e.message);
    return null;
  }
}

/**
 * Fetch all HubSpot owners and return a map { ownerId: ownerObj }
 */
async function fetchOwners() {
  const owners = {};
  let   cursor = undefined;

  while (true) {
    const params = { limit: 100, includeDeactivated: true };
    if (cursor) params.after = cursor;
    const res = await hsGet('/crm/v3/owners', { params });

    for (const o of res.data.results) {
      const id = String(o.id);
      owners[id] = {
        id,
        firstName: o.firstName || '',
        lastName:  o.lastName  || '',
        email:     o.email     || '',
        name: [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || `Owner ${id}`,
      };
    }

    if (!res.data.paging?.next?.after) break;
    cursor = res.data.paging.next.after;
  }

  return owners;
}

// ─── Refresh / Sync ───────────────────────────────────────────────────────────

async function fullRefresh() {
  console.log('== Full Refresh starting ==');
  const pipeline = await findPipeline();
  console.log(`Pipeline found: "${pipeline.name}" (${pipeline.id}), ${pipeline.stages.length} stages`);
  pipeline.stages.forEach(s =>
    console.log(`  Stage: ${s.label} — closedWon=${s.isClosedWon} closedLost=${s.isClosedLost}`)
  );

  const [deals, owners, portalId] = await Promise.all([
    fetchAllDeals(pipeline.id, pipeline.stageMap),
    fetchOwners(),
    fetchPortalId(),
  ]);

  const data = {
    lastRefreshed: new Date().toISOString(),
    portalId,
    pipeline: { id: pipeline.id, name: pipeline.name, stages: pipeline.stages },
    owners,
    deals,
  };

  saveCache(data);
  console.log(`== Full Refresh complete: ${deals.length} deals ==`);
  return data;
}

async function incrementalSync() {
  if (!cache) throw new Error('No cache — run Full Refresh first');

  const lastRefreshed = cache.lastRefreshed;
  console.log(`== Incremental Sync since ${lastRefreshed} ==`);

  const pipeline  = await findPipeline();
  const newDeals  = await fetchAllDeals(pipeline.id, pipeline.stageMap, lastRefreshed);
  const owners    = await fetchOwners();

  // Merge updated/new deals into existing cache
  const dealMap = Object.fromEntries((cache.deals || []).map(d => [d.id, d]));
  for (const d of newDeals) dealMap[d.id] = d;

  const data = {
    lastRefreshed: new Date().toISOString(),
    portalId: cache.portalId || await fetchPortalId(),
    pipeline: { id: pipeline.id, name: pipeline.name, stages: pipeline.stages },
    owners,
    deals: Object.values(dealMap),
  };

  saveCache(data);
  console.log(`== Incremental Sync complete: ${newDeals.length} updated, ${data.deals.length} total ==`);
  return data;
}

// ─── Cookie Auth ──────────────────────────────────────────────────────────────
const APP_PASSWORD   = process.env.APP_PASSWORD || '';
const SESSION_TOKEN  = APP_PASSWORD
  ? crypto.createHash('sha256').update(APP_PASSWORD + 'unyte-pipeline-salt').digest('hex')
  : null;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[decodeURIComponent(k.trim())] = decodeURIComponent(v.join('=').trim());
  }
  return out;
}

function authMiddleware(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.path === '/__login') return next();
  // Embed page and its data endpoint are always public
  if (req.path === '/embed' || req.path === '/embed.html') return next();
  if (req.path === '/api/embed-data') return next();
  const cookies = parseCookies(req.headers.cookie);
  if (cookies['session'] === SESSION_TOKEN) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/__login');
}

// ─── Express setup ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

// Login page
app.get('/__login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Login — Pipeline Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;
  background:#1E2D3D;font-family:'Lato',sans-serif}
.card{background:#fff;padding:44px 40px;border-radius:14px;width:340px;text-align:center;
  box-shadow:0 8px 32px rgba(0,0,0,.3)}
h2{color:#1E2D3D;font-family:'Merriweather',serif;font-size:20px;margin-bottom:8px}
p{color:#7A8FA0;font-size:13px;margin-bottom:28px}
input{width:100%;padding:11px 14px;border:1px solid #DDE3E9;border-radius:8px;
  margin-bottom:16px;font-size:15px;outline:none}
input:focus{border-color:#425B76}
button{background:#D96B4F;color:#fff;border:none;padding:12px;border-radius:8px;
  font-size:15px;cursor:pointer;width:100%;font-weight:700;letter-spacing:.3px}
button:hover{background:#c05a40}
.err{color:#D96B4F;font-size:13px;margin-top:14px}
</style></head>
<body><div class="card">
<h2>Pipeline Dashboard</h2>
<p>Unyte — Enterprise New Sales</p>
<form method="POST" action="/__login">
<input type="password" name="password" placeholder="Password" autofocus />
<button type="submit">Sign In</button>
${req.query.error ? '<p class="err">Incorrect password</p>' : ''}
</form>
</div></body></html>`);
});

app.post('/__login', (req, res) => {
  if (req.body.password === APP_PASSWORD) {
    res.setHeader('Set-Cookie', `session=${SESSION_TOKEN}; Path=/; HttpOnly; Max-Age=604800`);
    return res.redirect('/');
  }
  res.redirect('/__login?error=1');
});

// ─── API Routes ───────────────────────────────────────────────────────────────

app.get('/api/data', (req, res) => {
  if (!cache) {
    return res.json({ error: 'No data yet — click Full Refresh to load from HubSpot.', deals: [], owners: {}, pipeline: null, lastRefreshed: null });
  }
  res.json(cache);
});

// Public endpoint for embedded views (no auth required)
app.get('/api/embed-data', (req, res) => {
  if (!cache) {
    return res.json({ error: 'No data yet', deals: [], owners: {}, pipeline: null, lastRefreshed: null });
  }
  res.json(cache);
});

app.get('/api/debug', (req, res) => {
  if (!cache) return res.json({ error: 'No cache' });

  // Pipeline stages as configured
  const stages = cache.pipeline?.stages?.map(s => ({
    id: s.id, label: s.label, isClosedWon: s.isClosedWon, isClosedLost: s.isClosedLost,
  }));

  // Count every unique stageId appearing in deal history
  const historyIdCounts = {};
  for (const deal of cache.deals || []) {
    for (const h of deal.stageHistory || []) {
      historyIdCounts[h.stageId] = (historyIdCounts[h.stageId] || 0) + 1;
    }
  }

  // Count current stage of each deal
  const currentStageCounts = {};
  for (const deal of cache.deals || []) {
    const s = deal.currentStage || 'null';
    currentStageCounts[s] = (currentStageCounts[s] || 0) + 1;
  }

  // Sample: first 3 closed-won deals, first 3 closed-lost deals
  const cwDeals  = (cache.deals || []).filter(d => d.currentStage === [...CLOSED_WON_IDS][0]).slice(0, 3);
  const clDeals  = (cache.deals || []).filter(d => d.currentStage === [...CLOSED_LOST_IDS][0]).slice(0, 3);
  const sampleDeals = [...cwDeals, ...clDeals].map(d => ({
    id: d.id, name: d.name, currentStage: d.currentStage,
    closedWonDate: d.closedWonDate, closedLostDate: d.closedLostDate,
  }));

  res.json({
    closedWonIds:     [...CLOSED_WON_IDS],
    closedLostIds:    [...CLOSED_LOST_IDS],
    pipelineStages:   stages,
    historyIdCounts,
    currentStageCounts,
    sampleDeals,
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ready:         !!cache,
    dealCount:     cache?.deals?.length || 0,
    lastRefreshed: cache?.lastRefreshed || null,
    pipeline:      cache?.pipeline?.name || null,
  });
});

app.post('/api/refresh', async (req, res) => {
  try {
    const data = await fullRefresh();
    res.json({ ok: true, dealCount: data.deals.length, lastRefreshed: data.lastRefreshed });
  } catch (err) {
    console.error('Refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const data = await incrementalSync();
    res.json({ ok: true, dealCount: data.deals.length, lastRefreshed: data.lastRefreshed });
  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Start ────────────────────────────────────────────────────────────────────
loadCache();
app.listen(PORT, () => {
  console.log(`\nUnyte Pipeline Dashboard → http://localhost:${PORT}\n`);
});
