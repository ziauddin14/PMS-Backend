import { MongoServerError, ObjectId, type Collection, type Filter, type Sort } from 'mongodb';
import type {
  MasterEntityKey,
  MasterRef,
  PurchaseOrderCancelInput,
  PurchaseOrderCreateInput,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderLineInput,
  PurchaseOrderListQuery,
  PurchaseOrderListResponse,
  PurchaseOrderSummary,
  PurchaseOrderUpdateInput,
} from '../contracts/api.js';
import type { Database } from '../db/mongo.js';
import type { MutationContext } from '../domain/context.js';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../errors.js';
import type { MasterRecordDoc } from '../masterData/definitions.js';
import type { RecordStore } from '../records/recordStore.js';
import { DEMANDS_COLLECTION, type DemandDoc } from '../demands/definitions.js';
import { todayInKarachi } from '../demands/demandService.js';
import {
  PURCHASE_ORDERS_COLLECTION,
  purchaseOrderDefinition,
  type PurchaseOrderDoc,
  type PurchaseOrderFields,
  type StoredInvoice,
  type StoredPaymentScheduleEntry,
  type StoredPurchaseOrderLine,
} from './definitions.js';

const EARLIEST_DATE = '2000-01-01';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePoNumber(poNumber: string): string {
  return poNumber.trim().toLowerCase();
}

function isPoNumberDuplicateKey(error: unknown): boolean {
  if (error instanceof MongoServerError && error.code === 11000) {
    if (error.keyPattern && !error.keyPattern.poNumberNormalized) {
      return false;
    }
    return true;
  }
  return false;
}

