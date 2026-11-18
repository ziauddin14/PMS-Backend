import { ObjectId, type Db } from 'mongodb';
import type { PoLotRef } from '../contracts/operations.js';
import {
  PURCHASE_ORDERS_COLLECTION,
  type PurchaseOrderDoc,
} from '../purchaseOrders/definitions.js';
import { OPENING_STOCK_COLLECTION, type OpeningStockDoc } from './openingStockDefinitions.js';

/**
 * Stock lots (CD-13). A lot is a PO line, or a line of an opening-stock entry (special non-PO
 * lot for goods that were already in a warehouse). Both are stored the same way in the ledger:
 * `purchaseOrderId` = owner record id, `poLineId` = line id.
 */
export interface ResolvedLot {
  kind: 'PO' | 'OPENING';
  ownerId: ObjectId;
  ownerCode: string;
  /** PO number, or the opening entry's reference ("Opening stock" when none). */
  label: string;
  lineId: ObjectId;
  lineNo: number;
  itemId: ObjectId;
  /** PO lots only. */
  vendorId: ObjectId | null;
  /** False when the owner record is cancelled. */
  active: boolean;
}

export const OPENING_LOT_LABEL = 'Opening stock';

/** Resolves lots by line id from purchase orders and opening-stock entries. */
export async function resolveLots(
  db: Db,
  lineIds: Iterable<ObjectId | string>,
): Promise<Map<string, ResolvedLot>> {
  const ids = [...new Set([...lineIds].map((id) => id.toString()))].map((id) => new ObjectId(id));
  const result = new Map<string, ResolvedLot>();
  if (ids.length === 0) return result;
  const [pos, openings] = await Promise.all([
    db
      .collection<PurchaseOrderDoc>(PURCHASE_ORDERS_COLLECTION)
      .find({ 'lines._id': { $in: ids } })
      .toArray(),
    db
      .collection<OpeningStockDoc>(OPENING_STOCK_COLLECTION)
      .find({ 'lines._id': { $in: ids } })
      .toArray(),
  ]);
  for (const po of pos) {
    for (const line of po.lines) {
      result.set(line._id.toHexString(), {
        kind: 'PO',
        ownerId: po._id,
        ownerCode: po.code,
        label: po.poNumber,
        lineId: line._id,
        lineNo: line.lineNo,
        itemId: line.itemId,
        vendorId: po.vendorId,
        active: po.lifecycle.state === 'ACTIVE',
      });
    }
  }
  for (const entry of openings) {
    for (const line of entry.lines) {
      result.set(line._id.toHexString(), {
        kind: 'OPENING',
        ownerId: entry._id,
        ownerCode: entry.code,
        label: entry.reference ?? OPENING_LOT_LABEL,
        lineId: line._id,
        lineNo: line.lineNo,
        itemId: line.itemId,
        vendorId: null,
        active: entry.lifecycle.state === 'ACTIVE',
      });
    }
  }
  return result;
}

export function lotRefOf(
  lots: Map<string, ResolvedLot>,
  ownerId: ObjectId,
  lineId: ObjectId,
): PoLotRef {
  const lot = lots.get(lineId.toHexString());
  return {
    purchaseOrderId: ownerId.toHexString(),
    purchaseOrderCode: lot?.ownerCode ?? '',
    poNumber: lot?.label ?? '(missing lot)',
    poLineId: lineId.toHexString(),
    poLineNo: lot?.lineNo ?? 0,
  };
}
