import * as https from 'https';

export interface Candle {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount?: number;
  changePercent?: number;
}
export interface MinutePoint { time: string; price: number; average: number; volume: number; }
export type CandlePeriod = 'day' | 'week' | 'month' | '5min';
type IntradayResult = { points: MinutePoint[]; previousClose?: number };

const candleCache = new Map<string, Candle[]>();
const intradayCache = new Map<string, IntradayResult>();

async function fetchText(url: string, referer = 'https://quote.eastmoney.com/'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const request = https.get(url, {
      headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0', Connection: 'close' }, agent: false
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`行情接口返回 HTTP ${response.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.setTimeout(6_000, () => request.destroy(new Error('行情请求超时')));
    request.on('error', reject);
  });
}

async function fetchJson<T>(url: string, referer?: string): Promise<T> { return JSON.parse(await fetchText(url, referer)) as T; }

export async function fetchCandles(symbol: string, period: CandlePeriod): Promise<Candle[]> {
  const key = `${symbol}:${period}`;
  const errors: string[] = [];
  for (const loader of [fetchEastMoneyCandles, fetchTencentCandles]) {
    try {
      const rows = await loader(symbol, period);
      if (!rows.length) throw new Error('未返回数据');
      // Keep enough history for MA250 while showing only the latest window by default.
      const candles = rows.slice(period === '5min' ? -300 : -360);
      candleCache.set(key, candles.map(item => ({ ...item })));
      return candles;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const cached = candleCache.get(key);
  if (cached?.length) return cached.map(item => ({ ...item }));
  throw new Error(`K 线数据请求失败：${errors.join('；')}`);
}

function eastMoneySecid(symbol: string): string {
  return `${symbol.startsWith('sh') ? 1 : 0}.${symbol.slice(2)}`;
}

async function fetchEastMoneyCandles(symbol: string, period: CandlePeriod): Promise<Candle[]> {
  const klt = { day: 101, week: 102, month: 103, '5min': 5 }[period];
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${eastMoneySecid(symbol)}&klt=${klt}&fqt=1&lmt=600&end=20500101&iscca=1&forcect=1&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57,f59&_=${Date.now()}`;
  const payload = await fetchJson<{ data?: { klines?: string[] } }>(url);
  return (payload.data?.klines ?? []).map(row => {
    const [date, open, close, high, low, volume, amount, changePercent] = row.split(',');
    return {
      date,
      open: Number(open),
      close: Number(close),
      high: Number(high),
      low: Number(low),
      volume: Number(volume),
      amount: Number(amount),
      changePercent: Number(changePercent)
    };
  }).filter(validCandle);
}

async function fetchTencentCandles(symbol: string, period: CandlePeriod): Promise<Candle[]> {
  const minute = period === '5min';
  const type = minute ? 'm5' : period;
  const url = minute
    ? `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},m5,,320`
    : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${type},,,600,qfq`;
  const payload = await fetchJson<{ data?: Record<string, Record<string, unknown>> }>(url, 'https://gu.qq.com/');
  const rows = payload.data?.[symbol]?.[minute ? 'm5' : `qfq${type}`];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): Candle[] => {
    if (!Array.isArray(row)) return [];
    const rawDate = String(row[0] ?? '');
    const date = minute && /^\d{12}$/.test(rawDate)
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)} ${rawDate.slice(8, 10)}:${rawDate.slice(10, 12)}`
      : rawDate;
    const candle: Candle = {
      date,
      open: Number(row[1]),
      close: Number(row[2]),
      high: Number(row[3]),
      low: Number(row[4]),
      volume: Number(row[5])
    };
    return validCandle(candle) ? [candle] : [];
  }).map((item, index, items) => ({
    ...item,
    changePercent: index > 0 && items[index - 1].close
      ? (item.close - items[index - 1].close) / items[index - 1].close * 100
      : undefined
  }));
}

function validCandle(item: Candle): boolean {
  return /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/.test(item.date)
    && [item.open, item.close, item.high, item.low, item.volume].every(Number.isFinite);
}

