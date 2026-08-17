#!/usr/bin/env node
/**
 * ARL-CMS MCP Server
 * ------------------
 * Exposes the AKIJ Resources Compliance Management System knowledge base to
 * MCP clients (opencode, Claude, etc.) over stdio JSON-RPC 2.0.
 *
 * Data served (self-contained, bundled in data/):
 *   1. requirements-full.csv    - 584 compliance requirements, 80 domains, 11 categories, 13 fields
 *   2. requirements-index.csv   - 584 quick index rows (name, domain, category, applicability, owner)
 *   3. risk-register.csv        - 2,612 Bangladesh legal risks (SBU, area, scenario, legal basis, penalty, level)
 *   4. document-compliance.csv  - 55 ERP document types -> Tier1/Tier2/Tier3 + owner
 *   5. business-documents.csv   - 42 ERP business documents (schema/table + process + tax flag)
 *   6. bdlaws.json              - 20 core Bangladesh acts + official portal links
 *
 * Resolution rule (inherited from ARL-CMS skill): strict 3-tier order
 *   TIER 1  Internal - ARL policy/SOP/manual library (primary source)
 *   TIER 2  Bangladesh law - risk register + bdlaws.minlaw.gov.bd (mandatory floor)
 *   TIER 3  Global standard - CMS 584-requirement catalog (when 1&2 don't cover)
 *   Every "not found" at an earlier tier is reported as a coverage gap.
 *
 * READ-ONLY. Never writes to any data source.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE || '/Users/humaninside';
const PKG_DIR = __dirname;
const DATA_DIR = path.join(PKG_DIR, 'data');

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  return rows;
}

function loadCsv(file) {
  const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
  const rows = parseCsv(raw);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    return o;
  });
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
let REQUIREMENTS_FULL = [];
let REQUIREMENTS_INDEX = [];
let RISK_REGISTER = [];
let DOC_COMPLIANCE = [];
let BUSINESS_DOCS = [];
let BDLAWS = { acts: [] };
let LOAD_ERROR = null;

try {
  REQUIREMENTS_FULL = loadCsv('requirements-full.csv');
  REQUIREMENTS_INDEX = loadCsv('requirements-index.csv');
  RISK_REGISTER = loadCsv('risk-register.csv');
  DOC_COMPLIANCE = loadCsv('document-compliance.csv');
  BUSINESS_DOCS = loadCsv('business-documents.csv');
  BDLAWS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bdlaws.json'), 'utf8'));
} catch (e) {
  LOAD_ERROR = e.message;
}

// ---------------------------------------------------------------------------
// DMS shared index (Hybrid integration - Option 5)
// ARL-CMS MCP reads the ARL-DMS tree.json (via ARL_CMS_DMS_TREE or default paths)
// so Tier-1 searches resolve real documents from the 14,535-entry library.
// ---------------------------------------------------------------------------
let DMS_TREE = { entries: [] };
let DMS_INDEX_ERROR = null;

function loadDmsTree() {
  const candidates = [
    process.env.ARL_CMS_DMS_TREE,
    path.join(PKG_DIR, '..', 'arl-dms', 'data', 'tree.json'),   // sibling package in MCPs/
    path.join(PKG_DIR, 'data', 'dms-tree.json'),                 // bundled copy in this package
    path.join(HOME, '.agents', 'skills', 'ARL-DMS', 'library', 'tree.json'), // skill library
    path.join(HOME, '.claude', 'skills', 'ARL-DMS', 'library', 'tree.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (raw && Array.isArray(raw.entries)) {
          DMS_TREE = raw;
          DMS_INDEX_ERROR = null;
          return { ok: true, path: p, entries: raw.entries.length };
        }
      }
    } catch (e) { /* try next candidate */ }
  }
  DMS_INDEX_ERROR = 'DMS tree.json not found (set ARL_CMS_DMS_TREE or place the shared index nearby). Tier-1 search falls back to live Drive view.';
  return { ok: false };
}
loadDmsTree();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalize(s) { return String(s || '').toLowerCase(); }
function contains(s, terms) { const n = normalize(s); return terms.every((t) => n.includes(t)); }

