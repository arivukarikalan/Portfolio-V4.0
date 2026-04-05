import { EXIT_STRATEGY_STORE } from '../core/constants';
import type { ExitStrategyScenario } from '../core/types';
import { openFinanceDb } from './db';

export async function listExitStrategies(userId: string): Promise<ExitStrategyScenario[]> {
  const db = await openFinanceDb();
  const all = await db.getAll(EXIT_STRATEGY_STORE);
  return all
    .filter((scenario) => scenario.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addExitStrategy(input: ExitStrategyScenario): Promise<ExitStrategyScenario> {
  const db = await openFinanceDb();
  await db.put(EXIT_STRATEGY_STORE, input);
  return input;
}

export async function updateExitStrategy(
  scenarioId: string,
  userId: string,
  updates: Partial<Omit<ExitStrategyScenario, 'id' | 'userId' | 'createdAt'>>
): Promise<ExitStrategyScenario | null> {
  const db = await openFinanceDb();
  const existing = await db.get(EXIT_STRATEGY_STORE, scenarioId);
  if (!existing || existing.userId !== userId) return null;
  const updated: ExitStrategyScenario = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  await db.put(EXIT_STRATEGY_STORE, updated);
  return updated;
}

export async function deleteExitStrategy(scenarioId: string, userId: string): Promise<boolean> {
  const db = await openFinanceDb();
  const existing = await db.get(EXIT_STRATEGY_STORE, scenarioId);
  if (!existing || existing.userId !== userId) return false;
  await db.delete(EXIT_STRATEGY_STORE, scenarioId);
  return true;
}

export async function replaceExitStrategiesForUser(
  userId: string,
  scenarios: ExitStrategyScenario[]
): Promise<void> {
  const db = await openFinanceDb();
  const tx = db.transaction(EXIT_STRATEGY_STORE, 'readwrite');
  const store = tx.objectStore(EXIT_STRATEGY_STORE);
  const existing = await store.getAll();
  existing.forEach((row) => {
    if (row.userId === userId) {
      store.delete(row.id);
    }
  });
  scenarios.forEach((scenario) => {
    if (scenario.userId === userId) {
      store.put(scenario);
    }
  });
  await tx.done;
}
