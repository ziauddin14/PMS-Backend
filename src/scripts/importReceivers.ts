/**
 * Loads division receivers (name and phone per city) from a JSON file.
 *
 *   npm run import-receivers -- --file <receivers.json>            (dry run: shows matches)
 *   npm run import-receivers -- --file <receivers.json> --commit   (writes)
 *
 * JSON shape (one row per receiver, e.g. converted from the department's receiver sheet):
 *   { "source": "Receiver Name number.xlsx",
 *     "receivers": [{ "province": "", "division": "", "city": "", "name": "", "phone": "" }] }
 *
 * Each row is matched to an existing city in that division (names compared ignoring case, spaces
 * and punctuation, so "DG khan" matches "D.G. Khan"). Rows whose province, division or city cannot
 * be found are listed and skipped — nothing is invented. A receiver whose name already exists in
 * that city is left unchanged, so the import can be run again safely. The file contains personal
 * data: keep it out of the repository and never print it.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { ConfigError, loadConfig } from '../config/env.js';
import { ensureInfrastructureCollections } from '../db/collections.js';
import { connectToDatabase } from '../db/mongo.js';
import type { MutationContext } from '../domain/context.js';
import { AppError } from '../errors.js';
import { createLogger } from '../logger.js';
import { ensureMasterDataCollections, type MasterRecordDoc } from '../masterData/definitions.js';
import { MasterDataService } from '../masterData/masterDataService.js';
import { RecordStore } from '../records/recordStore.js';

const text = z.string().trim().min(1).max(100);
const fileSchema = z.object({
  source: z.string().trim().min(1).max(200).optional(),
  receivers: z.array(
    z.object({
      province: text,
      division: text,
      city: text,
      name: text,
      phone: z.string().trim().max(30).optional(),
    }),
  ),
});
type ReceiverRow = z.infer<typeof fileSchema>['receivers'][number];

/** Loose comparison key: lower case, letters and digits only. */
export function looseKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export interface LocationTree {
  provinces: Array<Pick<MasterRecordDoc, '_id' | 'name'>>;
  divisions: Array<Pick<MasterRecordDoc, '_id' | 'name' | 'provinceId'>>;
  districts: Array<Pick<MasterRecordDoc, '_id' | 'name' | 'divisionId'>>;
  cities: Array<Pick<MasterRecordDoc, '_id' | 'name' | 'districtId' | 'active'>>;
}

export type MatchResult =
  | { ok: true; row: ReceiverRow; rowNo: number; cityId: string; cityName: string }
  | { ok: false; row: ReceiverRow; rowNo: number; reason: string };

/** Matches every row to a city inside its division and province. Pure; used by tests. */
export function matchReceivers(rows: ReceiverRow[], tree: LocationTree): MatchResult[] {
  const id = (oid: ObjectId | undefined) => oid?.toHexString() ?? '';
  return rows.map((row, index) => {
    const rowNo = index + 2; // sheet row number (row 1 is the header)
    const provinces = tree.provinces.filter((p) => looseKey(p.name) === looseKey(row.province));
    if (provinces.length === 0) {
      return { ok: false, row, rowNo, reason: `province "${row.province}" not found` };
    }
    const provinceIds = new Set(provinces.map((p) => id(p._id)));
    const divisions = tree.divisions.filter(
      (d) => provinceIds.has(id(d.provinceId)) && looseKey(d.name) === looseKey(row.division),
    );
    if (divisions.length === 0) {
      return {
        ok: false,
        row,
        rowNo,
        reason: `division "${row.division}" not found in province "${row.province}"`,
      };
    }
    const divisionIds = new Set(divisions.map((d) => id(d._id)));
    const districtIds = new Set(
      tree.districts.filter((d) => divisionIds.has(id(d.divisionId))).map((d) => id(d._id)),
    );
    const cities = tree.cities.filter(
      (c) => districtIds.has(id(c.districtId)) && looseKey(c.name) === looseKey(row.city),
    );
    const activeCities = cities.filter((c) => c.active);
    if (activeCities.length === 0) {
      return {
        ok: false,
        row,
        rowNo,
        reason:
          cities.length > 0
            ? `city "${row.city}" is inactive`
            : `city "${row.city}" not found in division "${row.division}"`,
      };
    }
    if (activeCities.length > 1) {
      return {
        ok: false,
        row,
        rowNo,
        reason: `city "${row.city}" exists in more than one district of "${row.division}"`,
      };
    }
    const city = activeCities[0]!;
    return { ok: true, row, rowNo, cityId: id(city._id), cityName: city.name };
  });
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const fail = (line: string): never => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { file: { type: 'string' }, commit: { type: 'boolean', default: false } },
    strict: true,
  });
  const file = values.file ?? fail('Usage: import-receivers --file <receivers.json> [--commit]');
  const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success) return fail(`Invalid file:\n${z.prettifyError(parsed.error)}`);
  const commit = values.commit ?? false;

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }

  const database = await connectToDatabase(config.mongodb, createLogger('warn'));
  try {
    // A dry run only reads: collections and indexes are created on --commit (or API start-up).
    if (commit) {
      await ensureInfrastructureCollections(database.db);
      await ensureMasterDataCollections(database.db);
    }
    const db = database.db;
    const all = (name: string) => db.collection<MasterRecordDoc>(name).find({}).toArray();
    const [provinces, divisions, districts, cities] = await Promise.all([
      all('provinces'),
      all('divisions'),
      all('districts'),
      all('cities'),
    ]);
    const results = matchReceivers(parsed.data.receivers, {
      provinces,
      divisions,
      districts,
      cities,
    });

    const service = new MasterDataService(database, new RecordStore(database));
    const ctx: MutationContext = {
      actor: { type: 'IMPORT', label: 'cli:import-receivers' },
      provenance: { sourceType: 'SYSTEM', workbook: parsed.data.source ?? basename(file) },
    };
    let existing = 0;
    let created = 0;
    for (const result of results) {
      if (!result.ok) continue;
      const found = await service.findByName('receivers', result.row.name, result.cityId);
      if (found) {
        existing++;
        continue;
      }
      created++;
      if (!commit) continue;
      await service.create(
        'receivers',
        {
          name: result.row.name,
          cityId: result.cityId,
          ...(result.row.phone ? { phone: result.row.phone } : {}),
        },
        ctx,
      );
    }

    const skipped = results.filter((r): r is Extract<MatchResult, { ok: false }> => !r.ok);
    out(commit ? 'Import finished.' : 'Dry run: nothing was written. Add --commit to write.');
    out(`Rows in file:          ${results.length}`);
    out(`Already in PMS:        ${existing}`);
    out(`${commit ? 'Created:      ' : 'Would create: '}         ${created}`);
    out(`Skipped (no match):    ${skipped.length}`);
    // Only locations are printed — never receiver names or phone numbers.
    for (const s of skipped) out(`  row ${s.rowNo}: ${s.reason}`);
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

// Run only when executed directly (the matcher is also imported by tests).
if (process.argv[1] && /importReceivers\.[jt]s$/.test(process.argv[1])) void main();
