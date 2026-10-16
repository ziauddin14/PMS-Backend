import type { Db, ObjectId } from 'mongodb';
import type { UserRole } from '../contracts/api.js';
import type { Actor } from '../domain/context.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { RecordStore } from '../records/recordStore.js';
import { AUTH_COLLECTIONS } from './collections.js';
import { checkPasswordPolicy, hashPassword } from './password.js';
import { normaliseUsername, userDefinition, type UserRecord } from './users.js';

/**
 * Account administration used by the `user-admin` command-line tool. There is no self-service
 * sign-up and no default account: every account is created deliberately by an administrator.
 */
export class UserAdmin {
  constructor(
    private readonly db: Db,
    private readonly store: RecordStore,
    private readonly actor: Actor,
    private readonly revokeSessions: (userId: ObjectId) => Promise<number>,
  ) {}

  private find(username: string): Promise<UserRecord | null> {
    return this.db
      .collection<UserRecord>(AUTH_COLLECTIONS.users)
      .findOne({ username: normaliseUsername(username) });
  }

  async create(input: {
    username: string;
    displayName: string;
    role: UserRole;
    password: string;
  }): Promise<UserRecord> {
    const username = normaliseUsername(input.username);
    const problems = checkPasswordPolicy(input.password, username);
    if (problems.length > 0) {
      throw new ValidationError(problems.map((message) => ({ path: 'password', message })));
    }
    if (await this.find(username)) throw new ConflictError(`User "${username}" already exists`);
    return (await this.store.create(
      userDefinition,
      {
        username,
        displayName: input.displayName,
        role: input.role,
        passwordHash: await hashPassword(input.password),
      },
      { actor: this.actor, provenance: { sourceType: 'SYSTEM' } },
    )) as UserRecord;
  }

  /** Sets a new password and signs the user out everywhere. */
  async setPassword(username: string, password: string): Promise<void> {
    const user = await this.requireActive(username);
    const problems = checkPasswordPolicy(password, user.username);
    if (problems.length > 0) {
      throw new ValidationError(problems.map((message) => ({ path: 'password', message })));
    }
    await this.store.update(
      userDefinition,
      user._id,
      user.rev,
      { passwordHash: await hashPassword(password) },
      { actor: this.actor },
    );
    await this.revokeSessions(user._id);
  }

  async setRole(username: string, role: UserRole): Promise<void> {
    const user = await this.requireActive(username);
    await this.store.update(userDefinition, user._id, user.rev, { role }, { actor: this.actor });
    await this.revokeSessions(user._id);
  }

  /** Disables an account (archive, no deletion) and ends its sessions. */
  async disable(username: string, reason: string): Promise<void> {
    const user = await this.requireActive(username);
    await this.store.archive(userDefinition, user._id, user.rev, reason, { actor: this.actor });
    await this.revokeSessions(user._id);
  }

  async list(): Promise<
    Array<Pick<UserRecord, 'code' | 'username' | 'displayName' | 'role'> & { state: string }>
  > {
    const users = await this.db
      .collection<UserRecord>(AUTH_COLLECTIONS.users)
      .find({}, { projection: { passwordHash: 0 } })
      .sort({ username: 1 })
      .toArray();
    return users.map((u) => ({
      code: u.code,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      state: u.lifecycle.state,
    }));
  }

  private async requireActive(username: string): Promise<UserRecord> {
    const user = await this.find(username);
    if (!user || user.lifecycle.state !== 'ACTIVE') throw new NotFoundError('Active user not found');
    return user;
  }
}
