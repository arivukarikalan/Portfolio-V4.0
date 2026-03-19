export type UserRole = 'ADMIN' | 'USER';

export type UserSession = {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  adminSessionToken?: string;
  createdAt: string;
};

export type TradeSide = 'BUY' | 'SELL';

export type TradeRecord = {
  id: string;
  userId: string;
  symbol: string;
  side: TradeSide;
  quantity: number;
  price: number;
  tradeDate: string;
  exitPrice?: number | null;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type TransactionType =
  | 'INCOME'
  | 'EXPENSE'
  | 'BORROWED'
  | 'LENT'
  | 'DEBT_REPAY'
  | 'DEBT_RECEIVE'
  | 'INVESTMENT'
  | 'LIQUID_ASSET'
  | 'OTHER_ASSET';

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';

export type TransactionRecord = {
  id: string;
  userId: string;
  type: TransactionType;
  amount: number;
  category: string;
  date: string;
  notes?: string;
  personName?: string | null;
  dueDate?: string | null;
  status?: 'OPEN' | 'CLOSED';
  paidAmount?: number | null;
  linkedId?: string | null;
  isRecurring?: boolean;
  recurrence?: {
    frequency: RecurrenceFrequency;
    intervalDays?: number;
  } | null;
  nextRun?: string | null;
  recurrenceEnd?: string | null;
  isTemplate?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GoalPlan = {
  id: string;
  userId: string;
  name: string;
  targetAmount: number;
  targetYear: number;
  targetDate?: string | null;
  status: 'ACTIVE' | 'COMPLETED';
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserSettings = {
  userId: string;
  maxAllocationPct: number;
  totalInvestment: number;
  buyBrokeragePct: number;
  sellBrokeragePct: number;
  dpCharge: number;
  expectedReturnPct: number;
  inflationPct: number;
  fdReturnPct: number;
  targetProfitPct: number;
  l1ZonePct: number;
  l2ZonePct: number;
  updatedAt: string;
};

export type LivePrice = {
  ticker: string;
  price: number;
  previousClose?: number | string;
  changePct?: number | string;
  fetchedAt: string;
};

export type SnapshotPayload = {
  version: number;
  updatedAt: string;
  trades: TradeRecord[];
  transactions: TransactionRecord[];
  goals?: GoalPlan[];
  settings: UserSettings | null;
};
