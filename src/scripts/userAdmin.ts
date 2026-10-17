/**
 * User administration CLI (local administrators only).
 *
 *   npm run user-admin -- create --username usman --display-name "Usman" --role OPERATOR
 *   npm run user-admin -- set-password --username usman
 *   npm run user-admin -- set-role --username usman --role VIEWER
 *   npm run user-admin -- disable --username usman --reason "Left the department"
 *   npm run user-admin -- unlock --username usman
 *   npm run user-admin -- list
 *
 * Passwords are never accepted as command-line arguments (they would end up in shell history).
 * They are read from a hidden prompt, or from standard input when it is piped.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { AuthService } from '../auth/authService.js';
import { ensureAuthCollections } from '../auth/collections.js';
import { UserAdmin } from '../auth/userAdmin.js';
import { ConfigError, loadConfig } from '../config/env.js';
import { userRoles, type UserRole } from '../contracts/api.js';
import { ensureInfrastructureCollections } from '../db/collections.js';
import { connectToDatabase } from '../db/mongo.js';
import { AppError } from '../errors.js';
import { createLogger } from '../logger.js';
import { RecordStore } from '../records/recordStore.js';

const out = (line: string) => process.stdout.write(`${line}\n`);
const fail = (line: string): never => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(prompt);
  muted = true;
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function readNewPassword(): Promise<string> {
  const first = await readPassword('New password (min 12 characters): ');
  if (process.stdin.isTTY) {
    const second = await readPassword('Repeat password: ');
    if (first !== second) fail('Passwords do not match.');
  }
  return first;
}

function parseRole(value: string | undefined): UserRole {
  const role = (value ?? '').toUpperCase();
  if (!(userRoles as readonly string[]).includes(role)) {
    fail(`--role must be one of: ${userRoles.join(', ')}`);
  }
  return role as UserRole;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      username: { type: 'string' },
      'display-name': { type: 'string' },
      role: { type: 'string' },
      reason: { type: 'string' },
    },
    strict: true,
  });

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
    await ensureAuthCollections(database.db);
    const auth = new AuthService(database, config.auth);
    const admin = new UserAdmin(
      database.db,
      new RecordStore(database),
      { type: 'SYSTEM', label: 'cli:user-admin' },
      (userId) => auth.revokeAllSessions(userId),
    );
    const username = values.username ?? '';

    switch (command) {
      case 'create': {
        if (!username || !values['display-name']) {
          fail('create requires --username, --display-name and --role');
        }
        const role = parseRole(values.role);
        const user = await admin.create({
          username,
          displayName: values['display-name'] ?? '',
          role,
          password: await readNewPassword(),
        });
        out(`Created ${user.code} (${user.username}, ${user.role}).`);
        break;
      }
      case 'set-password':
        if (!username) fail('set-password requires --username');
        await admin.setPassword(username, await readNewPassword());
        out('Password changed; existing sessions were signed out.');
        break;
      case 'set-role':
        if (!username) fail('set-role requires --username and --role');
        await admin.setRole(username, parseRole(values.role));
        out('Role changed; existing sessions were signed out.');
        break;
      case 'disable':
        if (!username || !values.reason) fail('disable requires --username and --reason');
        await admin.disable(username, values.reason ?? '');
        out('Account disabled; existing sessions were signed out.');
        break;
      case 'unlock':
        if (!username) fail('unlock requires --username');
        out(
          (await auth.clearLockout(username))
            ? 'Sign-in lockout cleared.'
            : 'No active lockout or failure count for that username.',
        );
        break;
      case 'list':
        for (const u of await admin.list()) {
          out(
            `${u.code}  ${u.username.padEnd(20)} ${u.role.padEnd(9)} ${u.state}  ${u.displayName}`,
          );
        }
        break;
      default:
        fail('Usage: user-admin <create|set-password|set-role|disable|unlock|list> [options]');
    }
  } catch (error) {
    if (error instanceof AppError) {
      const details = error.details?.map((d) => `  - ${d.message}`).join('\n');
      fail(details ? `${error.message}\n${details}` : error.message);
    }
    throw error;
  } finally {
    await database.close();
  }
}

void main();
