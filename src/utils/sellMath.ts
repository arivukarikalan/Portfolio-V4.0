import type { UserSettings } from '../core/types';

export type SellMathInput = {
  qty: number;
  invested: number;
  sellPrice: number;
  settings: Pick<UserSettings, 'buyBrokeragePct' | 'sellBrokeragePct' | 'dpCharge' | 'targetProfitPct'>;
};

export type SellOutcome = {
  qty: number;
  invested: number;
  avgBuy: number | null;
  sellPrice: number;
  grossSellValue: number;
  buyCharges: number;
  effectiveInvested: number;
  sellCharges: number;
  dpCharge: number;
  totalCharges: number;
  netProceeds: number;
  estimatedProfit: number;
  returnPct: number | null;
  breakEvenSellPrice: number | null;
  targetSellPrice: number | null;
};

export function calculateSellOutcome(input: SellMathInput): SellOutcome | null {
  const qty = Number(input.qty || 0);
  const invested = Number(input.invested || 0);
  const sellPrice = Number(input.sellPrice || 0);
  if (!(qty > 0) || !(invested >= 0) || !(sellPrice > 0)) return null;

  const buyRate = Math.max(0, Number(input.settings.buyBrokeragePct || 0)) / 100;
  const sellRate = Math.max(0, Number(input.settings.sellBrokeragePct || 0)) / 100;
  const dpCharge = Math.max(0, Number(input.settings.dpCharge || 0));
  const targetProfitPct = Math.max(0, Number(input.settings.targetProfitPct || 0)) / 100;

  const avgBuy = qty > 0 ? invested / qty : null;
  const buyCharges = invested * buyRate;
  const effectiveInvested = invested + buyCharges;
  const grossSellValue = qty * sellPrice;
  const sellCharges = grossSellValue * sellRate;
  const netProceeds = grossSellValue - sellCharges - dpCharge;
  const estimatedProfit = netProceeds - effectiveInvested;
  const totalCharges = buyCharges + sellCharges + dpCharge;
  const netFactor = 1 - sellRate;
  const breakEvenSellPrice =
    qty > 0 && netFactor > 0 ? (effectiveInvested + dpCharge) / (qty * netFactor) : null;
  const targetSellPrice =
    qty > 0 && netFactor > 0
      ? (effectiveInvested * (1 + targetProfitPct) + dpCharge) / (qty * netFactor)
      : null;

  return {
    qty,
    invested,
    avgBuy,
    sellPrice,
    grossSellValue,
    buyCharges,
    effectiveInvested,
    sellCharges,
    dpCharge,
    totalCharges,
    netProceeds,
    estimatedProfit,
    returnPct: effectiveInvested > 0 ? (estimatedProfit / effectiveInvested) * 100 : null,
    breakEvenSellPrice,
    targetSellPrice
  };
}
