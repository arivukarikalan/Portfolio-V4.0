import { RECOVERY_STORE } from '../core/constants';
import type { RecoveryPlan } from '../core/types';
import { openFinanceDb } from './db';

export async function listRecoveryPlans(userId: string): Promise<RecoveryPlan[]> {
  const db = await openFinanceDb();
  const all = await db.getAll(RECOVERY_STORE);
  return all
    .filter((plan) => plan.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addRecoveryPlan(input: RecoveryPlan): Promise<RecoveryPlan> {
  const db = await openFinanceDb();
  await db.put(RECOVERY_STORE, input);
  return input;
}

export async function updateRecoveryPlan(
  planId: string,
  userId: string,
  updates: Partial<Omit<RecoveryPlan, 'id' | 'userId' | 'createdAt'>>
): Promise<RecoveryPlan | null> {
  const db = await openFinanceDb();
  const existing = await db.get(RECOVERY_STORE, planId);
  if (!existing || existing.userId !== userId) return null;
  const updated: RecoveryPlan = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  await db.put(RECOVERY_STORE, updated);
  return updated;
}

export async function deleteRecoveryPlan(planId: string, userId: string): Promise<boolean> {
  const db = await openFinanceDb();
  const existing = await db.get(RECOVERY_STORE, planId);
  if (!existing || existing.userId !== userId) return false;
  await db.delete(RECOVERY_STORE, planId);
  return true;
}

export async function replaceRecoveryPlansForUser(userId: string, plans: RecoveryPlan[]): Promise<void> {
  const db = await openFinanceDb();
  const tx = db.transaction(RECOVERY_STORE, 'readwrite');
  const store = tx.objectStore(RECOVERY_STORE);
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