async function fetchEastMoneyIntraday(symbol: string, days: 1 | 5): Promise<IntradayResult> {
  const host = days === 1 ? 'push2.eastmoney.com' : 'push2his.eastmoney.com';
  const url = `https://${host}/api/qt/stock/trends2/get?secid=${eastMoneySecid(symbol)}&ndays=${days}&iscr=0&iscca=0&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f53,f56,f58&_=${Date.now()}`;
  const payload = await fetchJson<{ data?: { preClose?: number | string; trends?: string[] } }>(url);
  const rows = payload.data?.trends;
  if (!rows?.length) throw new Error('东方财富未返回分时数据');
  return {
    points: rows.map(row => {
      const [time, price, volume, average] = row.split(',');
      return { time, price: Number(price), average: Number(average), volume: Number(volume) };
    })
      .filter(item => [item.price, item.average, item.volume].every(Number.isFinite)),
    previousClose: Number(payload.data?.preClose) || undefined
  };
}

async function fetchTencentIntraday(symbol: string, days: 1 | 5): Promise<IntradayResult> {
  const endpoint = days === 1 ? 'minute' : 'day';
  const url = `https://web.ifzq.gtimg.cn/appstock/app/${endpoint}/query?code=${symbol}`;
  const payload = await fetchJson<{ data?: Record<string, { data?: unknown; qt?: Record<string, unknown> }> }>(url, 'https://gu.qq.com/');
  const node = payload.data?.[symbol];
  const rawSessions = (Array.isArray(node?.data) ? [...node.data] : node?.data && typeof node.data === 'object' ? [node.data] : [])
    .sort((left, right) => String((left as { date?: unknown })?.date ?? '').localeCompare(String((right as { date?: unknown })?.date ?? '')));
  const points: MinutePoint[] = [];
  for (const rawSession of rawSessions) {
    if (!rawSession || typeof rawSession !== 'object') continue;
    const session = rawSession as { date?: unknown; data?: unknown };
    const rawDate = String(session.date ?? '');
    const date = /^\d{8}$/.test(rawDate)
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
      : rawDate;
    if (!Array.isArray(session.data)) continue;
    let previousVolume = 0;
    let weightedPrice = 0;
    let weightedVolume = 0;
    for (const rawRow of session.data) {
      const [rawTime, rawPrice, rawVolume, rawAmount] = String(rawRow).trim().split(/\s+/);
      const price = Number(rawPrice);
      const cumulativeVolume = Number(rawVolume);
      const cumulativeAmount = Number(rawAmount);
      if (!/^\d{4}$/.test(rawTime) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(cumulativeVolume)) continue;
      const minutes = Number(rawTime.slice(0, 2)) * 60 + Number(rawTime.slice(2));
      if (!((minutes >= 570 && minutes <= 690) || (minutes >= 781 && minutes <= 900))) continue;
      const volume = Math.max(0, cumulativeVolume - previousVolume);
      previousVolume = cumulativeVolume;
      weightedPrice += price * volume;
      weightedVolume += volume;
      const reportedAverage = cumulativeVolume > 0 && Number.isFinite(cumulativeAmount)
        ? cumulativeAmount / cumulativeVolume / 100
        : NaN;
      const average = Number.isFinite(reportedAverage) && reportedAverage > price * 0.2 && reportedAverage < price * 5
        ? reportedAverage
        : weightedVolume > 0 ? weightedPrice / weightedVolume : price;
      const time = `${rawTime.slice(0, 2)}:${rawTime.slice(2)}`;
      points.push({ time: date ? `${date} ${time}` : time, price, average, volume });
    }
  }
  if (!points.length) throw new Error('腾讯未返回分时数据');
  const quoteRows = node?.qt?.[symbol];
  const previousClose = Array.isArray(quoteRows) ? Number(quoteRows[4]) || undefined : undefined;
  return { points, previousClose };
}

export async function fetchIntraday(symbol: string, days: 1 | 5 = 1): Promise<IntradayResult> {
  const key = `${symbol}:${days}`;
  const errors: string[] = [];
  for (const loader of [fetchEastMoneyIntraday, fetchTencentIntraday]) {
    try {
      const result = await loader(symbol, days);
      if (!result.points.length) throw new Error('未返回数据');
      intradayCache.set(key, { points: result.points.map(item => ({ ...item })), previousClose: result.previousClose });
      return result;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const cached = intradayCache.get(key);
  if (cached?.points.length) return { points: cached.points.map(item => ({ ...item })), previousClose: cached.previousClose };
  throw new Error(`分时数据请求失败：${errors.join('；')}`);
}
