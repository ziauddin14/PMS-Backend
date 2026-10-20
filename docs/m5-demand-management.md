# M5 — Demand Management: Implementation Notes

**Scope:** registering, listing, editing and cancelling demands and their item lines. Based on the frozen M1 requirements (`docs/requirements/02`–`06`). No workbook is read, imported or synced. Sync jobs are queued only; M10 processes them.

## 1. M1 requirements used

| Ref                      | Requirement                                                                           | How M5 applies it                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `03` D1, BRD Rule 1      | Every demand has a unique Demand Number                                               | PMS code `DMD-000001` from the M2 counter, unique and immutable. The format itself is still **Q-04**; see §5.                                                  |
| `03` D2, LOCKED #11      | A demand may contain several items                                                    | A demand holds 1–200 lines                                                                                                                                     |
| `03` §2, A-04            | A demand line is (item, destination)                                                  | Each line has an item, a destination division and a quantity. A repeated (item, destination) pair in one demand is rejected: "Combine the quantities instead." |
| `03` D4, BRD Rule 4      | Remaining = requested − dispatched                                                    | `quantityDelivered` is 0 and `quantityRemaining` equals the quantity until dispatch lines exist (M8)                                                           |
| `03` D8 (assumption)     | Pending → Partially delivered → Delivered                                             | Fulfilment is **derived**, never typed. With no dispatches yet it is always `PENDING`. No manual status field.                                                 |
| `03` D9                  | Cancelled lines exist; PMS needs a Cancelled status with reason                       | The whole demand can be cancelled with a required reason (1–500 characters). Cancelled demands are read-only. Per-line cancellation: §5.                       |
| `02` §2.1 C `Order Date` | `Demand.demandDate`                                                                   | Date-only, required                                                                                                                                            |
| `05` R-16                | Future-dated entries were found; validation rule for dates                            | Dates after today (Asia/Karachi) and before 2000-01-01 are rejected                                                                                            |
| `02` §2.1 J `Dept.`      | `Demand.departmentId`                                                                 | Required reference to the Departments master                                                                                                                   |
| BRD Step 2               | Demand registration by province/division                                              | Requesting province required, requesting division optional. If given, the division must belong to that province.                                               |
| `02` §2.1 F `Item`       | `DemandItem.itemId` resolved from the Item master                                     | Required reference to the Items master                                                                                                                         |
| `02` §2.1 G–I            | Destination (city, division, province)                                                | Stored as a destination **division**, so the province follows from it. City-level destinations wait for Q-10 (see M4 notes).                                   |
| `02` §2.1 K `Demand`     | `DemandItem.qtyRequested`, integer                                                    | Whole number, 1–10,000,000                                                                                                                                     |
| `02` §2.1 L–M, `03` U7   | Receiver name and phone are personal data; role-restricted visibility; masked in logs | Optional per line. Returned only to `OPERATOR`. Never logged. Redacted in audit events.                                                                        |
| `02` §2.1 W `Subject`    | E-mail subject is the only demand identifier today, not unique                        | Stored as the optional, **non-unique** `sourceReference`. Searchable.                                                                                          |
| `02` §4.1, CD-11         | PMS ID separate from historical references                                            | The code is the PMS ID. Historical references are kept as plain text.                                                                                          |
| `03` U6, CD-06           | Every change keeps an audit record of its source                                      | M2 `RecordStore`: CREATE / UPDATE / ARCHIVE audit events with actor and `PMS_UI` provenance, in the same transaction                                           |
| `04`, CD-06              | Two-way sync later; DMD `demand sheet ` is a target                                   | Each write queues a `PENDING` sync job for `DMD` / `demand sheet `. Nothing is processed in M5.                                                                |

## 2. Data model (`demands` collection)