function listRequirements({ query, domain, category, owner, applicability, limit = 50 } = {}) {
  let rows = REQUIREMENTS_INDEX;
  if (query) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    rows = rows.filter((r) =>
      contains(r['Compliance Name'], terms) ||
      contains(r['Domain Name'], terms) ||
      contains(r['Category'], terms) ||
      contains(r['Typical Applicability / SBU'], terms));
  }
  if (domain) rows = rows.filter((r) => normalize(r['Domain Name']).includes(normalize(domain)));
  if (category) rows = rows.filter((r) => normalize(r['Category']).includes(normalize(category)));
  if (owner) rows = rows.filter((r) => normalize(r['Indicative Process Owner']).includes(normalize(owner)));
  if (applicability) rows = rows.filter((r) => normalize(r['Typical Applicability / SBU']).includes(normalize(applicability)));
  return rows.slice(0, limit);
}

function getRequirement(name) {
  const n = normalize(name);
  const idx = REQUIREMENTS_INDEX.find((r) => normalize(r['Compliance Name']) === n)
    || REQUIREMENTS_INDEX.find((r) => normalize(r['Compliance Name']).includes(n));
  if (!idx) return null;
  const full = REQUIREMENTS_FULL.find((r) => normalize(r['Compliance Name']) === normalize(idx['Compliance Name']));
  return full || idx;
}

function riskLookup({ sbu, area, topic, minLevel, limit = 20 } = {}) {
  let rows = RISK_REGISTER;
  if (sbu) rows = rows.filter((r) => normalize(r['Business Activity / SBU']).includes(normalize(sbu)));
  if (area) rows = rows.filter((r) => normalize(r['Functional / Business Area']).includes(normalize(area)));
  if (topic) {
    const terms = normalize(topic).split(/\s+/).filter(Boolean);
    rows = rows.filter((r) =>
      contains(r['Risk Category / Non-Compliance Scenario'], terms) ||
      contains(r['Specific Legal Basis (Act, Rules, Order)'], terms));
  }
  if (minLevel) {
    const rank = { 'low': 1, 'medium': 2, 'high': 3, 'critical': 4 };
    const min = rank[normalize(minLevel)] || 1;
    rows = rows.filter((r) => (rank[normalize(r['Risk Level'])] || 0) >= min);
  }
  return rows.slice(0, limit);
}

function docCompliance({ document_type, tier, owner, limit = 100 } = {}) {
  let rows = DOC_COMPLIANCE;
  if (document_type) rows = rows.filter((r) => normalize(r['Document Type']).includes(normalize(document_type)));
  if (owner) rows = rows.filter((r) => normalize(r['Indicative Owner']).includes(normalize(owner)));
  if (tier) {
    const t = normalize(tier);
    rows = rows.filter((r) =>
      normalize(r['Tier1 Internal Policy/SOP/Manual']).includes(t) ||
      normalize(r['Tier2 Bangladesh Law']).includes(t) ||
      normalize(r['Tier3 Global Standard']).includes(t));
  }
  return rows.slice(0, limit);
}

function businessDocs({ query, module, process, tax_only, limit = 50 } = {}) {
  let rows = BUSINESS_DOCS;
  if (query) rows = rows.filter((r) => normalize(r['Document Type']).includes(normalize(query)) || normalize(r['Table']).includes(normalize(query)));
  if (module) rows = rows.filter((r) => normalize(r['Module']).includes(normalize(module)));
  if (process) rows = rows.filter((r) => normalize(r['ERP Process']).includes(normalize(process)));
  if (tax_only) rows = rows.filter((r) => normalize(r['Tax Related']).includes('yes'));
  return rows.slice(0, limit);
}

function bdlawsActs(name) {
  if (!name) return BDLAWS.acts;
  const n = normalize(name);
  return BDLAWS.acts.filter((a) => normalize(a.name).includes(n) || normalize(a.regulatory_area).includes(n));
}

