import { REENTRY_STORE } from '../core/constants';
import type { ReentryPlan } from '../core/types';
import { openFinanceDb } from './db';

export async function listReentryPlans(userId: string): Promise<ReentryPlan[]> {
  const db = await openFinanceDb();
  const all = await db.getAll(REENTRY_STORE);
  return all
    .filter((plan) => plan.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addReentryPlan(input: ReentryPlan): Promise<ReentryPlan> {
  const db = await openFinanceDb();
  await db.put(REENTRY_STORE, input);
  return input;
}

export async function updateReentryPlan(
  planId: string,
  userId: string,
  updates: Partial<Omit<ReentryPlan, 'id' | 'userId' | 'createdAt'>>
): Promise<ReentryPlan | null> {
  const db = await openFinanceDb();
  const existing = await db.get(REENTRY_STORE, planId);
  if (!existing || existing.userId !== userId) return null;
  const updated: ReentryPlan = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  await db.put(REENTRY_STORE, updated);
  return updated;
}

export async function deleteReentryPlan(planId: string, userId: string): Promise<boolean> {
  const db = await openFinanceDb();
  const existing = await db.get(REENTRY_STORE, planId);
  if (!existing || existing.userId !== userId) return false;
  await db.delete(REENTRY_STORE, planId);
  return true;
}

export async function replaceReentryPlansForUser(userId: string, plans: ReentryPlan[]): Promise<void> {
  const db = await openFinanceDb();
  const tx = db.transaction(REENTRY_STORE, 'readwrite');
  const store = tx.objectStore(REENTRY_STORE);
  const existing = await store.getAll();
  existing.forEach((row) => {
    if (row.userId === userId) {
      store.delete(row.id);
    }
  });
  plans.forEach((plan) => {
    if (plan.userId === userId) {
      store.put(plan);
    }
  });
  await tx.done;
}