| Field                                | Notes                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`, `rev`, `state`, audit fields | From M2 `RecordStore`. `state` `ACTIVE` = open, `ARCHIVED` = cancelled. Records are never deleted.                                                              |
| `demandDate`                         | `YYYY-MM-DD`                                                                                                                                                    |
| `departmentId`, `provinceId`         | Required master references                                                                                                                                      |
| `divisionId`                         | Optional; must belong to `provinceId`                                                                                                                           |
| `sourceReference`                    | Optional, ≤ 200 characters, not unique                                                                                                                          |
| `lines[]`                            | `_id`, `lineNo`, `itemId`, `destinationDivisionId`, `quantity`, `receiverName`, `receiverPhone`. Line `_id` and `lineNo` stay the same when a demand is edited. |
| `nextLineNo`                         | Line numbers are never reused after a line is removed                                                                                                           |
| `searchText`                         | Lower-cased source reference, used for search                                                                                                                   |

**Indexes:** state + date; department + date; province + date; `lines.itemId`; `lines.destinationDivisionId`. Every list query is paginated (page size ≤ 100).

**Reference rule (same as M4):** a reference that is new or changed must point to an **active** record. A reference that is unchanged only has to exist. So a demand made before a record was deactivated can still be edited, and it keeps its historical reference. The UI shows such a reference as "(inactive)".

## 3. API

Every route requires a session. Writes also require the CSRF header and the `OPERATOR` role.

| Method & path                  | Roles            | Purpose                                                                                                                                                                                                                                                     |
| ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/demands`             | OPERATOR, VIEWER | List. Filters: `search` (code or source reference), `status` `open`\|`cancelled`\|`all` (default `open`), `departmentId`, `provinceId`, `from`, `to`. Sort: `demandDate_desc`\|`demandDate_asc`\|`code_desc`\|`code_asc`. Paging: `page`, `pageSize` ≤ 100. |
| `GET /api/demands/:id`         | OPERATOR, VIEWER | Detail with lines. Receiver name and phone are included only for OPERATOR (`personalDataVisible`).                                                                                                                                                          |
| `POST /api/demands`            | OPERATOR + CSRF  | Create. Returns `201`.                                                                                                                                                                                                                                      |
| `PATCH /api/demands/:id`       | OPERATOR + CSRF  | Edit. Requires `rev`. A stale `rev` gives `409`. A cancelled demand gives `409`. A line `id` from a different demand gives `400`.                                                                                                                           |
| `POST /api/demands/:id/cancel` | OPERATOR + CSRF  | Cancel with `rev` and `reason`. Cancelling twice gives `409`.                                                                                                                                                                                               |

Validation errors return `400` with `details[].path`, for example `lines.0.quantity`. The UI uses these paths to show each message next to its field.

**Dashboard:** the `openDemands` indicator now shows the number of lines in open demands. If the count fails, it shows `not_available` again. The other indicators are unchanged.

## 4. Frontend

| Route               | Page                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/demands`          | Search, filters (status, province, department, date range), sort, pagination; loading, error, empty and no-results states |
| `/demands/new`      | Create form with a line editor (OPERATOR only)                                                                            |
| `/demands/:id`      | Detail, lines, cancellation note; Edit and Cancel buttons for OPERATOR on open demands                                    |
| `/demands/:id/edit` | Edit form. Keeps inactive current references selectable. Sends `rev` and the line ids.                                    |

The form checks fields in the browser (required fields, whole-number quantities, no future dates, no duplicate item and destination pairs) and also shows the server's errors next to each field.

## 5. Not implemented, and open questions

| Item                                           | Reason                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Final Demand Number format                     | **Q-04** is open. The PMS code `DMD-nnnnnn` serves as the unique number. The e-mail subject is kept as a non-unique reference.                 |
| Over-delivery and item substitution            | **Q-11** is open. There is no dispatch yet (M8).                                                                                               |
| Payment, confirmation and code-upload statuses | **Q-12** (controlled lists) is open, and these belong to M8 and M9. No status field was invented.                                              |
| Who may see receiver data                      | **Q-30** is open. The most restrictive default applies: OPERATOR only.                                                                         |
| Partial and delivered fulfilment               | D8 is an assumption. Fulfilment is derived from dispatch lines, which arrive in M8. Until then every line is `PENDING`.                        |
| Unit rate and amounts (`Rate`, `Amount …`)     | What "rate" means (charged to divisions, or purchase price) is not defined in M1. See also the M4 notes.                                       |
| Demand PDF attachments                         | Google Drive integration belongs to M8 (LOCKED #5).                                                                                            |
| Cancelling a single line                       | D9 says a Cancelled status with reason. M5 cancels the whole demand. A line can be removed while the demand is open; the audit trail keeps it. |
| Duplicate detection across demands             | M1 has no approved matching rule (`02` §4.3 needs a review workflow). Only duplicate lines within one demand are rejected (A-04).              |
| Destination province must match the requester  | Not stated in M1. Not enforced.                                                                                                                |
| Historical import and Excel sync               | M10. Sync jobs are queued only.                                                                                                                |