function searchTextOf(poNumber: string, notes?: string | null, invoiceNo?: string | null): string {
  const parts = [poNumber, notes ?? '', invoiceNo ?? ''];
  return parts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

type RefDocs = Map<string, MasterRecordDoc>;
type DemandDocs = Map<string, DemandDoc>;

/**
 * Purchase Order & Vendor Management (M6).
 * Manages PO lifecycle, delivery routes (warehouse vs direct), vendor references,
 * approved amounts, planned payment schedules, and one complete invoice per PO.
 * Completion is derived from vendor receipts (M7) — until then every line has
 * quantityReceived = 0 and is PENDING.
 */
export class PurchaseOrderService {
  constructor(
    private readonly database: Database,
    private readonly store: RecordStore,
  ) {}

  private get purchaseOrders(): Collection<PurchaseOrderDoc> {
    return this.database.db.collection<PurchaseOrderDoc>(PURCHASE_ORDERS_COLLECTION);
  }

  private get demands(): Collection<DemandDoc> {
    return this.database.db.collection<DemandDoc>(DEMANDS_COLLECTION);
  }

  private master(entity: MasterEntityKey): Collection<MasterRecordDoc> {
    return this.database.db.collection<MasterRecordDoc>(entity);
  }

  async list(query: PurchaseOrderListQuery): Promise<PurchaseOrderListResponse> {
    const filter: Filter<PurchaseOrderDoc> = {};
    if (query.status === 'open') filter['lifecycle.state'] = 'ACTIVE';
    if (query.status === 'cancelled') filter['lifecycle.state'] = 'ARCHIVED';
    if (query.vendorId) filter.vendorId = new ObjectId(query.vendorId);
    if (query.deliveryRoute) filter.deliveryRoute = query.deliveryRoute;
    if (query.from || query.to) {
      filter.poDate = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
    if (query.search) {
      const pattern = escapeRegex(query.search.toLowerCase().replace(/\s+/g, ' '));
      filter.$or = [
        { code: { $regex: pattern, $options: 'i' } },
        { poNumber: { $regex: pattern, $options: 'i' } },
        { searchText: { $regex: pattern } },
      ];
    }
    const sorts: Record<PurchaseOrderListQuery['sort'], Sort> = {
      poDate_desc: { poDate: -1, code: -1 },
      poDate_asc: { poDate: 1, code: 1 },
      code_desc: { code: -1 },
      code_asc: { code: 1 },
      poNumber_desc: { poNumberNormalized: -1 },
      poNumber_asc: { poNumberNormalized: 1 },
    };
    const [docs, total] = await Promise.all([
      this.purchaseOrders
        .find(filter)
        .sort(sorts[query.sort])
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      this.purchaseOrders.countDocuments(filter),
    ]);
    const refs = await this.loadRefs(docs);
    return {
      items: docs.map((doc) => this.toSummary(doc, refs)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(id: string): Promise<PurchaseOrderDetail> {
    const doc = await this.findOrThrow(id);
    const [refs, demandDocs] = await Promise.all([this.loadRefs([doc]), this.loadDemands([doc])]);
    return this.toDetail(doc, refs, demandDocs);
  }

  async create(
    input: PurchaseOrderCreateInput,
    ctx: MutationContext,
  ): Promise<PurchaseOrderDetail> {
    const errors: ErrorDetail[] = [];
    this.checkDate(input.poDate, 'poDate', errors);
    if (input.expectedCompletionDate) {
      this.checkDate(input.expectedCompletionDate, 'expectedCompletionDate', errors, true);
    }

    const trimmedPoNo = input.poNumber.trim();
    const poNumberNormalized = normalizePoNumber(trimmedPoNo);
    await this.checkPoNumberUniqueness(poNumberNormalized, null, errors);

    const vendor = await this.checkRef(
      'vendors',
      input.vendorId,
      null,
      'vendorId',
      'Vendor',
      errors,
    );

    const routeData = await this.resolveRouteData(
      input.deliveryRoute,
      input.targetWarehouseId ?? null,
      input.destinationDivisionId ?? null,
      null,
      errors,
    );

    const builtLines = await this.buildLines(input.lines, null, errors);
    const paymentSchedule = this.buildSchedule(input.paymentSchedule ?? [], errors);
    const invoice = this.buildInvoice(input.invoice, errors);

    if (errors.length > 0) throw new ValidationError(errors);

    const totalAmount = builtLines.lines.reduce((sum, l) => sum + l.lineTotal, 0);

    const fields: PurchaseOrderFields = {
      poNumber: trimmedPoNo,
      poNumberNormalized,
      poDate: input.poDate,
      vendorId: vendor?._id ?? new ObjectId(input.vendorId),
      deliveryRoute: input.deliveryRoute,
      targetWarehouseId: routeData.targetWarehouseId,
      destinationDivisionId: routeData.destinationDivisionId,
      approvedAmount: input.approvedAmount,
      totalAmount,
      expectedCompletionDate: input.expectedCompletionDate ?? null,
      notes: input.notes ?? null,
      invoice,
      paymentSchedule,
      nextLineNo: builtLines.nextLineNo,
      lines: builtLines.lines,
      searchText: searchTextOf(trimmedPoNo, input.notes, invoice?.invoiceNo),
    };

    let created: PurchaseOrderDoc;
    try {
      created = (await this.store.create(purchaseOrderDefinition, fields, ctx)) as PurchaseOrderDoc;
    } catch (error) {
      if (isPoNumberDuplicateKey(error)) {
        throw new ValidationError([
          { path: 'poNumber', message: `PO number "${trimmedPoNo}" already exists` },
        ]);
      }
      throw error;
    }
    const [refs, demandDocs] = await Promise.all([
      this.loadRefs([created]),
      this.loadDemands([created]),
    ]);
    return this.toDetail(created, refs, demandDocs);
  }

  async update(
    id: string,
    input: PurchaseOrderUpdateInput,
    ctx: MutationContext,
  ): Promise<PurchaseOrderDetail> {
    const current = await this.findOrThrow(id);
    if (current.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This purchase order is cancelled and cannot be changed');
    }
    const errors: ErrorDetail[] = [];
    const changes: Partial<PurchaseOrderFields> = {};

    let poNumber = current.poNumber;
    if (input.poNumber !== undefined) {
      const trimmed = input.poNumber.trim();
      poNumber = trimmed;
      const normalized = normalizePoNumber(trimmed);
      await this.checkPoNumberUniqueness(normalized, current._id, errors);
      changes.poNumber = poNumber;
      changes.poNumberNormalized = normalized;
    }

    if (input.poDate !== undefined) {
      this.checkDate(input.poDate, 'poDate', errors);
      changes.poDate = input.poDate;
    }

    if (input.expectedCompletionDate !== undefined) {
      if (input.expectedCompletionDate) {
        this.checkDate(input.expectedCompletionDate, 'expectedCompletionDate', errors, true);
      }
      changes.expectedCompletionDate = input.expectedCompletionDate;
    }

    if (input.vendorId !== undefined) {
      const vendor = await this.checkRef(
        'vendors',
        input.vendorId,
        current.vendorId,
        'vendorId',
        'Vendor',
        errors,
      );
      changes.vendorId = vendor?._id ?? new ObjectId(input.vendorId);
    }

    const route = input.deliveryRoute ?? current.deliveryRoute;
    if (
      input.deliveryRoute !== undefined ||
      input.targetWarehouseId !== undefined ||
      input.destinationDivisionId !== undefined
    ) {
      const targetWh =
        input.targetWarehouseId === undefined
          ? (current.targetWarehouseId?.toHexString() ?? null)
          : input.targetWarehouseId;
      const destDiv =
        input.destinationDivisionId === undefined
          ? (current.destinationDivisionId?.toHexString() ?? null)
          : input.destinationDivisionId;
      const routeData = await this.resolveRouteData(route, targetWh, destDiv, current, errors);
      changes.deliveryRoute = route;
      changes.targetWarehouseId = routeData.targetWarehouseId;
      changes.destinationDivisionId = routeData.destinationDivisionId;
    }

    if (input.approvedAmount !== undefined) {
      changes.approvedAmount = input.approvedAmount;
    }

    if (input.notes !== undefined) {
      changes.notes = input.notes;
    }

    let invoice = current.invoice;
    if (input.invoice !== undefined) {
      invoice = this.buildInvoice(input.invoice, errors);
      changes.invoice = invoice;
    }

    if (input.paymentSchedule !== undefined) {
      changes.paymentSchedule = this.buildSchedule(input.paymentSchedule, errors);
    }

    if (input.lines !== undefined) {
      const built = await this.buildLines(input.lines, current, errors);
      changes.lines = built.lines;
      changes.nextLineNo = built.nextLineNo;
      changes.totalAmount = built.lines.reduce((sum, l) => sum + l.lineTotal, 0);
    }

    if (errors.length > 0) throw new ValidationError(errors);

    changes.searchText = searchTextOf(
      poNumber,
      changes.notes !== undefined ? changes.notes : current.notes,
      invoice?.invoiceNo,
    );

    let updated: PurchaseOrderDoc;
    try {
      updated = (await this.store.update(
        purchaseOrderDefinition,
        current._id,
        input.rev,
        changes,
        ctx,
      )) as PurchaseOrderDoc;
    } catch (error) {
      if (isPoNumberDuplicateKey(error)) {
        throw new ValidationError([
          { path: 'poNumber', message: `PO number "${poNumber}" already exists` },
        ]);
      }
      throw error;
    }
    const [refs, demandDocs] = await Promise.all([
      this.loadRefs([updated]),
      this.loadDemands([updated]),
    ]);
    return this.toDetail(updated, refs, demandDocs);
  }

  async cancel(
    id: string,
    input: PurchaseOrderCancelInput,
    ctx: MutationContext,
  ): Promise<PurchaseOrderDetail> {
    const current = await this.findOrThrow(id);
    if (current.lifecycle.state === 'ARCHIVED') {
      throw new ConflictError('This purchase order is already cancelled');
    }
    const cancelled = (await this.store.archive(
      purchaseOrderDefinition,
      current._id,
      input.rev,
      input.reason,
      ctx,
    )) as PurchaseOrderDoc;
    const [refs, demandDocs] = await Promise.all([
      this.loadRefs([cancelled]),
      this.loadDemands([cancelled]),
    ]);
    return this.toDetail(cancelled, refs, demandDocs);
  }

  /**
   * Count of active purchase orders that are not yet quantity-complete.
   * Feeds the dashboard indicator (M6).
   */
  async countActiveOrders(): Promise<number> {
    return this.purchaseOrders.countDocuments({ 'lifecycle.state': 'ACTIVE' });
  }

  // ---- Private validation & helper methods ----

  private async findOrThrow(id: string): Promise<PurchaseOrderDoc> {
    if (!ObjectId.isValid(id)) throw new NotFoundError('Purchase order not found');
    const doc = await this.purchaseOrders.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new NotFoundError('Purchase order not found');
    return doc;
  }

  private checkDate(date: string, path: string, errors: ErrorDetail[], allowFuture = false): void {
    if (date < EARLIEST_DATE) {
      errors.push({ path, message: `Date must be on or after ${EARLIEST_DATE}` });
    } else if (!allowFuture && date > todayInKarachi()) {
      errors.push({ path, message: 'Date cannot be in the future' });
    }
  }

  private async checkPoNumberUniqueness(
    normalized: string,
    excludeId: ObjectId | null,
    errors: ErrorDetail[],
  ): Promise<void> {
    const query: Filter<PurchaseOrderDoc> = { poNumberNormalized: normalized };
    if (excludeId) query._id = { $ne: excludeId };
    const existing = await this.purchaseOrders.findOne(query, {
      projection: { _id: 1, poNumber: 1 },
    });
    if (existing) {
      errors.push({
        path: 'poNumber',
        message: `PO number "${existing.poNumber}" already exists`,
      });
    }
  }

  private async checkRef(
    entity: MasterEntityKey,
    id: string,
    previous: ObjectId | null | undefined,
    path: string,
    label: string,
    errors: ErrorDetail[],
  ): Promise<MasterRecordDoc | null> {
    if (!ObjectId.isValid(id)) {
      errors.push({ path, message: `${label} id is invalid` });
      return null;
    }
    const doc = await this.master(entity).findOne({ _id: new ObjectId(id) });
    if (!doc) {
      errors.push({ path, message: `${label} not found` });
      return null;
    }
    const unchanged = previous !== undefined && previous !== null && previous.equals(doc._id);
    if (!doc.active && !unchanged) {
      errors.push({ path, message: `${label} "${doc.name}" is inactive` });
    }
    return doc;
  }

  private async resolveRouteData(
    route: 'WAREHOUSE' | 'DIRECT',
    warehouseId: string | null,
    divisionId: string | null,
    current: PurchaseOrderDoc | null,
    errors: ErrorDetail[],
  ): Promise<{ targetWarehouseId: ObjectId | null; destinationDivisionId: ObjectId | null }> {
    if (route === 'WAREHOUSE') {
      if (!warehouseId) {
        errors.push({
          path: 'targetWarehouseId',
          message: 'Target warehouse is required for warehouse delivery',
        });
        return { targetWarehouseId: null, destinationDivisionId: null };
      }
      const wh = await this.checkRef(
        'warehouses',
        warehouseId,
        current?.targetWarehouseId,
        'targetWarehouseId',
        'Warehouse',
        errors,
      );
      return {
        targetWarehouseId: wh?._id ?? new ObjectId(warehouseId),
        destinationDivisionId: null,
      };
    } else {
      if (!divisionId) {
        errors.push({
          path: 'destinationDivisionId',
          message: 'Destination division is required for direct delivery',
        });
        return { targetWarehouseId: null, destinationDivisionId: null };
      }
      const div = await this.checkRef(
        'divisions',
        divisionId,
        current?.destinationDivisionId,
        'destinationDivisionId',
        'Division',
        errors,
      );
      return {
        targetWarehouseId: null,
        destinationDivisionId: div?._id ?? new ObjectId(divisionId),
      };
    }
  }

  private buildSchedule(
    entries: { entryNo?: number; dueDate: string; plannedAmount: number; note?: string | null }[],
    errors: ErrorDetail[],
  ): StoredPaymentScheduleEntry[] {
    return entries.map((entry, index) => {
      const path = `paymentSchedule.${index}`;
      this.checkDate(entry.dueDate, `${path}.dueDate`, errors, true);
      if (entry.plannedAmount <= 0) {
        errors.push({
          path: `${path}.plannedAmount`,
          message: 'Planned amount must be greater than 0',
        });
      }
      return {
        entryNo: entry.entryNo ?? index + 1,
        dueDate: entry.dueDate,
        plannedAmount: entry.plannedAmount,
        note: entry.note?.trim() || null,
      };
    });
  }

  private buildInvoice(
    inv:
      | {
          invoiceNo?: string | null;
          invoiceDate?: string | null;
          invoiceAmount?: number | null;
          notes?: string | null;
        }
      | null
      | undefined,
    errors: ErrorDetail[],
  ): StoredInvoice | null {
    if (!inv) return null;
    const invoiceNo = inv.invoiceNo?.trim() || null;
    const invoiceDate = inv.invoiceDate?.trim() || null;
    const invoiceAmount =
      inv.invoiceAmount !== undefined && inv.invoiceAmount !== null ? inv.invoiceAmount : null;
    const notes = inv.notes?.trim() || null;

    if (!invoiceNo && !invoiceDate && invoiceAmount === null && !notes) {
      return null;
    }

    if (invoiceDate) {
      this.checkDate(invoiceDate, 'invoice.invoiceDate', errors, true);
    }
    if (invoiceAmount !== null && invoiceAmount < 0) {
      errors.push({ path: 'invoice.invoiceAmount', message: 'Invoice amount cannot be negative' });
    }

    return {
      invoiceNo,
      invoiceDate,
      invoiceAmount,
      notes,
    };
  }

  private async buildLines(
    inputs: PurchaseOrderLineInput[],
    current: PurchaseOrderDoc | null,
    errors: ErrorDetail[],
  ): Promise<{ lines: StoredPurchaseOrderLine[]; nextLineNo: number }> {
    const existing = new Map((current?.lines ?? []).map((l) => [l._id.toHexString(), l]));
    let nextLineNo = current?.nextLineNo ?? 1;
    const seenIds = new Set<string>();
    const seenPairs = new Map<string, number>();
    const lines: StoredPurchaseOrderLine[] = [];

    for (const [index, input] of inputs.entries()) {
      const path = `lines.${index}`;
      const previous = input.id ? existing.get(input.id) : undefined;
      if (input.id && !previous) {
        errors.push({ path: `${path}.id`, message: 'Line does not belong to this purchase order' });
        continue;
      }
      if (input.id) {
        if (seenIds.has(input.id)) {
          errors.push({ path: `${path}.id`, message: 'Line listed twice' });
          continue;
        }
        seenIds.add(input.id);
      }

      const item = await this.checkRef(
        'items',
        input.itemId,
        previous?.itemId,
        `${path}.itemId`,
        'Item',
        errors,
      );

      // Duplicate prevention: duplicate (item, demandLine) pair
      const pairKey = `${input.itemId}:${input.demandLineId ?? 'unlinked'}`;
      const duplicateIndex = seenPairs.get(pairKey);
      if (duplicateIndex !== undefined) {
        errors.push({
          path: `${path}.itemId`,
          message: `This item is already listed on line ${duplicateIndex + 1}. Combine the quantities instead.`,
        });
      } else {
        seenPairs.set(pairKey, index);
      }

      // Check demand association if provided
      let demandId: ObjectId | null = null;
      let demandLineId: ObjectId | null = null;
      if (input.demandId) {
        if (!ObjectId.isValid(input.demandId)) {
          errors.push({ path: `${path}.demandId`, message: 'Demand id is invalid' });
        } else {
          const demand = await this.demands.findOne({ _id: new ObjectId(input.demandId) });
          if (!demand) {
            errors.push({ path: `${path}.demandId`, message: 'Referenced demand not found' });
          } else {
            demandId = demand._id;
            if (input.demandLineId) {
              const dLine = demand.lines.find((l) => l._id.toHexString() === input.demandLineId);
              if (!dLine) {
                errors.push({
                  path: `${path}.demandLineId`,
                  message: 'Line does not exist in referenced demand',
                });
              } else {
                demandLineId = dLine._id;
                // Item on PO line should match item on demand line
                if (item && !dLine.itemId.equals(item._id)) {
                  errors.push({
                    path: `${path}.itemId`,
                    message: 'PO line item does not match the item requested in the demand line',
                  });
                }
              }
            }
          }
        }
      }

      const lineTotal = Math.round(input.quantityOrdered * input.unitPrice * 100) / 100;

      lines.push({
        _id: previous?._id ?? new ObjectId(),
        lineNo: previous?.lineNo ?? nextLineNo++,
        itemId: item?._id ?? new ObjectId(input.itemId),
        demandId,
        demandLineId,
        quantityOrdered: input.quantityOrdered,
        unitPrice: input.unitPrice,
        lineTotal,
        notes: input.notes?.trim() || null,
      });
    }

    return { lines, nextLineNo };
  }

  // ---- Reference loading and DTO transformation ----

  private async loadRefs(docs: PurchaseOrderDoc[]): Promise<{
    vendors: RefDocs;
    warehouses: RefDocs;
    divisions: RefDocs;
    provinces: RefDocs;
    items: RefDocs;
  }> {
    const vendorIds = new Set<string>();
    const warehouseIds = new Set<string>();
    const divisionIds = new Set<string>();
    const itemIds = new Set<string>();

    for (const doc of docs) {
      vendorIds.add(doc.vendorId.toHexString());
      if (doc.targetWarehouseId) warehouseIds.add(doc.targetWarehouseId.toHexString());
      if (doc.destinationDivisionId) divisionIds.add(doc.destinationDivisionId.toHexString());
      for (const line of doc.lines) {
        itemIds.add(line.itemId.toHexString());
      }
    }

    const [vendors, warehouses, divisions, items] = await Promise.all([
      this.fetchMap('vendors', vendorIds),
      this.fetchMap('warehouses', warehouseIds),
      this.fetchMap('divisions', divisionIds),
      this.fetchMap('items', itemIds),
    ]);

    // Load provinces for destination divisions
    const provinceIds = new Set<string>();
    for (const div of divisions.values()) {
      if (div.provinceId) provinceIds.add(div.provinceId.toHexString());
    }
    const provinces = await this.fetchMap('provinces', provinceIds);

    return { vendors, warehouses, divisions, provinces, items };
  }

  private async loadDemands(docs: PurchaseOrderDoc[]): Promise<DemandDocs> {
    const demandIds = new Set<string>();
    for (const doc of docs) {
      for (const line of doc.lines) {
        if (line.demandId) demandIds.add(line.demandId.toHexString());
      }
    }
    if (demandIds.size === 0) return new Map();
    const fetched = await this.demands
      .find({ _id: { $in: Array.from(demandIds).map((id) => new ObjectId(id)) } })
      .toArray();
    return new Map(fetched.map((d) => [d._id.toHexString(), d]));
  }

  private async fetchMap(entity: MasterEntityKey, ids: Set<string>): Promise<RefDocs> {
    if (ids.size === 0) return new Map();
    const objectIds = Array.from(ids).map((id) => new ObjectId(id));
    const records = await this.master(entity)
      .find({ _id: { $in: objectIds } })
      .toArray();
    return new Map(records.map((r) => [r._id.toHexString(), r]));
  }

  private toSummary(
    doc: PurchaseOrderDoc,
    refs: {
      vendors: RefDocs;
      warehouses: RefDocs;
      divisions: RefDocs;
      provinces: RefDocs;
      items: RefDocs;
    },
  ): PurchaseOrderSummary {
    const divDoc = doc.destinationDivisionId
      ? refs.divisions.get(doc.destinationDivisionId.toHexString())
      : null;
    const provDoc = divDoc?.provinceId ? refs.provinces.get(divDoc.provinceId.toHexString()) : null;

    return {
      id: doc._id.toHexString(),
      code: doc.code,
      poNumber: doc.poNumber,
      poDate: doc.poDate,
      status: doc.lifecycle.state === 'ACTIVE' ? 'OPEN' : 'CANCELLED',
      completion: 'PENDING', // derived from vendor receipts (M7)
      vendor: refOf(refs.vendors, doc.vendorId),
      deliveryRoute: doc.deliveryRoute,
      targetWarehouse: doc.targetWarehouseId ? refOf(refs.warehouses, doc.targetWarehouseId) : null,
      destinationDivision: divDoc
        ? {
            id: divDoc._id.toHexString(),
            code: divDoc.code,
            name: divDoc.name,
            active: divDoc.active,
            provinceName: provDoc?.name ?? null,
          }
        : null,
      approvedAmount: doc.approvedAmount,
      totalAmount: doc.totalAmount,
      lineCount: doc.lines.length,
      totalQuantity: doc.lines.reduce((sum, l) => sum + l.quantityOrdered, 0),
      expectedCompletionDate: doc.expectedCompletionDate ?? null,
      rev: doc.rev,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  private toDetail(
    doc: PurchaseOrderDoc,
    refs: {
      vendors: RefDocs;
      warehouses: RefDocs;
      divisions: RefDocs;
      provinces: RefDocs;
      items: RefDocs;
    },
    demandDocs: DemandDocs,
  ): PurchaseOrderDetail {
    const summary = this.toSummary(doc, refs);
    const { lifecycle } = doc;

    const lines: PurchaseOrderLine[] = doc.lines.map((line) => {
      let demandRef: {
        id: string;
        code: string;
        demandDate: string;
        lineNo: number | null;
      } | null = null;
      if (line.demandId) {
        const dDoc = demandDocs.get(line.demandId.toHexString());
        if (dDoc) {
          const dLine = line.demandLineId
            ? dDoc.lines.find((l) => l._id.equals(line.demandLineId!))
            : null;
          demandRef = {
            id: dDoc._id.toHexString(),
            code: dDoc.code,
            demandDate: dDoc.demandDate,
            lineNo: dLine?.lineNo ?? null,
          };
        }
      }

      return {
        id: line._id.toHexString(),
        lineNo: line.lineNo,
        item: refOf(refs.items, line.itemId),
        demand: demandRef,
        quantityOrdered: line.quantityOrdered,
        quantityReceived: 0, // vendor receipts arrive in M7
        quantityRemaining: line.quantityOrdered,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        notes: line.notes ?? null,
        completion: 'PENDING',
      };
    });

    return {
      ...summary,
      notes: doc.notes ?? null,
      invoice: doc.invoice
        ? {
            invoiceNo: doc.invoice.invoiceNo ?? null,
            invoiceDate: doc.invoice.invoiceDate ?? null,
            invoiceAmount: doc.invoice.invoiceAmount ?? null,
            notes: doc.invoice.notes ?? null,
          }
        : null,
      paymentSchedule: doc.paymentSchedule.map((s) => ({
        entryNo: s.entryNo,
        dueDate: s.dueDate,
        plannedAmount: s.plannedAmount,
        note: s.note ?? null,
      })),
      lines,
      cancellation:
        lifecycle.state === 'ARCHIVED' && lifecycle.archivedAt
          ? {
              at: lifecycle.archivedAt.toISOString(),
              reason: lifecycle.archiveReason ?? '',
              by: lifecycle.archivedBy?.label ?? null,
            }
          : null,
    };
  }
}

function refOf(map: RefDocs | undefined, id: ObjectId): MasterRef {
  const doc = map?.get(id.toHexString());
  if (!doc) return { id: id.toHexString(), code: '', name: '(missing record)', active: false };
  return { id: doc._id.toHexString(), code: doc.code, name: doc.name, active: doc.active };
}
