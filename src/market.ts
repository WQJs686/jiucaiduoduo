import * as https from 'https';

export interface Quote {
  symbol: string;
  name: string;
  open: number;
  previousClose: number;
  current: number;
  bid: number;
  ask: number;
  auctionPrice?: number;
  high: number;
  low: number;
  volume: number;
  amount?: number;
  turnoverRate?: number;
  peTTM?: number;
  totalMarketCap?: number;
  date: string;
  time: string;
}

export interface StockSearchResult { name: string; code: string; symbol: string; }
export type MarketPhase = 'call-auction' | 'pre-open' | 'continuous' | 'closed';

export function normalizeSymbol(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(value)) return value;
  if (!/^\d{6}$/.test(value)) return undefined;
  // Shanghai convertible bonds use 110/111/113/118 prefixes. Check them
  // before the generic stock rule, where codes beginning with 1 map to SZ.
  if (/^(110|111|113|118)/.test(value)) return `sh${value}`;
  if (/^(6|5|9)/.test(value)) return `sh${value}`;
  if (/^(4|8)/.test(value)) return `bj${value}`;
  return `sz${value}`;
}

export function parseSinaResponse(body: string): Quote[] {
  const quotes: Quote[] = [];
  const pattern = /var\s+hq_str_((?:sh|sz|bj)\d{6})="([^"]*)"/g;
  for (const match of body.matchAll(pattern)) {
    const fields = match[2].split(',');
    if (!fields[0] || fields.length < 32) continue;
    const number = (index: number) => Number(fields[index]) || 0;
    quotes.push({
      symbol: match[1], name: fields[0], open: number(1), previousClose: number(2),
      current: number(3), high: number(4), low: number(5), bid: number(6), ask: number(7), volume: number(8), amount: number(9),
      date: fields[30], time: fields[31]
    });
  }
  return quotes;
}

export function marketPhase(now = new Date()): MarketPhase {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  if (['Sat', 'Sun'].includes(get('weekday'))) return 'closed';
  const seconds = Number(get('hour')) * 3600 + Number(get('minute')) * 60 + Number(get('second'));
  if (seconds >= 9 * 3600 + 15 * 60 && seconds < 9 * 3600 + 25 * 60) return 'call-auction';
  if (seconds >= 9 * 3600 + 25 * 60 && seconds < 9 * 3600 + 30 * 60) return 'pre-open';
  if ((seconds >= 9 * 3600 + 30 * 60 && seconds <= 11 * 3600 + 30 * 60)
    || (seconds >= 13 * 3600 && seconds <= 15 * 3600)) return 'continuous';
  return 'closed';
}

export function isTradingTime(now = new Date()): boolean {
  return marketPhase(now) === 'continuous';
}

export function displayPrice(quote: Quote, phase = marketPhase()): number {
  if ((phase === 'call-auction' || phase === 'pre-open') && quote.auctionPrice && quote.auctionPrice > 0) {
    return quote.auctionPrice;
  }
  return quote.current > 0 ? quote.current : quote.previousClose;
}

function eastMoneySymbol(symbol: string): string {
  return `${symbol.startsWith('sh') ? '1' : '0'}.${symbol.slice(2)}`;
}

interface EastMoneyMetrics {
  price?: number;
  amount?: number;
  turnoverRate?: number;
  peTTM?: number;
  totalMarketCap?: number;
}

const conceptCache = new Map<string, { expiresAt: number; values: string[] }>();
const CONCEPT_CACHE_MS = 6 * 60 * 60 * 1000;

export async function fetchStockConcepts(symbol: string): Promise<string[]> {
  const cached = conceptCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.values;

  const code = symbol.toUpperCase();
  const response = await fetch(`https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=${encodeURIComponent(code)}`, {
    headers: { Referer: 'https://emweb.securities.eastmoney.com/', 'User-Agent': 'VSCode-A-Share-Quotes/0.2' }
  });
  if (!response.ok) throw new Error(`东方财富概念接口返回 HTTP ${response.status}`);
  const payload = await response.json() as {
    ssbk?: Array<{ BOARD_NAME?: string; IS_PRECISE?: string | null; BOARD_RANK?: number }>;
  };
  const values = [...new Set((payload.ssbk ?? [])
    .filter(item => item.IS_PRECISE === '1' && item.BOARD_NAME)
    .sort((left, right) => (left.BOARD_RANK ?? Number.MAX_SAFE_INTEGER) - (right.BOARD_RANK ?? Number.MAX_SAFE_INTEGER))
    .map(item => item.BOARD_NAME!))];
  conceptCache.set(symbol, { expiresAt: Date.now() + CONCEPT_CACHE_MS, values });
  return values;
}

