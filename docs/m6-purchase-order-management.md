# M6 — Purchase Order and Vendor Management: Implementation Notes

**Scope:** Registering, listing, editing, cancelling, and viewing Purchase Orders (PO), their item lines, planned payment schedules, invoice metadata, and route configuration. Based on frozen M1 requirements (`docs/requirements/02`–`06`). Reuses M4 Master Data (Vendors, Items, Warehouses, Divisions) and M5 Demand links. No workbook is read, imported, or synced. Sync jobs are queued only for `PRD` / `PO` (processed in M10).

---

## 1. M1 Requirements Used

| Ref                 | Requirement               | How M6 Applies It                                                                                                                                                                              |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `03` P1, CD-11      | Stable PO identifier      | System PMS code `PO-000001` generated atomically via M2 RecordStore counter. Immutable.                                                                                                        |
| `03` P2, Rule 1     | PO Number                 | User-provided `poNumber` validated unique case-insensitively and whitespace-normalized (`normalizePoNumber`). Searchable.                                                                      |
| `02` §2.2, `03` P3  | Vendor reference          | Required reference to M4 `vendors` collection. Must be active on creation/change. Historical deactivated vendor kept on edit if unchanged.                                                     |
| `03` P4, P5         | Multi-line PO             | 1–200 lines per PO. Each line references an item from M4 `items` master.                                                                                                                       |
| `03` §2.2, BRD      | Route & Target            | Supports both routes: `WAREHOUSE` (target warehouse required) and `DIRECT` (destination division required). Prevents stock double-counting.                                                    |
| `03` P8, BRD Rule 4 | PO Completion Rule        | Completion is derived, default `PENDING`. Vendor delivery completion tracking only; legacy `PO!J Delivered` dispatches are not vendor receipts. Full receiving transactions belong to M7.      |
| `03` P12, CD-06     | Payment Planning          | Approved amount recorded; payment schedule entries (`entryNo`, `dueDate`, `plannedAmount`, `note`) kept separate from actual M9 payment transactions.                                          |
| `03` Locked Rule    | One Invoice per PO        | PO-level invoice metadata (`invoiceNo`, `invoiceDate`, `invoiceAmount`, `notes`) shared across all lines and destinations. Division-specific invoices prohibited.                              |
| `03` Demand link    | Optional Demand Line link | PO line optionally links to a demand line; validates that the PO line item matches the demand line item.                                                                                       |
| `03` P9             | Cancellation              | Cancellation by archive (`RecordStore.archive`), requiring a non-empty cancellation reason (1–500 chars) and optimistic concurrency `rev`. Record is preserved and blocked from further edits. |
| `03` U6, CD-06      | Audit Trail & Sync        | M2 `RecordStore`: `CREATE`, `UPDATE`, `ARCHIVE` audit events with actor provenance in the same transaction; queues outbound `PENDING` sync job for `PRD` / `PO`.                               |

---

## 2. Data Model (`purchase_orders` collection)

| Field                    | Type             | Notes                                                                             |
| ------------------------ | ---------------- | --------------------------------------------------------------------------------- |
| `code`                   | string           | `PO-000001` (managed by M2 RecordStore)                                           |
| `rev`                    | number           | Optimistic concurrency revision counter                                           |
| `lifecycle.state`        | string           | `ACTIVE` (open) or `ARCHIVED` (cancelled). Records are never deleted.             |
| `poNumber`               | string           | Cleaned user PO number                                                            |
| `poNumberNormalized`     | string           | Case-folded and whitespace-collapsed for unique index                             |
| `poDate`                 | string           | `YYYY-MM-DD` (Asia/Karachi date validation)                                       |
| `vendorId`               | ObjectId         | Reference to `vendors` collection                                                 |
| `deliveryRoute`          | enum             | `'WAREHOUSE'` \| `'DIRECT'`                                                       |
| `targetWarehouseId`      | ObjectId \| null | Required if `deliveryRoute === 'WAREHOUSE'`                                       |
| `destinationDivisionId`  | ObjectId \| null | Required if `deliveryRoute === 'DIRECT'`                                          |
| `approvedAmount`         | number           | Non-negative approved PO budget amount                                            |
| `totalAmount`            | number           | Calculated sum of all line totals                                                 |
| `expectedCompletionDate` | string \| null   | Optional `YYYY-MM-DD`                                                             |
| `notes`                  | string \| null   | Optional notes                                                                    |
| `invoice`                | object \| null   | `invoiceNo`, `invoiceDate`, `invoiceAmount`, `notes`                              |
| `paymentSchedule`        | array            | `entryNo`, `dueDate`, `plannedAmount`, `note`                                     |
| `nextLineNo`             | number           | Monotonic counter for stable line numbers                                         |
| `lines`                  | array            | Line item details with quantity, unit price, line total, and optional demand link |
| `searchText`             | string           | Normalized concatenated text for fast substring search                            |

---

## 3. API Endpoints and Permissions

Every route requires an authenticated session. State-changing requests require the `OPERATOR` role and the `x-csrf-token` header.

| Method & Path                          | Roles            | Description                                                                                                                                                        |
| -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/purchase-orders`             | OPERATOR, VIEWER | List with search, status (`open`, `cancelled`, `all`), `vendorId`, `deliveryRoute`, date range (`from`, `to`), sorting, and pagination (`page`, `pageSize` ≤ 100). |
| `GET /api/purchase-orders/:id`         | OPERATOR, VIEWER | Full detail including lines, payment schedule, and invoice metadata.                                                                                               |
| `POST /api/purchase-orders`            | OPERATOR + CSRF  | Create new purchase order. Returns `201 Created`.                                                                                                                  |
| `PATCH /api/purchase-orders/:id`       | OPERATOR + CSRF  | Edit purchase order. Requires current `rev`. Returns `409 Conflict` on version mismatch or if cancelled.                                                           |
| `POST /api/purchase-orders/:id/cancel` | OPERATOR + CSRF  | Cancel purchase order. Requires `rev` and non-empty `reason`.                                                                                                      |

---

## 4. Dashboard Integration

The dashboard active purchase order indicator (`activePurchaseOrders`) counts active, non-archived purchase orders directly from the database using real counts.
