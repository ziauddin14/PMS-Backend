# M7–M11 — Receiving, Stock, Dispatch, Payments, Sync Status and Reports: Implementation Notes

**Scope:** the operational half of the workflow after a PO exists: vendor goods receiving and stock (M7), dispatch with Bilty and document links (M8), actual vendor payments (M9), Excel-sync queue monitoring (M10, partial — see §6) and reports with CSV export (M11). Synthetic data only; no workbook is read, imported or written.

---

## 1. How the workflow fits together

```
Demand (DMD) ──linked line──► PO (PO) ──receipt──► Receipt (GRN) ──► stock at location × PO lot
                                  │                                     │
                                  │                                     └─dispatch──► Dispatch (DSP) ──► demand line delivered
                                  └─payment──► Payment (PAY)  (independent of completion)
```

| Rule (M1, frozen)                                        | Where it is enforced                                                                                                                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PO completion = required vendor goods received           | `PurchaseOrderService` derives `completion` per line from received quantities only. Dispatch never changes it.                                                                                             |
| Payment status independent of completion                 | `paymentStatus` (UNPAID / PARTIAL / PAID) comes only from active payments vs the approved amount.                                                                                                          |
| Planned schedule (PO) separate from actual payments (M9) | Payments are their own records; a payment may reference a schedule entry number.                                                                                                                           |
| Both routes; direct delivery never warehouse stock       | WAREHOUSE route → receipt goes to the PO's target warehouse. DIRECT route → receipt goes to the destination **division** (`locationKind: DIVISION`). The dashboard "Stock on hand" counts warehouses only. |
| Inventory traceable at PO / item / lot                   | Stock balances are keyed by location × PO line (the lot); every change writes a `stock_movements` ledger row naming the receipt/dispatch.                                                                  |
| `PO!J Delivered` = dispatch to divisions, not receiving  | Dispatches (not receipts) drive demand delivered quantities and queue sync jobs for `PRD/PO` and `DMD/demand sheet `.                                                                                      |
| Audit history; backend role enforcement                  | All records go through `RecordStore` (audit event + sync job in the same transaction). Reads: OPERATOR + VIEWER; writes: OPERATOR + CSRF.                                                                  |

## 2. Preventing double counting

Totals that must never exceed a limit are kept in a `tallies` collection and changed only with a **guarded `$inc` inside the same MongoDB transaction** as the business record (new `RecordStore` _side effects_ hook):

| Tally key               | Limit                      | Changed by               |
| ----------------------- | -------------------------- | ------------------------ |
| `rcv:<poLineId>`        | PO line ordered quantity   | receipt create / cancel  |
| `dsp:<demandLineId>`    | demand line quantity       | dispatch create / cancel |
| `pay:<purchaseOrderId>` | approved amount (in paisa) | payment create / cancel  |

`stock_balances` is decremented only with a `quantity >= n` guard, so stock never goes negative. Concurrent duplicate submissions therefore either succeed within the limit or fail with a `409`/`400` — tested with 6 parallel receipts and 5 parallel payments.

Protections on earlier records:

- **PO edit:** a line with receipts cannot be removed, change item, or drop below the received quantity; the route/location cannot change once goods are received; the approved amount cannot go below the amount paid.
- **PO cancel:** blocked while active receipts or payments exist (cancel those first).
- **Demand edit/cancel:** lines with dispatches cannot be removed, re-pointed or reduced below the dispatched quantity; a demand with dispatches cannot be cancelled.
- **Receipt cancel:** blocked while any of its stock has been dispatched (cancel the dispatch first).

Records are never deleted or edited in place for quantities; corrections are made by cancelling (with a reason, kept in the audit trail) and re-entering.

## 3. Collections

| Collection        | Code | Notes                                                                                                                                                                                         |
| ----------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receipts`        | GRN- | PO, vendor, route, location, date, vendor challan no, lines (PO line, item, qty). Sync: `STOCK`.                                                                                              |
| `dispatches`      | DSP- | Source location, destination division, optional demand, Bilty no, transporter, vehicle, freight, document links, lines (lot, qty, optional demand line). Sync: `PRD/PO`, `DMD/demand sheet `. |
| `vendor_payments` | PAY- | PO, vendor, date, amount, method, reference, schedule entry, notes, document links. Sync: `PRD/PO`.                                                                                           |
| `stock_balances`  | —    | Derived balance per location × PO lot, written only in the same transaction as the ledger row.                                                                                                |
| `stock_movements` | —    | Append-only ledger: RECEIPT, RECEIPT_CANCELLED, DISPATCH, DISPATCH_CANCELLED.                                                                                                                 |
| `tallies`         | —    | Guarded counters (§2).                                                                                                                                                                        |

All are created with validators and indexes at start-up (`ensureOperationsCollections`); the operation is idempotent and does not touch existing data.

## 4. API

Reads: OPERATOR, VIEWER. Writes: OPERATOR + `X-CSRF-Token`. Contracts: `src/contracts/operations.ts`.

| Method & path                                                                                  | Purpose                                                                                |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET/POST /api/receipts`, `GET /api/receipts/:id`, `POST /api/receipts/:id/cancel`             | Goods receiving (full/partial, per PO line)                                            |
| `GET /api/stock/balances`                                                                      | Balances by location kind/location/item/PO; `totalQuantity` across the filter          |
| `GET /api/stock/movements`                                                                     | Inventory ledger with filters and pagination                                           |
| `GET/POST /api/dispatches`, `GET/PATCH /api/dispatches/:id`, `POST /api/dispatches/:id/cancel` | Dispatch; PATCH completes Bilty/transport/documents only                               |
| `GET/POST /api/payments`, `GET /api/payments/:id`, `POST /api/payments/:id/cancel`             | Vendor payments (instalments)                                                          |
| `GET /api/sync/summary`, `GET /api/sync/jobs`, `POST /api/sync/jobs/:id/retry`                 | Sync outbox monitoring; re-queue FAILED/CONFLICT jobs                                  |
| `GET /api/reports/:key?format=json\|csv`                                                       | `purchase-orders`, `receipts`, `stock`, `dispatches`, `payments`, `demands`, `vendors` |