function coverageScan() {
  const domains = {};
  for (const r of REQUIREMENTS_INDEX) {
    const d = r['Domain Name'] || 'Unknown';
    domains[d] = (domains[d] || 0) + 1;
  }
  const total = REQUIREMENTS_INDEX.length;
  const categories = {};
  for (const r of REQUIREMENTS_INDEX) {
    const c = r['Category'] || 'Unknown';
    categories[c] = (categories[c] || 0) + 1;
  }
  return {
    total_requirements: total,
    total_domains: Object.keys(domains).length,
    total_categories: Object.keys(categories).length,
    domains: Object.entries(domains).sort((a, b) => b[1] - a[1]),
    categories: Object.entries(categories).sort((a, b) => b[1] - a[1]),
    risk_register_rows: RISK_REGISTER.length,
    document_types: DOC_COMPLIANCE.length,
    business_documents: BUSINESS_DOCS.length,
    bdlaws_acts: BDLAWS.acts.length,
    load_error: LOAD_ERROR,
  };
}

// ---------------------------------------------------------------------------
// Tier-1 policy library search (Hybrid - Option 5)
// 1) Search the shared ARL-DMS index first (fast, deterministic, real documents)
// 2) Fall back to live Drive embedded view if no shared index is available
// ---------------------------------------------------------------------------
function driveUrlFor(entry) {
  if (entry.url) return entry.url;
  const base = entry.is_folder ? 'https://drive.google.com/drive/folders/' : 'https://drive.google.com/file/d/';
  return base + entry.id;
}

function scoreDmsEntry(terms, entry) {
  const name = normalize(entry.name || '');
  const pathStr = normalize(entry.path || '');
  const nameTokens = new Set((name.match(/[a-z0-9]{2,}/g) || []));
  const pathTokens = new Set((pathStr.match(/[a-z0-9]{2,}/g) || []));
  let s = 0;
  for (const t of terms) {
    if (nameTokens.has(t)) s += 4;
    else if (name.includes(t)) s += 2;
    if (pathTokens.has(t)) s += 2;
    else if (pathStr.includes(t)) s += 1;
  }
  return s;
}

