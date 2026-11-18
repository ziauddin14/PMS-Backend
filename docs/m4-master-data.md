# M4 — Master Data: Implementation Notes

**Scope:** reference lists that the later milestones (M5–M9) refer to. Based on the frozen M1 requirements; no real workbook data is imported.

## 1. Entities and evidence

| Entity      | Code prefix | M1 evidence                                                                                      |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------ |
| Provinces   | `PRV-`      | BRD §6 Module 2 ("Provinces"); BRD Step 2 demand registration; `02` §1 Location                  |
| Divisions   | `DIV-`      | BRD §6 Module 2 ("Divisions"); `02` §1 Location; PRD `Division Info`                             |
| Departments | `DEP-`      | BRD §6 Module 2 ("Departments"); `02` §1 Department                                              |
| Items       | `ITM-`      | BRD §6 Module 2 ("Items"); `02` §1 Item                                                          |
| Vendors     | `VEN-`      | BRD §6 Module 2 ("Vendors"); `02` §1 Vendor                                                      |
| Warehouses  | `WHS-`      | `02` §1 Warehouse; CD-03 (warehouse route), CD-13 (stock per lot and warehouse)                  |
| Districts   | `DST-`      | Production department's location sheet (`Production Details.xlsx`, Province tab), added after M4 |
| Cities      | `CTY-`      | Same sheet: every city/area with its district, division and province                             |
| Receivers   | `RCV-`      | Department's receiver sheet (`Receiver Name number.xlsx`): receiver name and phone per city      |

Locations form a chain: **province → division → district → city**. Each level stores only its
direct parent (`provinceId`, `divisionId`, `districtId`); API responses add every level above a
record (ids and names), so a city row shows its district, division and province. Vendors have an
optional `contactPerson` (company name = `name`).

**Bulk load:** `npm run import-master -- --file <master-data.json> [--commit]` loads locations,
items, warehouses, departments and vendors from a JSON file (shape in
`src/scripts/importMasterData.ts`). Without `--commit` it only reports counts. It reuses records
whose name already exists (per parent for locations), so it can be run again safely. The JSON file
is business data and stays outside the repository.

**Deliberately not implemented in M4:**

| Not implemented                              | Reason                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cities / districts on demands and dispatches | Dispatch destinations remain divisions. Linking a city/district to demand lines or dispatches is a separate change. Q-10 (Karachi/Lahore/Islamabad at province level) is still open; the sheet lists them as provinces and they were loaded as given.   |
| Item rate, unit, minimum stock               | The meaning of the `Rates` sheet (UPDATE/OLD; rate charged to divisions vs purchase price) is not defined in M1; units are not recorded in the workbooks; minimum stock is Low-confidence (Q-02). Prices belong to demand lines (M5) and PO lines (M6). |
| Bank accounts, transporters                  | Used by payments (M9) and Bilty (M8).                                                                                                                                                                                                                   |
| Legacy spelling aliases                      | Used by historical import and Excel sync (M10); depend on import tooling.                                                                                                                                                                               |
| Seeded records                               | Nothing is pre-loaded by the application. Real values come from the operator or from the department's own list via `import-master`.                                                                                                                     |

**Receivers** (added after M4) sit below cities: `cityId` is required and responses carry the city,
district, division and province. `phone` is optional (digits, spaces, `+`, `-`, brackets). Receiver
names and phones are personal data (Q-30 open, most restrictive default): the list is readable by
the Production Operator only (`403` for read-only users) and the frontend hides the tab for them.
A city cannot be deactivated while it has active receivers.

Load the department's sheet with `npm run import-receivers -- --file <receivers.json> [--commit]`
(`src/scripts/importReceivers.ts`): each row (province, division, city, name, phone) is matched to an
existing city in that division, ignoring case, spaces and punctuation. Rows that do not match are
listed (locations only, never names or phones) and skipped; nothing is invented. The dry run only
reads. Re-running never duplicates a receiver (same name in the same city is reused).

**Text fields** (all lists): invisible control characters are removed and line breaks become spaces;
text is never rejected because of its characters.

## 2. Fields and rules (all six entities)

| Field                         | Rule                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                        | Required, 1–100 characters, no control characters; spaces trimmed and collapsed                                                                                                                               |
| `active`                      | `true` on creation; changed with activate/deactivate                                                                                                                                                          |
| `provinceId` (divisions only) | Required; must exist and be **active** when set or changed                                                                                                                                                    |
| Uniqueness                    | Name unique per entity ignoring case and spacing (`nameKey`); divisions unique per province. Checked first for a clear message, then enforced by a unique index (also under concurrent requests).             |
| Identity, versioning, audit   | M2 `RecordStore`: permanent `_id`, immutable code, `rev` with optimistic concurrency, `createdAt/updatedAt`, actor, audit event for every change. Actor = signed-in user; provenance `PMS_UI`.                |
| No deletion                   | Records are deactivated, never deleted, so later records that reference them keep working. Inactive records are hidden from the default list (`status=active`) and cannot be chosen for new references.       |
| Integrity                     | A province cannot be deactivated while it has active divisions; an inactive division cannot be reactivated while its province is inactive. These are technical consistency rules, not business rules from M1. |

## 3. API

All routes require a session. Writes also require the CSRF header (M3).

| Method & path                                                                              | Roles            | Purpose                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/master/:entity?search=&status=active\|inactive\|all&page=&pageSize=&provinceId=` | OPERATOR, VIEWER | List, name search (literal, case-insensitive), status filter, pagination (≤100 per page), `provinceId` filter for divisions |
| `GET /api/master/:entity/:id`                                                              | OPERATOR, VIEWER | One record                                                                                                                  |
| `POST /api/master/:entity`                                                                 | OPERATOR         | Create `{ name, provinceId? }` → `201`                                                                                      |
| `PATCH /api/master/:entity/:id`                                                            | OPERATOR         | `{ rev, name?, provinceId?, active? }`; stale `rev` → `409`                                                                 |

`:entity` ∈ `provinces, divisions, districts, cities, departments, items, vendors, warehouses`. Create/update take the direct parent only (`provinceId` for divisions, `divisionId` for districts, `districtId` for cities) and `contactPerson` for vendors; lists filter by the same parent field. Responses contain only `id, code, name, active, rev, createdAt, updatedAt` (+ the ids and names of every level above a location record, + `contactPerson` for vendors); internal fields (`nameKey`, lifecycle, actors) are not returned. Errors: `400 VALIDATION_FAILED`, `401`, `403 FORBIDDEN` (read-only users), `403 CSRF_FAILED`, `404`, `409 CONFLICT` (duplicate name, stale revision, active children).

## 4. Collections and indexes

One collection per entity (`provinces`, `divisions`, `departments`, `items`, `vendors`, `warehouses`) with the M2 record validator plus `name`, `nameKey`, `active` (+ `provinceId`). Indexes: base record indexes (`code_unique`, …), `name_unique` (`nameKey`) or `province_name_unique` (`provinceId`, `nameKey`) for divisions, `active_name`, and `province_active` for divisions. Created at API start-up by `ensureMasterDataCollections()`.

## 5. Known limitations

- Province choices in the division form load up to 100 provinces (M1 shows 11 province values).
- No bulk import or export; historical master data arrives with the import tooling (gates AG-03/AG-04).
- No merge of duplicate records (e.g. two spellings of one vendor); that belongs to the alias/review workflow.
- Search matches names only (not codes).
