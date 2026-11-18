import type { Db } from 'mongodb';
import type { Database } from './db/mongo.js';
import { ensureDispatchCollections } from './dispatch/dispatchDefinitions.js';
import { DispatchService } from './dispatch/dispatchService.js';
import type { OperationsServices } from './http/operationsRoutes.js';
import { ensureLedgerCollections } from './inventory/ledger.js';
import { ensureOpeningStockCollections } from './inventory/openingStockDefinitions.js';
import { OpeningStockService } from './inventory/openingStockService.js';
import { ensureReceiptCollections } from './inventory/receiptDefinitions.js';
import { ReceiptService } from './inventory/receiptService.js';
import { StockService } from './inventory/stockService.js';
import { ensurePaymentCollections, PaymentService } from './payments/paymentService.js';
import type { RecordStore } from './records/recordStore.js';
import { ReportService } from './reports/reportService.js';
import { SyncStatusService } from './sync/syncStatusService.js';

/** Creates (idempotently) the M7–M9 collections, validators and indexes. */
export async function ensureOperationsCollections(db: Db): Promise<void> {
  await ensureLedgerCollections(db);
  await ensureReceiptCollections(db);
  await ensureOpeningStockCollections(db);
  await ensureDispatchCollections(db);
  await ensurePaymentCollections(db);
}

export function createOperations(database: Database, store: RecordStore): OperationsServices {
  return {
    receipts: new ReceiptService(database, store),
    stock: new StockService(database),
    openingStock: new OpeningStockService(database, store),
    dispatches: new DispatchService(database, store),
    payments: new PaymentService(database, store),
    sync: new SyncStatusService(database),
    reports: new ReportService(database),
  };
}