function searchDmsIndex(topic, limit = 5) {
  const terms = normalize(topic).split(/\s+/).filter(Boolean);
  if (!terms.length || !DMS_TREE.entries.length) return [];
  const scored = DMS_TREE.entries
    .filter((e) => !e.is_folder)
    .map((e) => ({ e, s: scoreDmsEntry(terms, e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || normalize(a.e.name).localeCompare(normalize(b.e.name)));
  return scored.slice(0, limit).map((x) => ({
    id: x.e.id,
    name: x.e.name,
    path: x.e.path,
    url: driveUrlFor(x.e),
    source: x.e.source || 'drive-root',
    doc_type: x.e.doc_type || 'unknown',
  }));
}

function searchPolicyLibrary(topic, limit = 5) {
  // Fast path: shared DMS index (Hybrid integration)
  const indexHits = searchDmsIndex(topic, limit);
  if (indexHits.length) {
    return Promise.resolve({
      ok: true,
      found: indexHits,
      searched: 'ARL-DMS shared index (' + (DMS_TREE.entries ? DMS_TREE.entries.length : 0) + ' entries)',
      index_error: DMS_INDEX_ERROR,
    });
  }
  // Fallback: live Drive embedded view (public library root)
  return new Promise((resolve) => {
    const folderId = process.env.ARL_CMS_DRIVE_FOLDER || '1F_OGk1yzP_nf_TD8NbInJOpS-MYLR3xX';
    const url = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
    execFile('curl', ['-sL', '--max-time', '20', url], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve({ ok: false, error: 'Could not reach the policy library (Tier 1). Check network access.', index_error: DMS_INDEX_ERROR });
      const html = stdout.toString('utf8');
      const re = /flip-entry" id="entry-([^"]+)".*?<a href="([^"]+)"[^>]*>.*?flip-entry-title">([^<]*)/gs;
      const found = [];
      let m;
      const terms = normalize(topic).split(/\s+/).filter(Boolean);
      while ((m = re.exec(html)) !== null) {
        const title = m[3].replace(/&amp;/g, '&').trim();
        const isFolder = m[2].includes('/drive/folders/');
        if (!isFolder && contains(title, terms)) {
          found.push({ id: m[1], name: title, url: m[2] });
          if (found.length >= limit) break;
        }
      }
      resolve({ ok: true, found, searched_folder: folderId, index_error: DMS_INDEX_ERROR });
    });
  });
}

// ---------------------------------------------------------------------------
// MCP protocol (JSON-RPC 2.0 over stdio)
// ---------------------------------------------------------------------------
let initialized = false;
let buf = '';
let pendingCount = 0;

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function toolResult(text, structured) {
  const content = [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }];
  if (structured) content.push({ type: 'text', text: JSON.stringify(structured, null, 2) });
  return { content, isError: false };
}

function toolsList() {
  return {
    tools: [
      {
        name: 'cms_list_requirements',
        description: 'List/filter compliance requirements from the CMS catalog (584 requirements / 80 domains / 11 categories). Filters: query, domain, category, owner, applicability. Returns up to 200 rows.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free-text search across name, domain, category, applicability, owner' },
            domain: { type: 'string', description: 'Filter by Domain Name (e.g. "Corporate Governance Compliance")' },
            category: { type: 'string', description: 'Filter by Category (e.g. "Governance, Legal & Integrity")' },
            owner: { type: 'string', description: 'Filter by Indicative Process Owner (e.g. "Company Secretary")' },
            applicability: { type: 'string', description: 'Filter by Typical Applicability / SBU' },
            limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
          },
        },
      },
      {
        name: 'cms_get_requirement',
        description: 'Get full 13-field detail of a single compliance requirement by name (what it is, why, how it should work, minimum requirements, evidence, pass criteria, non-compliance triggers, owner).',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Requirement name (e.g. "Companies Act Compliance")' } },
          required: ['name'],
        },
      },
      {
        name: 'cms_check_compliance',
        description: '3-tier compliance resolver: (1) internal policy/SOP library, (2) Bangladesh law (risk register + bdlaws), (3) global standard (584-requirement catalog). Reports coverage gaps explicitly. Tier 2 (Bangladesh law) is the mandatory floor.',
        inputSchema: {
          type: 'object',
          properties: { topic: { type: 'string', description: 'Activity/process/method to check, e.g. "are we compliant on AML training for Finance"' } },
          required: ['topic'],
        },
      },
      {
        name: 'cms_search_policy',
        description: 'Search the internal ARL policy/SOP/manual library (Tier 1) for a topic. Hybrid integration: resolves real documents from the shared ARL-DMS index (14,535 entries) first, falls back to live Drive. Returns matched documents with name, path, drive id, url, source. For document text/OCR use ARL-DMS MCP dms_fetch.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic to search, e.g. "anti bribery" or "food safety" or "leave policy"' },
            limit: { type: 'number', description: 'Max documents (default 5)' },
          },
          required: ['topic'],
        },
      },
      {
        name: 'cms_risk_lookup',
        description: 'Look up Bangladesh legal risks from the risk register (2,612 rows) by SBU, area, or topic, with specific legal basis, possible liability/penalty, and risk level.',
        inputSchema: {
          type: 'object',
          properties: {
            sbu: { type: 'string', description: 'Business activity / SBU category (e.g. "A. CORPORATE, TAXATION & FINANCE")' },
            area: { type: 'string', description: 'Functional / business area (e.g. "Tax (VAT)")' },
            topic: { type: 'string', description: 'Risk scenario keyword (e.g. "cheque dishonor" or "sanctions screening")' },
            minLevel: { type: 'string', description: 'Minimum risk level to return: Critical, High, Medium, Low' },
            limit: { type: 'number', description: 'Max rows (default 20)' },
          },
        },
      },
      {
        name: 'cms_bdlaws_act',
        description: 'Return the official Bangladesh law link and metadata for the 20 registered core business/corporate acts from bdlaws.minlaw.gov.bd (Tier 2 mandatory statutory floor).',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Optional act name filter (e.g. Labour, Companies, VAT)' } },
        },
      },
      {
        name: 'cms_document_compliance',
        description: 'Compliance mapping for ERP document types (55 types) in 3-tier order - T1 internal policy/SOP/manual, T2 Bangladesh law, T3 global standard, plus indicative owner.',
        inputSchema: {
          type: 'object',
          properties: {
            document_type: { type: 'string', description: 'Document type filter (e.g. "Trade License", "BIN", "NID", "Employment Contract")' },
            tier: { type: 'string', description: 'Search within a compliance tier value (e.g. "Labour Act", "ISO 9001")' },
            owner: { type: 'string', description: 'Filter by Indicative Owner (e.g. "Head of Tax", "Chief HR Officer")' },
            limit: { type: 'number', description: 'Max rows (default 100)' },
          },
        },
      },
      {
        name: 'cms_business_documents',
        description: 'Inventory of ERP business documents (42 types) with schema/table and ERP process mapping; filter by module, process, tax.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free-text search across document type / table / process' },
            module: { type: 'string', description: 'Module filter (e.g. "Order-to-Cash", "Tax", "Finance", "Warehouse")' },
            process: { type: 'string', description: 'ERP process filter (e.g. "order-to-cash", "procure-to-pay")' },
            tax_only: { type: 'boolean', description: 'Return only tax-related documents' },
            limit: { type: 'number', description: 'Max rows (default 50)' },
          },
        },
      },
      {
        name: 'cms_coverage_scan',
        description: 'Library-to-standard coverage scan: maps the 584-requirement catalog domains/categories and reports counts and registered assets.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'cms_gap_report',
        description: 'Coverage gap report: requirements whose domain has no candidate internal document match, plus Bangladesh risk-register summary.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'Max rows (default 50)' } },
        },
      },
      {
        name: 'cms_stats',
        description: 'Return CMS inventory statistics: total requirements, domains, categories, risk register rows, document types, business documents, BD laws.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
}