PO summaries now include `totalReceived`, `paidAmount`, `outstandingAmount`, `paymentStatus`; demand lines report real `quantityDelivered` / `fulfilment`. Dashboard indicators `stockLots` (warehouse units), `dispatchesThisMonth` and `outstandingVendorPayments` now carry real values; `activePurchaseOrders` counts open POs not yet quantity-complete.

Reports exclude personal data (receiver names/phones), are capped at 5,000 rows (`truncated: true` when cut), and CSV output is UTF-8 with BOM and guarded against spreadsheet formula injection.

## 5. Assumptions (please confirm)

| Topic                                    | Assumption made                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Over-delivery / substitution (Q-11 open) | Most restrictive: a demand line cannot receive more than requested; a dispatch line must be the same item and destination as the demand line.                        |
| Direct-route fulfilment                  | Direct goods are received into the destination division's stock; the operator records a dispatch (hand-over) within that division to mark the demand line delivered. |
| Over-receipt                             | Not allowed: received ≤ ordered per PO line.                                                                                                                         |
| Overpayment                              | Not allowed: total active payments ≤ approved amount.                                                                                                                |
| Documents                                | The PMS stores document **links** (https) with a label; files stay in Google Drive. Direct Drive upload needs an authorised Google account (not configured).         |
| Division 3 % recovery                    | Not implemented — the recovery rules are not in the code base's requirement notes. The dashboard indicator stays "not available".                                    |
| Sync workbook targets                    | Receipts → `STOCK` workbook; dispatches → `PRD/PO` and `DMD/demand sheet `; payments → `PRD/PO`. Sheet names to be confirmed in M10.                                 |

## 5a. Opening stock (goods already in a warehouse)

Goods that were in a warehouse before PMS, or arrived without a PMS purchase order, are entered on
the Stock screen with **Add opening stock** (OPERATOR). An entry (`opening_stock` collection, code
`OPN-000001`) has a warehouse, date, optional reference (e.g. an old PO number), notes and item
lines. Each line becomes its own stock lot (CD-13 special non-PO lot): the ledger and balances store
the entry id and line id in the same fields as a PO lot, and `src/inventory/lots.ts` resolves both
kinds. In responses the lot's `purchaseOrderCode` is the `OPN-` code and `poNumber` is the reference
(or "Opening stock"). Movements use types `OPENING` / `OPENING_CANCELLED`.

Opening lots are dispatched like PO lots. They never change PO completion or payments, and have no
vendor in the stock report. An entry is cancelled with a reason (never edited); cancelling is
refused while any of its stock has been dispatched. API: `GET/POST /api/stock/opening`,
`GET /api/stock/opening/:id`, `POST /api/stock/opening/:id/cancel`.

## 5b. Photos and documents (Cloudinary uploads)

Dispatches (Bilty), payments, receipts (vendor challan) and purchase orders (invoice) carry up to 20
supporting documents (`{ label, url }`). Besides pasting an `https://` link, the operator can upload
photos or PDFs:

1. The browser asks `POST /api/uploads/signature` (OPERATOR + CSRF, body `{ purpose }` =
   `dispatch` | `payment` | `receipt` | `purchase-order`). The API signs a Cloudinary upload
   (folder `<CLOUDINARY_FOLDER>/<purpose>`, formats jpg/jpeg/png/webp/heic/pdf, SHA-1 signature). The
   API secret never leaves the server; Cloudinary rejects signatures older than about an hour.
2. Photos are shrunk in the browser (longest side 1600 px, JPEG) and sent **directly to Cloudinary**
   (files never pass through Render). Max 10 MB.
3. The returned `https://res.cloudinary.com/…` link is saved as a normal document link. Pages show
   photos as thumbnails.

`GET /api/uploads/config` tells the browser whether uploads are set up. Without the three
`CLOUDINARY_*` variables the upload button is hidden, links still work, and the signature endpoint
returns `503`. Uploaded files are reachable by anyone who has the link (not indexed or listed);
removing a document from a record does not delete the file from Cloudinary.

## 6. M10 status — what is and is not done

Done: every change queues an idempotent outbound job (since M2); the sync status API and screen show queue health per workbook/sheet and let the operator re-queue failed or conflicting jobs.

**Not done (needs your authorisation):** the processor that reads/writes the real Demand, Production and Stock workbooks, conflict detection against live rows, and historical import. These require access to the organisation's workbooks (Google Drive service account) and must not be built against real files without explicit written approval. Until then `processorEnabled` is `false` and no workbook is touched.

## 7. Tests

`test/integration/operations.test.ts` (in-memory replica set, synthetic data):

- **Scenario A — warehouse route:** demand → PO linked to demand → partial and full receipt → completion → warehouse stock → dispatch against the demand line → ledger → Bilty update → instalment payment → overpayment rejected → edit guards → dashboard figures → all seven reports (JSON and CSV) → audit and sync outbox.
- **Scenario B — direct route:** receipt lands in division stock, warehouse stock unchanged, PO complete, hand-over only within that division, demand delivered.
- **Scenario C:** viewer and CSRF enforcement on writes; 6 concurrent receipts (exactly 3 accepted, no double count); 5 concurrent payments (exactly 3 accepted); concurrent duplicate PO numbers return formatted `400` (M6 finding D1); cancellation order and guards; stale revisions; invalid references, cross-PO lines, future dates, insufficient stock; sync retry permissions.
