import { GOALS_STORE } from '../core/constants';
import type { GoalPlan } from '../core/types';
import { openFinanceDb } from './db';

export type GoalInput = Omit<GoalPlan, 'id' | 'createdAt' | 'updatedAt' | 'userId'> & {
  userId: string;
};

export async function listGoals(userId: string): Promise<GoalPlan[]> {
  const db = await openFinanceDb();
  const all = await db.getAll(GOALS_STORE);
  return all.filter((goal) => goal.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addGoal(input: GoalInput): Promise<GoalPlan> {
  const db = await openFinanceDb();
  const now = new Date().toISOString();
  const record: GoalPlan = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...input
  };
  await db.put(GOALS_STORE, record);
  return record;
}

export async function updateGoal(
  goalId: string,
  userId: string,
  updates: Partial<Omit<GoalPlan, 'id' | 'userId' | 'createdAt'>>
): Promise<GoalPlan | null> {
  const db = await openFinanceDb();
  const existing = await db.get(GOALS_STORE, goalId);
  if (!existing || existing.userId !== userId) return null;
  const updated: GoalPlan = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  await db.put(GOALS_STORE, updated);
  return updated;
}

export async function deleteGoal(goalId: string, userId: string): Promise<boolean> {
  const db = await openFinanceDb();
  const existing = await db.get(GOALS_STORE, goalId);
  if (!existing || existing.userId !== userId) return false;
  await db.delete(GOALS_STORE, goalId);
  return true;
}

export async function replaceGoalsForUser(userId: string, rows: GoalPlan[]): Promise<void> {
  const db = await openFinanceDb();
  const tx = db.transaction(GOALS_STORE, 'readwrite');
  const store = tx.objectStore(GOALS_STORE);
  const existing = await store.getAll();
  existing.forEach((row) => {
    if (row.userId === userId) {
      store.delete(row.id);
    }
  });
  rows.forEach((row) => {
    if (row.userId === userId) {
      store.put(row);
    }
  });
  await tx.done;
}