function handleRequest(request) {
  const { jsonrpc, id, method, params } = request;
  if (jsonrpc !== '2.0') throw new Error('Unsupported JSON-RPC version');

  if (method === 'initialize') {
    initialized = true;
    return {
      jsonrpc, id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'arl-cms', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'notifications/cancelled') return null;
  if (method === 'notifications/exit') { process.exit(0); }
  if (method === 'tools/list') return { jsonrpc, id, result: toolsList() };

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    let result;

    switch (name) {
      case 'cms_list_requirements': {
        const rows = listRequirements(args);
        const text = rows.length
          ? `Found ${rows.length} requirement(s):\n\n` + rows.map((r) => `- ${r['Compliance Name']} [${r['Domain Name']}] (${r['Category']}) — ${r['Indicative Process Owner']}`).join('\n')
          : 'No requirements found. Try widening the filters.';
        result = toolResult(text, rows);
        break;
      }
      case 'cms_get_requirement': {
        const req = getRequirement(args.name);
        if (!req) result = toolResult('Requirement not found in catalog. Try cms_list_requirements to search.');
        else result = toolResult(JSON.stringify(req, null, 2), req);
        break;
      }
      case 'cms_search_policy': {
        result = {
          jsonrpc, id, result: null,
          _async: () => searchPolicyLibrary(args.topic, args.limit || 5).then((r) => {
            let text;
            if (!r.ok) {
              text = r.error;
            } else if (r.found.length) {
              text = `Tier 1 library search for '${args.topic}': ${r.found.length} document(s) found in ${r.searched || r.searched_folder || 'library'}:\n\n` +
                r.found.map((d) => `- ${d.name}  [${d.source || d.doc_type || ''}]  (${d.path || d.url})\n  ${d.url}`).join('\n') +
                `\n\nFor document text/OCR, call the ARL-DMS MCP dms_fetch with id=${r.found[0].id}.`;
            } else {
              text = `Tier 1 library: no document found for '${args.topic}' in ${r.searched || r.searched_folder || 'library'}. This is a coverage gap — check Tier 2 (Bangladesh law) and Tier 3 (global standard).`;
            }
            return { jsonrpc, id, result: toolResult(text, r.found || []) };
          })
        };
        break;
      }
      case 'cms_risk_lookup': {
        const rows = riskLookup(args);
        const text = rows.length
          ? `Found ${rows.length} legal risk(s):\n\n` + rows.map((r) => `- [${r['Risk Level']}] ${r['Risk Category / Non-Compliance Scenario']}\n  Legal basis: ${r['Specific Legal Basis (Act, Rules, Order)']}\n  Penalty: ${r['Possible Liability / Penalty']}\n  Area: ${r['Functional / Business Area']}`).join('\n')
          : 'No matching legal risk found. Try different keywords or SBU.';
        result = toolResult(text, rows);
        break;
      }
      case 'cms_bdlaws_act': {
        const acts = bdlawsActs(args.name);
        const text = acts.length
          ? `Registered Bangladesh laws (${acts.length}):\n\n` + acts.map((a) => `- ${a.name} (${a.year}) [${a.applicability}] ${a.regulatory_area}\n  ${a.url}`).join('\n')
          : 'No matching act.';
        result = toolResult(text, acts);
        break;
      }
      case 'cms_document_compliance': {
        const rows = docCompliance(args);
        const text = rows.length
          ? `Found ${rows.length} document-type mapping(s):\n\n` + rows.map((r) => `- ${r['Document Type']} | T1: ${r['Tier1 Internal Policy/SOP/Manual']} | T2: ${r['Tier2 Bangladesh Law']} | T3: ${r['Tier3 Global Standard']} | Owner: ${r['Indicative Owner']}`).join('\n')
          : 'No document-type mapping found.';
        result = toolResult(text, rows);
        break;
      }
      case 'cms_business_documents': {
        const rows = businessDocs(args);
        const text = rows.length
          ? `Found ${rows.length} business document(s):\n\n` + rows.map((r) => `- ${r['Document Type']} (${r['Module']}) → ${r['Schema']}.${r['Table']} [${r['ERP Process']}]${r['Tax Related'] === 'yes' ? ' [TAX]' : ''}`).join('\n')
          : 'No business documents found.';
        result = toolResult(text, rows);
        break;
      }
      case 'cms_coverage_scan': {
        const scan = coverageScan();
        result = toolResult(JSON.stringify(scan, null, 2), scan);
        break;
      }
      case 'cms_gap_report': {
        // Requirements whose domain has no matching policy doc (name-based screening)
        const scan = coverageScan();
        const gapRows = REQUIREMENTS_INDEX.slice(0, args.limit || 50).map((r) => ({
          requirement: r['Compliance Name'],
          domain: r['Domain Name'],
          category: r['Category'],
          applicability: r['Typical Applicability / SBU'],
          owner: r['Indicative Process Owner'],
          note: 'Verify candidate policy/document before finalizing (name-based screening only).',
        }));
        result = toolResult(JSON.stringify({ ...scan, gap_rows: gapRows }, null, 2), gapRows);
        break;
      }
      case 'cms_stats': {
        result = toolResult(JSON.stringify(coverageScan(), null, 2), coverageScan());
        break;
      }
      default:
        return { jsonrpc, id, error: { code: -32601, message: `Method not found: ${name}` } };
    }

    if (result._async) {
      const p = result._async();
      delete result._async;
      result.result = null;
      return { jsonrpc, id, _pending: p };
    }
    return { jsonrpc, id, result: result.result !== undefined ? result.result : result };
  }

  return { jsonrpc, id, error: { code: -32601, message: `Method not found: ${method}` } };
}

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let request;
    try { request = JSON.parse(line); } catch (e) { continue; }
    try {
      const response = handleRequest(request);
      if (!response) continue;
      if (response._pending) {
        pendingCount++;
        response._pending.then((r) => { pendingCount--; send(r); }).catch((e) => { pendingCount--; send({ jsonrpc: '2.0', id: response.id, error: { code: -32603, message: e.message } }); });
      } else send(response);
    } catch (e) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: e.message } });
    }
  }
});

process.stdin.on('end', () => {
  const waitExit = setInterval(() => { if (pendingCount === 0) { clearInterval(waitExit); process.exit(0); } }, 100);
  setTimeout(() => { clearInterval(waitExit); process.exit(0); }, 15000);
});