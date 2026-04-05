import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  ACTIVITY_STORE,
  DB_NAME,
  DB_VERSION,
  EXIT_STRATEGY_STORE,
  PRICES_STORE,
  SETTINGS_STORE,
  SESSION_KEY,
  SESSION_STORE,
  SYNC_STORE,
  TRADES_STORE,
  TRANSACTIONS_STORE,
  GOALS_STORE,
  RECOVERY_STORE,
  REENTRY_STORE
} from '../core/constants';
import type {
  ExitStrategyScenario,
  GoalPlan,
  LivePrice,
  ReentryPlan,
  RecoveryPlan,
  TradeRecord,
  TransactionRecord,
  UserSession,
  UserSettings
} from '../core/types';

type SessionRecord = {
  id: string;
  data: UserSession;
};

export type ActivityLogEntry = {
  id: string;
  type: string;
  detail: string;
  ts: string;
};

export type SyncState = {
  id: string;
  pendingPayload?: unknown;
  pendingDirty?: boolean;
  pendingSince?: string;
  pendingChangeCount?: number;
  lastSyncedAt?: string;
  lastPullAt?: string;
  lastCloudUpdatedAt?: string;
  lastPriceAt?: string;
  lastError?: string;
};

export interface FinanceDb extends DBSchema {
  session: {
    key: string;
    value: SessionRecord;
  };
  activity: {
    key: string;
    value: ActivityLogEntry;
  };
  trades: {
    key: string;
    value: TradeRecord;
  };
  transactions: {
    key: string;
    value: TransactionRecord;
  };
  goals: {
    key: string;
    value: GoalPlan;
  };
  recoveryPlans: {
    key: string;
    value: RecoveryPlan;
  };
  reentryPlans: {
    key: string;
    value: ReentryPlan;
  };
  exitStrategies: {
    key: string;
    value: ExitStrategyScenario;
  };
  sync: {
    key: string;
    value: SyncState;
  };
  prices: {
    key: string;
    value: LivePrice;
  };
  settings: {
    key: string;
    value: UserSettings;
  };
}

let dbPromise: Promise<IDBPDatabase<FinanceDb>> | null = null;

export async function openFinanceDb(): Promise<IDBPDatabase<FinanceDb>> {
  if (!dbPromise) {
    dbPromise = openDB<FinanceDb>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE);
      }
      if (!db.objectStoreNames.contains(ACTIVITY_STORE)) {
        db.createObjectStore(ACTIVITY_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(TRADES_STORE)) {
        db.createObjectStore(TRADES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(TRANSACTIONS_STORE)) {
        db.createObjectStore(TRANSACTIONS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(GOALS_STORE)) {
        db.createObjectStore(GOALS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(RECOVERY_STORE)) {
        db.createObjectStore(RECOVERY_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(REENTRY_STORE)) {
        db.createObjectStore(REENTRY_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(EXIT_STRATEGY_STORE)) {
        db.createObjectStore(EXIT_STRATEGY_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SYNC_STORE)) {
        db.createObjectStore(SYNC_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PRICES_STORE)) {
        db.createObjectStore(PRICES_STORE, { keyPath: 'ticker' });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'userId' });
      }
    }
  });
  }
  const db = await dbPromise;
  if (
    !db.objectStoreNames.contains(SESSION_STORE) ||
    !db.objectStoreNames.contains(ACTIVITY_STORE) ||
    !db.objectStoreNames.contains(TRADES_STORE) ||
    !db.objectStoreNames.contains(TRANSACTIONS_STORE) ||
    !db.objectStoreNames.contains(GOALS_STORE) ||
    !db.objectStoreNames.contains(RECOVERY_STORE) ||
    !db.objectStoreNames.contains(REENTRY_STORE) ||
    !db.objectStoreNames.contains(EXIT_STRATEGY_STORE) ||
    !db.objectStoreNames.contains(SYNC_STORE) ||
    !db.objectStoreNames.contains(PRICES_STORE) ||
    !db.objectStoreNames.contains(SETTINGS_STORE)
  ) {
    db.close();
    await deleteDB(DB_NAME);
    dbPromise = null;
    return openFinanceDb();
  }
  return db;
}

export async function getSession(): Promise<UserSession | null> {
  const db = await openFinanceDb();
  const record = await db.get(SESSION_STORE, SESSION_KEY);
  return record?.data ?? null;
}

export async function setSession(session: UserSession): Promise<void> {
  const db = await openFinanceDb();
  await db.put(SESSION_STORE, { id: SESSION_KEY, data: session }, SESSION_KEY);
}

export async function clearSession(): Promise<void> {
  const db = await openFinanceDb();
  await db.delete(SESSION_STORE, SESSION_KEY);
}
