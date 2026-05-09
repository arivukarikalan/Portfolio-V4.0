export type UserRole = 'ADMIN' | 'USER';

export type UserSession = {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  sessionToken?: string;
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
  executionAt?: string;
  importId?: string;
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

export type RecoveryLeg = {
  id: string;
  tradeId?: string;
  symbol: string;
  quantity: number;
  buyPrice: number;
  investedAmount: number;
  createdAt: string;
  updatedAt: string;
};

export type RecoveryLossLeg = {
  id: string;
  tradeId?: string;
  symbol: string;
  quantity: number;
  sellPrice: number;
  lossAmount: number;
  tradeDate: string;
  holdDays?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type RecoveryPlan = {
  id: string;
  userId: string;
  status: 'ACTIVE' | 'CLOSED';
  name?: string;
  lossTradeId?: string;
  lossSymbol: string;
  lossQuantity: number;
  lossSellPrice: number;
  lossAmount: number;
  lossTradeDate: string;
  lossHoldDays?: number | null;
  lossTrades?: RecoveryLossLeg[];
  recoveryTrades: RecoveryLeg[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
};

export type ReentryBuyLeg = {
  id: string;
  tradeId?: string;
  symbol: string;
  quantity: number;
  buyPrice: number;
  tradeDate: string;
  investedAmount: number;
  createdAt: string;
  updatedAt: string;
};

export type ReentryPlan = {
  id: string;
  userId: string;
  status: 'ACTIVE' | 'CLOSED';
  name?: string;
  symbol: string;
  sellTradeId?: string;
  sellQuantity: number;
  sellPrice: number;
  sellAmount: number;
  lossAmount: number;
  sellTradeDate: string;
  buybackTrades: ReentryBuyLeg[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
};

export type ExitStrategyMode = 'REENTRY' | 'SWAP' | 'INTRADAY';

export type ExitStrategySourceLeg = {
  id: string;
  tradeId?: string;
  symbol: string;
  quantity: number;
  sellPrice: number;
  avgCost: number;
  realizedLoss: number;
  tradeDate: string;
  createdAt: string;
  updatedAt: string;
};

export type ExitStrategyEntryLeg = {
  id: string;
  tradeId?: string;
  symbol: string;
  quantity: number;
  buyPrice: number;
  tradeDate: string;
  createdAt: string;
  updatedAt: string;
};

export type ExitStrategyScenario = {
  id: string;
  userId: string;
  mode: ExitStrategyMode;
  name?: string;
  status: 'ACTIVE' | 'CLOSED';
  sourceLegs: ExitStrategySourceLeg[];
  entryLegs: ExitStrategyEntryLeg[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
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

export type MappingOverride = {
  symbol: string;
  updatedAt: string;
};

export type MappingOverrideMap = Record<string, MappingOverride>;

export type SnapshotPayload = {
  version: number;
  updatedAt: string;
  trades: TradeRecord[];
  transactions: TransactionRecord[];
  goals?: GoalPlan[];
  settings: UserSettings | null;
  mappingOverrides?: MappingOverrideMap;
  recoveryPlans?: RecoveryPlan[];
  reentryPlans?: ReentryPlan[];
  exitStrategies?: ExitStrategyScenario[];
};
