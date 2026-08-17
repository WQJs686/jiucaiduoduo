import { Candle } from './history';

export type IndicatorValue = number | null;

export interface TechnicalIndicators {
  macd: { dif: number[]; dea: number[]; histogram: number[] };
  kdj: { k: number[]; d: number[]; j: number[] };
  rsi: { rsi6: IndicatorValue[]; rsi12: IndicatorValue[]; rsi24: IndicatorValue[] };
  mom: { mom: IndicatorValue[]; average: IndicatorValue[] };
}

export function calculateTechnicalIndicators(candles: Candle[]): TechnicalIndicators {
  const closes = candles.map(item => item.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_, index) => ema12[index] - ema26[index]);
  const dea = ema(dif, 9);
  const histogram = dif.map((value, index) => 2 * (value - dea[index]));

  const kdj = calculateKdj(candles);
  const mom = closes.map((value, index) => index < 10 ? null : value - closes[index - 10]);

  return {
    macd: { dif, dea, histogram },
    kdj,
    rsi: {
      rsi6: calculateRsi(closes, 6),
      rsi12: calculateRsi(closes, 12),
      rsi24: calculateRsi(closes, 24)
    },
    mom: { mom, average: nullableMovingAverage(mom, 6) }
  };
}

function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index] * alpha + result[index - 1] * (1 - alpha));
  }
  return result;
}

function calculateKdj(candles: Candle[]): TechnicalIndicators['kdj'] {
  const k: number[] = [];
  const d: number[] = [];
  const j: number[] = [];
  let previousK = 50;
  let previousD = 50;
  candles.forEach((item, index) => {
    const window = candles.slice(Math.max(0, index - 8), index + 1);
    const low = Math.min(...window.map(value => value.low));
    const high = Math.max(...window.map(value => value.high));
    const rsv = high === low ? 50 : (item.close - low) / (high - low) * 100;
    const nextK = previousK * 2 / 3 + rsv / 3;
    const nextD = previousD * 2 / 3 + nextK / 3;
    k.push(nextK);
    d.push(nextD);
    j.push(3 * nextK - 2 * nextD);
    previousK = nextK;
    previousD = nextD;
  });
  return { k, d, j };
}

function calculateRsi(values: number[], period: number): IndicatorValue[] {
  const result: IndicatorValue[] = Array(values.length).fill(null);
  if (values.length <= period) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(0, change);
    averageLoss += Math.max(0, -change);
  }
  averageGain /= period;
  averageLoss /= period;
  result[period] = rsiValue(averageGain, averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
    result[index] = rsiValue(averageGain, averageLoss);
  }
  return result;
}

function rsiValue(averageGain: number, averageLoss: number): number {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function nullableMovingAverage(values: IndicatorValue[], period: number): IndicatorValue[] {
  return values.map((_, index) => {
    const window = values.slice(index - period + 1, index + 1);
    if (window.length < period || window.some(value => value === null)) return null;
    return window.reduce<number>((sum, value) => sum + (value ?? 0), 0) / period;
  });
}
