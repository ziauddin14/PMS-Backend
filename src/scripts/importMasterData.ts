/**
 * Loads master data (locations, items, warehouses, vendors) from a JSON file into the database.
 *
 *   npm run import-master -- --file <path to master-data.json>            (dry run: shows counts)
 *   npm run import-master -- --file <path to master-data.json> --commit   (writes)
 *
 * JSON shape:
 *   {
 *     "source": "Production Details.xlsx",
 *     "locations": [{ "province": "", "division": "", "district": "", "city": "" }],
 *     "items": ["…"], "warehouses": ["…"], "departments": ["…"],
 *     "vendors": [{ "name": "Company", "contactPerson": "Person" }]
 *   }
 *
 * Safe to run again: a record whose name already exists (in the same parent for locations) is
 * reused, never duplicated or changed. Every created record gets the normal code, audit event and
 * IMPORT actor. Keep the JSON file out of the repository (it is business data).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ConfigError, loadConfig } from '../config/env.js';
import type { MasterEntityKey } from '../contracts/api.js';
import { ensureInfrastructureCollections } from '../db/collections.js';
import { connectToDatabase } from '../db/mongo.js';
import type { MutationContext } from '../domain/context.js';
import { AppError } from '../errors.js';
import { createLogger } from '../logger.js';
import { ensureMasterDataCollections, nameKeyOf } from '../masterData/definitions.js';
import { MasterDataService } from '../masterData/masterDataService.js';
import { RecordStore } from '../records/recordStore.js';

const name = z.string().trim().min(1).max(100);
const fileSchema = z.object({
  source: z.string().trim().min(1).max(200).optional(),
  locations: z
    .array(z.object({ province: name, division: name, district: name, city: name }))
    .default([]),
  items: z.array(name).default([]),
  warehouses: z.array(name).default([]),
  departments: z.array(name).default([]),
  vendors: z
    .array(z.object({ name, contactPerson: z.string().trim().max(100).optional() }))
    .default([]),
});
type MasterFile = z.infer<typeof fileSchema>;

const out = (line: string) => process.stdout.write(`${line}\n`);
const fail = (line: string): never => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

export interface WantedRecord {
  entity: MasterEntityKey;
  name: string;
  /** Unique key of this record within the file (includes the parent chain for locations). */
  key: string;
  /** Key of the parent record (locations only). */
  parentKey?: string;
  contactPerson?: string;
}

/**
 * Turns the file into levels: provinces and flat lists first, then divisions, districts and
 * cities, so every parent exists before its children are created. Duplicate rows collapse.
 */
export function planMasterImport(data: MasterFile): WantedRecord[][] {
  const key = (...parts: string[]) => parts.map(nameKeyOf).join(' / ');
  const levels: WantedRecord[][] = [[], [], [], []];
  const seen = new Set<string>();
  const add = (level: number, wanted: WantedRecord) => {
    if (seen.has(wanted.key)) return;
    seen.add(wanted.key);
    levels[level]?.push(wanted);
  };
  for (const l of data.locations) {
    const province = key('provinces', l.province);
    const division = key('divisions', l.province, l.division);
    const district = key('districts', l.province, l.division, l.district);
    add(0, { entity: 'provinces', name: l.province, key: province });
    add(1, { entity: 'divisions', name: l.division, key: division, parentKey: province });
    add(2, { entity: 'districts', name: l.district, key: district, parentKey: division });
    add(3, {
      entity: 'cities',
      name: l.city,
      key: key('cities', l.province, l.division, l.district, l.city),
      parentKey: district,
    });
  }
  for (const n of data.items) add(0, { entity: 'items', name: n, key: key('items', n) });
  for (const n of data.warehouses) {
    add(0, { entity: 'warehouses', name: n, key: key('warehouses', n) });
  }
  for (const n of data.departments) {
    add(0, { entity: 'departments', name: n, key: key('departments', n) });
  }
  for (const v of data.vendors) {
    add(0, {
      entity: 'vendors',
      name: v.name,
      key: key('vendors', v.name),
      ...(v.contactPerson ? { contactPerson: v.contactPerson } : {}),
    });
  }
  return levels;
}

const PARENT_INPUT: Partial<Record<MasterEntityKey, 'provinceId' | 'divisionId' | 'districtId'>> = {
  divisions: 'provinceId',
  districts: 'divisionId',
  cities: 'districtId',
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { file: { type: 'string' }, commit: { type: 'boolean', default: false } },
    strict: true,
  });
  const file = values.file ?? fail('Usage: import-master --file <master-data.json> [--commit]');
  const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success) return fail(`Invalid file:\n${z.prettifyError(parsed.error)}`);
  const commit = values.commit ?? false;
  const levels = planMasterImport(parsed.data);

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }

  const logger = createLogger('warn');
  const database = await connectToDatabase(config.mongodb, logger);
  try {
    await ensureInfrastructureCollections(database.db);
    await ensureMasterDataCollections(database.db);
    const service = new MasterDataService(database, new RecordStore(database));
    const ctx: MutationContext = {
      actor: { type: 'IMPORT', label: 'cli:import-master' },
      provenance: { sourceType: 'SYSTEM', workbook: parsed.data.source ?? basename(file) },
    };

    const ids = new Map<string, string>();
    const counts = new Map<MasterEntityKey, { existing: number; created: number }>();
    const tally = (entity: MasterEntityKey) => {
      const c = counts.get(entity) ?? { existing: 0, created: 0 };
      counts.set(entity, c);
      return c;
    };

    for (const level of levels) {
      // A few requests in flight keep a remote database from making this slow.
      let next = 0;
      const worker = async () => {
        while (next < level.length) {
          const w = level[next++] as WantedRecord;
          const parentId = w.parentKey !== undefined ? ids.get(w.parentKey) : undefined;
          // In a dry run a new parent has no id yet, so its children are new as well.
          const existing =
            w.parentKey !== undefined && !parentId
              ? null
              : await service.findByName(w.entity, w.name, parentId);
          if (existing) {
            tally(w.entity).existing++;
            ids.set(w.key, existing.id);
            continue;
          }
          tally(w.entity).created++;
          if (!commit) continue;
          const parentField = PARENT_INPUT[w.entity];
          const created = await service.create(
            w.entity,
            {
              name: w.name,
              ...(parentField ? { [parentField]: parentId } : {}),
              ...(w.contactPerson ? { contactPerson: w.contactPerson } : {}),
            },
            ctx,
          );
          ids.set(w.key, created.id);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    }

    out(commit ? 'Import finished.' : 'Dry run: nothing was written. Add --commit to write.');
    out('List           existing    new');
    for (const [entity, c] of counts) {
      out(
        `${entity.padEnd(14)} ${String(c.existing).padStart(8)} ${String(c.created).padStart(6)}`,
      );
    }
  } catch (error) {
    if (error instanceof AppError) {
      const details = error.details?.map((d) => `  - ${d.path}: ${d.message}`).join('\n');
      fail(details ? `${error.message}\n${details}` : error.message);
    }
    throw error;
  } finally {
    await database.close();
  }
}

// Run only when executed directly (the planner is also imported by tests).
if (process.argv[1] && /importMasterData\.[jt]s$/.test(process.argv[1])) void main();
