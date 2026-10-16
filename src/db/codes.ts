import { MongoServerError, type Db } from 'mongodb';
import { formatRecordCode } from '../contracts/codes.js';
import { COLLECTIONS } from './collections.js';

interface CounterDoc {
  _id: string;
  seq: number;
}

/**
 * Reserves the next code for `prefix` with an atomic increment. Codes are never reused; a code
 * reserved by a write that later fails leaves a gap. Runs outside any transaction on purpose, so
 * concurrent writers do not conflict on the counter document.
 */
export async function nextRecordCode(db: Db, prefix: string): Promise<string> {
  const counters = db.collection<CounterDoc>(COLLECTIONS.counters);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const doc = await counters.findOneAndUpdate(
        { _id: prefix },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );
      if (!doc) throw new Error('Counter update returned no document');
      return formatRecordCode(prefix, doc.seq);
    } catch (error) {
      // Two first-ever upserts for the same prefix can race; the loser retries.
      if (error instanceof MongoServerError && error.code === 11000) continue;
      throw error;
    }
  }
  throw new Error(`Could not reserve a record code for prefix ${prefix}`);
}