async function fetchEastMoneyMetrics(symbols: string[]): Promise<Map<string, EastMoneyMetrics>> {
  const metrics = new Map<string, EastMoneyMetrics>();
  for (let index = 0; index < symbols.length; index += 50) {
    const batch = symbols.slice(index, index + 50);
    const secids = batch.map(eastMoneySymbol).join(',');
    const response = await fetch(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f12,f13,f2,f6,f8,f20,f115`, {
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'VSCode-A-Share-Quotes/0.2' }
    });
    if (!response.ok) throw new Error(`东方财富行情接口返回 HTTP ${response.status}`);
    const payload = await response.json() as {
      data?: {
        diff?: Array<{
          f2?: number | string;
          f6?: number | string;
          f8?: number | string;
          f12?: string;
          f13?: number;
          f20?: number | string;
          f115?: number | string;
        }>;
      };
    };
    for (const row of payload.data?.diff ?? []) {
      const code = String(row.f12 ?? '');
      if (!/^\d{6}$/.test(code)) continue;
      const prefix = row.f13 === 1 ? 'sh' : /^(4|8)/.test(code) ? 'bj' : 'sz';
      const finite = (value: number | string | undefined): number | undefined => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
      };
      metrics.set(`${prefix}${code}`, {
        price: finite(row.f2),
        amount: finite(row.f6),
        turnoverRate: finite(row.f8),
        peTTM: finite(row.f115),
        totalMarketCap: finite(row.f20)
      });
    }
  }
  return metrics;
}

export async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  if (!symbols.length) return [];
  const phase = marketPhase();
  const metricsPromise = fetchEastMoneyMetrics(symbols).catch(() => new Map<string, EastMoneyMetrics>());
  const response = await fetch(`https://hq.sinajs.cn/list=${symbols.join(',')}`, {
    headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'VSCode-A-Share-Quotes/0.1' }
  });
  if (!response.ok) throw new Error(`新浪财经接口返回 HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const body = new TextDecoder('gb18030').decode(buffer);
  const quotes = parseSinaResponse(body);
  const metrics = await metricsPromise;
  return quotes.map(quote => {
    const detail = metrics.get(quote.symbol);
    return {
      ...quote,
      auctionPrice: phase === 'call-auction' || phase === 'pre-open' ? detail?.price : undefined,
      amount: detail?.amount ?? quote.amount,
      turnoverRate: detail?.turnoverRate,
      peTTM: detail?.peTTM,
      totalMarketCap: detail?.totalMarketCap
    };
  });
}

export async function searchStocks(keyword: string): Promise<StockSearchResult[]> {
  const key = keyword.trim();
  if (!key) return [];
  // Type 81 is the category used by Sina for Shanghai/Shenzhen convertible bonds.
  const url = `https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15,22,23,81&key=${encodeURIComponent(key)}`;
  const body = await new Promise<string>((resolve, reject) => {
    const request = https.get(url, {
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0', Connection: 'close' }, agent: false
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`新浪搜索接口返回 HTTP ${response.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(new TextDecoder('gb18030').decode(Buffer.concat(chunks))));
    });
    request.setTimeout(8_000, () => request.destroy(new Error('股票搜索请求超时')));
    request.on('error', reject);
  });
  const value = body.match(/var\s+suggestvalue="([^"]*)"/)?.[1] ?? '';
  const results = value.split(';').map(record => record.split(',')).filter(fields => fields.length >= 5 && normalizeSymbol(fields[3] || fields[2]));
  const unique = new Map<string, StockSearchResult>();
  for (const fields of results) {
    // Sina supplies the canonical exchange-prefixed symbol in field 3. Using
    // field 2 alone would misclassify Shanghai bonds such as 113615 as SZ.
    const symbol = normalizeSymbol(fields[3] || fields[2]);
    if (symbol) unique.set(symbol, { name: fields[4] || fields[6] || fields[0], code: fields[2], symbol });
  }
  const lowerKey = key.toLowerCase();
  const exactSymbol = normalizeSymbol(key);
  const relevance = (item: StockSearchResult): number => {
    if (item.symbol === exactSymbol || item.code.toLowerCase() === lowerKey) return 0;
    if (item.name.toLowerCase() === lowerKey) return 1;
    if (item.code.toLowerCase().startsWith(lowerKey) || item.name.toLowerCase().startsWith(lowerKey)) return 2;
    return 3;
  };
  return [...unique.values()]
    .map((item, index) => ({ item, index }))
    .sort((left, right) => relevance(left.item) - relevance(right.item) || left.index - right.index)
    .map(({ item }) => item)
    .slice(0, 20);
}
