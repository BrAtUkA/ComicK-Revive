import { storage, STORAGE_KEYS } from './Storage';
import type { SourceSpecV1 } from '@/sources/spec/SourceSpec';

/**
 * UserSourcesManager - Persistence for user-added declarative sources.
 * One key per spec: `user_source_{id}`. The registry loads these at startup
 * and registers a DeclarativeSource for each.
 */
export class UserSourcesManager {
  async getAll(): Promise<SourceSpecV1[]> {
    const byKey = await storage.getByPrefix<SourceSpecV1>(STORAGE_KEYS.USER_SOURCE_PREFIX);
    return Object.values(byKey);
  }

  async get(id: string): Promise<SourceSpecV1 | null> {
    return await storage.get<SourceSpecV1 | null>(STORAGE_KEYS.USER_SOURCE_PREFIX + id, null);
  }

  async save(spec: SourceSpecV1): Promise<void> {
    await storage.set(STORAGE_KEYS.USER_SOURCE_PREFIX + spec.id, spec);
  }

  async remove(id: string): Promise<void> {
    await storage.remove(STORAGE_KEYS.USER_SOURCE_PREFIX + id);
  }
}

export const userSourcesManager = new UserSourcesManager();
