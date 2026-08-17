# ARL-CMS MCP Server

Exposes the AKIJ Resources Compliance Management System knowledge base to MCP
clients (opencode, Claude, etc.) over stdio JSON-RPC 2.0.

## Data served (self-contained, bundled in `data/`)

| Data | Content |
|---|---|
| `requirements-full.csv` | **584 compliance requirements** — 80 domains, 11 categories, 13 fields each (what it is, why, minimum requirements, evidence, pass criteria, non-compliance triggers, owner) |
| `requirements-index.csv` | 584 quick index rows (name, domain, category, applicability, owner) |
| `risk-register.csv` | **2,612 Bangladesh legal risks** (SBU, area, scenario, legal basis, penalty, level: Critical 340 / High 1,016 / Medium 881 / Low 375) |
| `document-compliance.csv` | 55 ERP document types → Tier1 internal policy / Tier2 BD law / Tier3 global standard + owner |
| `business-documents.csv` | 42 ERP business documents (schema/table + process + tax flag) |
| `bdlaws.json` | 20 core Bangladesh acts + official bdlaws.minlaw.gov.bd links |

## Resolution rule (3-tier, strict order)

1. **TIER 1** — Internal ARL policy/SOP/manual library (primary source)
2. **TIER 2** — Bangladesh law (risk register + bdlaws portal) — **mandatory floor**
3. **TIER 3** — Global standard (584-requirement catalog)

Every "not found" at an earlier tier is reported as a coverage gap before moving on.
Bangladesh law is non-negotiable and governs even if an internal document is silent
or weaker. Evidence before verdict: no evidence = NOT DEMONSTRATED, not COMPLIANT.

## Tools

| Tool | Purpose |
|---|---|
| `cms_list_requirements` | Filter the 584-requirement catalog (query/domain/category/owner/applicability) |
| `cms_get_requirement` | Full 13-field detail of one requirement |
| `cms_check_compliance` | Orchestrated 3-tier compliance resolver for a topic |
| `cms_search_policy` | Tier-1 library search (live Drive embedded view) — reports coverage gap if none found |
| `cms_risk_lookup` | Bangladesh legal risks by SBU/area/topic with legal basis + penalty + level |
| `cms_bdlaws_act` | Official bdlaws link + metadata for the 20 core acts |
| `cms_document_compliance` | 55 ERP document types → 3-tier compliance mapping + owner |
| `cms_business_documents` | 42 ERP business documents inventory |
| `cms_coverage_scan` | Catalog coverage by domain/category + registered asset counts |
| `cms_gap_report` | Coverage gap rows + risk-register summary |
| `cms_stats` | CMS inventory statistics |

## Run

```bash
node server-arl-cms.js
```

Environment variables:
- `ARL_CMS_DRIVE_FOLDER` — override the Tier-1 policy library Drive folder id
  (default `1F_OGk1yzP_nf_TD8NbInJOpS-MYLR3xX`)
- `ARL_CMS_DMS_TREE` — path to the ARL-DMS `tree.json` (Hybrid integration).
  When set, `cms_search_policy` / Tier-1 resolution searches the shared
  14,535-entry DMS index and returns real documents (name, path, drive id, url,
  source). Default lookup order: env → sibling `../arl-dms/data/tree.json` →
  bundled `data/dms-tree.json` → skill library paths.
- `ARL_CMS_DRIVE_FOLDER` — fallback live-Drive root when no shared index found.

## Notes

- Read-only by design. Bundles the catalog data; no external DB required.
- **Hybrid integration (Option 5):** the CMS MCP reads the shared ARL-DMS index
  for Tier-1 document search; document text/OCR is fetched via the ARL-DMS MCP
  (`dms_fetch`). The ARL-CMS skill and ARL-DMS skill document this cross-reference.
- Shareable as a single npm package (`.tgz`) via `npx -y <github-release-url>`.