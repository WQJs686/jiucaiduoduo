import * as vscode from 'vscode';
import { Candle, CandlePeriod, fetchCandles, fetchIntraday, MinutePoint } from './history';
import { calculateTechnicalIndicators, TechnicalIndicators } from './indicators';
import { fetchOrderBook, fetchQuotes, fetchStockConcepts, marketPhase, MarketPhase, OrderBook, OrderBookLevel, Quote } from './market';

type Period = 'minute' | 'fiveDay' | CandlePeriod;
type ChartData = { candles?: Candle[]; points?: MinutePoint[]; previousClose?: number; indicators?: TechnicalIndicators };

const REFRESH_INTERVAL_MS = 10_000;
const ORDER_BOOK_REFRESH_INTERVAL_MS = 3_000;
const ORDER_BOOK_MAX_RETRY_MS = 60_000;

export class StockDetailPanel {
  private static current: StockDetailPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly timer: NodeJS.Timeout;
  private readonly orderBookTimer: NodeJS.Timeout;
  private period: Period = 'minute';
  private requestId = 0;
  private concepts?: string[];
  private conceptsSymbol?: string;
  private conceptsPromise?: Promise<void>;
  private orderBook?: OrderBook;
  private orderBookSymbol?: string;
  private orderBookPromise?: Promise<void>;
  private orderBookFailures = 0;
  private orderBookRetryAfter = 0;

  static show(extensionUri: vscode.Uri, quote: Quote): void {
    void extensionUri;
    const existing = this.current;
    if (existing) {
      const changedStock = existing.quote.symbol !== quote.symbol;
      existing.quote = quote;
      if (changedStock) {
        existing.concepts = undefined;
        existing.conceptsSymbol = undefined;
        existing.conceptsPromise = undefined;
        existing.orderBook = undefined;
        existing.orderBookSymbol = undefined;
        existing.orderBookPromise = undefined;
        existing.orderBookFailures = 0;
        existing.orderBookRetryAfter = 0;
      }
      existing.panel.title = `${quote.name} · 行情`;
      existing.panel.reveal(vscode.ViewColumn.One);
      void existing.load(existing.period, changedStock);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'aShareQuotes.detail',
      `${quote.name} · 行情`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const detail = new StockDetailPanel(panel, quote);
    this.current = detail;
    panel.onDidDispose(() => {
      clearInterval(detail.timer);
      clearInterval(detail.orderBookTimer);
      if (this.current === detail) this.current = undefined;
    });
    void detail.load('minute');
  }

  private constructor(panel: vscode.WebviewPanel, private quote: Quote) {
    this.panel = panel;
    panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'period' && ['minute', 'fiveDay', 'day', 'week', 'month', '5min'].includes(message.value)) {
        void this.load(message.value as Period);
      }
    });
    this.timer = setInterval(() => {
      if (this.panel.visible) void this.load(this.period, false);
    }, REFRESH_INTERVAL_MS);
    this.orderBookTimer = setInterval(() => {
      if (this.panel.visible && marketPhase() !== 'closed') void this.loadOrderBook(true);
    }, ORDER_BOOK_REFRESH_INTERVAL_MS);
  }

  private async load(period: Period, showLoading = true): Promise<void> {
    this.period = period;
    const requestId = ++this.requestId;
    const symbol = this.quote.symbol;
    const quoteSnapshot = this.quote;
    if (showLoading) this.panel.webview.html = this.html(period, {}, '行情加载中…');
    const quotePromise = fetchQuotes([symbol])
      .then(quotes => {
        if (quotes[0] && requestId === this.requestId && this.quote.symbol === symbol) this.quote = quotes[0];
      })
      .catch(() => undefined);
    const conceptsPromise = this.loadConcepts();
    const orderBookPromise = this.loadOrderBook();
    try {
      let chartData: ChartData;
      if (period === 'minute' || period === 'fiveDay') {
        const result = await fetchIntraday(symbol, period === 'fiveDay' ? 5 : 1);
        chartData = { points: result.points, previousClose: result.previousClose ?? quoteSnapshot.previousClose };
      } else {
        const candles = await fetchCandles(symbol, period);
        if (period === 'day') this.mergeCurrentDay(candles, quoteSnapshot);
        chartData = { candles, indicators: calculateTechnicalIndicators(candles) };
      }
      await quotePromise;
      await conceptsPromise;
      await orderBookPromise;
      if (requestId !== this.requestId) return;
      this.panel.title = `${this.quote.name} · 行情`;
      this.panel.webview.html = this.html(period, chartData);
    } catch (error) {
      await quotePromise;
      await conceptsPromise;
      await orderBookPromise;
      if (requestId !== this.requestId) return;
      this.panel.webview.html = this.html(period, {}, error instanceof Error ? error.message : String(error));
    }
  }

  private loadConcepts(): Promise<void> {
    const symbol = this.quote.symbol;
    if (this.conceptsSymbol === symbol && this.concepts !== undefined) return Promise.resolve();
    if (this.conceptsSymbol !== symbol) {
      this.concepts = undefined;
      this.conceptsSymbol = symbol;
      this.conceptsPromise = undefined;
    }
    if (!this.conceptsPromise) {
      const request = fetchStockConcepts(symbol)
        .then(values => { if (this.conceptsSymbol === symbol) this.concepts = values; })
        .catch(() => { if (this.conceptsSymbol === symbol) this.concepts = []; })
        .finally(() => { if (this.conceptsPromise === request) this.conceptsPromise = undefined; });
      this.conceptsPromise = request;
    }
    return this.conceptsPromise;
  }

  private loadOrderBook(forceRefresh = false): Promise<void> {
    const symbol = this.quote.symbol;
    if (!forceRefresh && this.orderBookSymbol === symbol && this.orderBook !== undefined) return Promise.resolve();
    if (this.orderBookSymbol !== symbol) {
      this.orderBook = undefined;
      this.orderBookSymbol = symbol;
      this.orderBookPromise = undefined;
      this.orderBookFailures = 0;
      this.orderBookRetryAfter = 0;
    }
    if (forceRefresh && Date.now() < this.orderBookRetryAfter) return Promise.resolve();
    if (!this.orderBookPromise) {
      const request = fetchOrderBook(symbol)
        .then(value => {
          if (this.orderBookSymbol !== symbol) return;
          this.orderBook = value;
          this.orderBookFailures = 0;
          this.orderBookRetryAfter = 0;
          this.updateOrderBookView();
        })
        .catch(() => {
          if (this.orderBookSymbol !== symbol) return;
          if (this.orderBook === undefined) this.orderBook = { bids: [], asks: [], currentPrice: 0, time: '' };
          this.orderBookFailures += 1;
          const retryDelay = Math.min(
            ORDER_BOOK_MAX_RETRY_MS,
            ORDER_BOOK_REFRESH_INTERVAL_MS * 2 ** Math.min(this.orderBookFailures, 5)
          );
          this.orderBookRetryAfter = Date.now() + retryDelay;
          this.updateOrderBookView();
        })
        .finally(() => { if (this.orderBookPromise === request) this.orderBookPromise = undefined; });
      this.orderBookPromise = request;
    }
    return this.orderBookPromise;
  }

  private updateOrderBookView(): void {
    if (!this.panel.visible) return;
    void this.panel.webview.postMessage({
      type: 'orderBook',
      html: renderOrderBook(this.orderBook, this.quote.previousClose, this.quote.current)
    });
  }

  private mergeCurrentDay(candles: Candle[], quote = this.quote): void {
    if (!quote.date || !quote.open || !quote.current) return;
    const current: Candle = {
      date: quote.date,
      open: quote.open,
      close: quote.current,
      high: quote.high,
      low: quote.low,
      // 新浪实时行情返回“股”，东方财富 K 线返回“手”。
      volume: quote.volume / 100
    };
    const index = candles.findIndex(item => item.date === current.date);
    if (index >= 0) candles[index] = current;
    else candles.push(current);
  }

  private html(period: Period, chartData: ChartData, message = ''): string {
    // CSP nonce must use a base64-compatible token. A decimal point from
    // Math.random() would make Chromium reject the inline chart script.
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const phase = marketPhase();
    const phaseText = marketPhaseText(phase);
    const timeText = `${this.quote.date.slice(5)} ${this.quote.time} 北京时间`;
    const conceptText = this.concepts === undefined ? '题材加载中…' : this.concepts.length ? this.concepts.join(' · ') : '暂无题材';
    const orderBookHtml = renderOrderBook(this.orderBook, this.quote.previousClose, this.quote.current);
    const data = JSON.stringify(chartData).replace(/</g, '\\u003c');
    const nameData = JSON.stringify(this.quote.name).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
:root{--rise:#f04438;--fall:#079447;--gold:#f2b800;--purple:#8b5cf6;--blue:#4f70d9;--lime:#81c968;--coral:#ef6666;--cyan:#58bce6;--emerald:#33a36c;--panel:color-mix(in srgb,var(--vscode-editor-background) 88%,white);--edge:color-mix(in srgb,var(--vscode-foreground) 13%,transparent);--muted:var(--vscode-descriptionForeground)}
*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:Inter,var(--vscode-font-family);font-variant-numeric:tabular-nums}.shell{max-width:1500px;margin:auto;padding:16px 20px 22px}
.overview{margin-bottom:12px;padding:11px 15px 13px;background:var(--panel);border:1px solid var(--edge);border-radius:9px;box-shadow:0 7px 20px #0001}.market-status{display:flex;align-items:center;gap:7px;min-width:0;margin-bottom:11px;font-size:13px}.phase{font-weight:700;flex:none}.overview-time{color:var(--muted);flex:none}.concepts{display:flex;align-items:center;gap:6px;min-width:0;margin-left:14px;font-size:12px}.concept-label{flex:none;color:var(--muted)}.concept-names{overflow:hidden;color:var(--vscode-foreground);text-overflow:ellipsis;white-space:nowrap}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 54px}.metric-group{display:grid;grid-template-columns:minmax(70px,auto) 1fr;gap:7px 14px;align-items:baseline}.metric-label{color:var(--muted);font-size:12px}.metric-value{font-size:13px;font-weight:650}.rise{color:var(--rise)}.fall{color:var(--fall)}
.market-body{display:grid;grid-template-columns:minmax(0,1fr) 190px;gap:12px;align-items:start}.terminal{min-width:0;background:var(--panel);border:1px solid var(--edge);border-radius:11px;overflow:hidden;box-shadow:0 9px 26px #0001}.bar{min-height:39px;display:flex;align-items:center;flex-wrap:wrap;padding:7px 14px;border-bottom:1px solid var(--edge);gap:5px}.tab{height:26px;padding:0 14px;border:0;border-radius:5px;background:transparent;color:var(--muted);cursor:pointer;font-size:12px;font-weight:600}.tab:hover{background:var(--edge);color:var(--vscode-foreground)}.tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.legend{margin-left:auto;display:flex;flex-wrap:wrap;gap:10px;font-size:11px}.dot:before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px}.ma5:before{background:var(--blue)}.ma10:before{background:var(--lime)}.ma20:before{background:var(--gold)}.ma30:before{background:var(--coral)}.ma50:before{background:var(--cyan)}.ma250:before{background:var(--emerald)}.avg:before{background:var(--gold)}
.order-book{background:var(--panel);border:1px solid var(--edge);border-radius:11px;overflow:hidden;box-shadow:0 9px 26px #0001}.order-title{height:39px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid var(--edge);font-size:12px;font-weight:700}.order-snapshot{color:var(--muted);font-size:10px;font-weight:400}.order-head,.order-row{display:grid;grid-template-columns:34px minmax(0,1fr) minmax(0,1fr);align-items:center;padding:0 10px;column-gap:7px}.order-head{height:27px;color:var(--muted);font-size:10px}.order-row{height:33px;border-top:1px solid color-mix(in srgb,var(--edge) 55%,transparent);font-size:11px}.order-row span:nth-child(2),.order-row span:nth-child(3){text-align:right}.order-label.buy{color:var(--rise)}.order-label.sell{color:var(--fall)}.order-divider{height:34px;display:flex;align-items:center;justify-content:center;border-top:1px solid var(--edge);border-bottom:1px solid var(--edge);font-size:13px;font-weight:700}.order-empty{height:374px;display:grid;place-items:center;padding:12px;color:var(--muted);font-size:11px;text-align:center}
.chart{position:relative;height:420px;padding:8px}.chart svg{width:100%;height:100%;display:block}.empty{height:100%;display:grid;place-items:center;color:var(--muted)}.tip{position:absolute;display:none;pointer-events:none;background:color-mix(in srgb,var(--vscode-editor-background) 94%,transparent);border:1px solid var(--edge);border-radius:6px;padding:7px 9px;box-shadow:0 6px 17px #0004;font-size:11px;line-height:1.6;z-index:3}
.indicator-wrap{display:${period !== 'minute' && period !== 'fiveDay' && !message ? 'block' : 'none'};border-top:1px solid var(--edge)}.indicator-bar{min-height:34px;display:flex;align-items:center;gap:4px;padding:4px 14px;border-bottom:1px solid color-mix(in srgb,var(--edge) 65%,transparent)}.indicator-tab{height:23px;padding:0 10px;border:0;border-radius:4px;background:transparent;color:var(--muted);cursor:pointer;font-size:11px;font-weight:650}.indicator-tab:hover{background:var(--edge);color:var(--vscode-foreground)}.indicator-tab.active{background:color-mix(in srgb,var(--vscode-button-background) 22%,transparent);color:var(--vscode-button-background)}.indicator-legend{min-width:0;margin-left:8px;display:flex;align-items:center;gap:10px;color:var(--muted);font-size:10px;white-space:nowrap}.indicator-legend .value{font-weight:650}.indicator-signal{margin-left:auto;padding:2px 7px;border:1px solid var(--edge);border-radius:10px;color:var(--muted);font-size:10px;white-space:nowrap}.indicator-signal.rise{border-color:color-mix(in srgb,var(--rise) 35%,transparent);background:color-mix(in srgb,var(--rise) 8%,transparent)}.indicator-signal.fall{border-color:color-mix(in srgb,var(--fall) 35%,transparent);background:color-mix(in srgb,var(--fall) 8%,transparent)}.indicator-chart{height:145px;padding:2px 8px 5px}.indicator-chart svg{width:100%;height:100%;display:block}
.range-wrap{display:${period === 'minute' || period === 'fiveDay' ? 'none' : 'block'};padding:0 21px 14px}.range-title{font-size:10px;color:var(--muted);margin-bottom:6px}.range{height:36px;position:relative;border-radius:5px;background:color-mix(in srgb,var(--blue) 8%,var(--vscode-editor-background));overflow:hidden;touch-action:none;cursor:crosshair}.spark{position:absolute;inset:4px;opacity:.55}.shade{position:absolute;top:0;bottom:0;background:#0005;pointer-events:none}.selection{position:absolute;top:0;bottom:0;border:1px solid var(--blue);background:#4aa8ff16;cursor:grab}.selection:active{cursor:grabbing}.handle{position:absolute;top:0;bottom:0;width:7px;background:var(--blue);cursor:ew-resize}.handle.left{left:-3px}.handle.right{right:-3px}.dates{display:flex;justify-content:space-between;color:var(--muted);font-size:9px;margin-top:4px}
@media(max-width:700px){.market-body{grid-template-columns:1fr}.order-book{width:190px;justify-self:end}}@media(max-width:800px){.shell{padding:9px}.metrics{grid-template-columns:1fr;gap:9px}.chart{height:338px}.legend{width:100%;margin-left:4px}.tab{padding:0 9px}.indicator-bar{align-items:flex-start;flex-wrap:wrap}.indicator-legend{order:3;width:100%;margin-left:2px;overflow:hidden}.indicator-signal{margin-left:auto}}
</style></head><body><main class="shell">
<section class="overview"><div class="market-status"><span class="phase">${phaseText}</span><span class="overview-time">${esc(timeText)}</span><span class="concepts"><span class="concept-label">所属概念</span><span class="concept-names" title="${esc(conceptText)}">${esc(conceptText)}</span></span></div><div class="metrics">
<div class="metric-group"><span class="metric-label">今开</span><strong class="metric-value ${priceTone(this.quote.open, this.quote.previousClose)}">${priceValue(this.quote.open)}</strong><span class="metric-label">昨收</span><strong class="metric-value">${priceValue(this.quote.previousClose)}</strong><span class="metric-label">换手率</span><strong class="metric-value">${percentValue(this.quote.turnoverRate)}</strong></div>
<div class="metric-group"><span class="metric-label">最高</span><strong class="metric-value ${priceTone(this.quote.high, this.quote.previousClose)}">${priceValue(this.quote.high)}</strong><span class="metric-label">最低</span><strong class="metric-value ${priceTone(this.quote.low, this.quote.previousClose)}">${priceValue(this.quote.low)}</strong><span class="metric-label">市盈(TTM)</span><strong class="metric-value">${numberValue(this.quote.peTTM)}</strong></div>
<div class="metric-group"><span class="metric-label">成交量</span><strong class="metric-value">${handsValue(this.quote.volume)}</strong><span class="metric-label">成交额</span><strong class="metric-value">${moneyValue(this.quote.amount)}</strong><span class="metric-label">总市值</span><strong class="metric-value">${marketCapValue(this.quote.totalMarketCap)}</strong></div>
</div></section>
<div class="market-body"><section class="terminal"><div class="bar"><button class="tab ${period === 'minute' ? 'active' : ''}" data-period="minute">分时</button><button class="tab ${period === 'fiveDay' ? 'active' : ''}" data-period="fiveDay">五日</button><button class="tab ${period === 'day' ? 'active' : ''}" data-period="day">日 K</button><button class="tab ${period === 'week' ? 'active' : ''}" data-period="week">周 K</button><button class="tab ${period === 'month' ? 'active' : ''}" data-period="month">月 K</button><button class="tab ${period === '5min' ? 'active' : ''}" data-period="5min">5 分</button><div class="legend">${period === 'minute' || period === 'fiveDay' ? '<span class="dot avg">均价</span>' : '<span class="dot ma5">MA5</span><span class="dot ma10">MA10</span><span class="dot ma20">MA20</span><span class="dot ma30">MA30</span><span class="dot ma50">MA50</span><span class="dot ma250">MA250</span>'}</div></div>
<div id="chart" class="chart">${message ? `<div class="empty">${esc(message)}</div>` : ''}<div id="tip" class="tip"></div></div>
<div id="indicatorWrap" class="indicator-wrap"><div class="indicator-bar"><button class="indicator-tab" data-indicator="kdj">KDJ</button><button class="indicator-tab" data-indicator="macd">MACD</button><button class="indicator-tab" data-indicator="rsi">RSI</button><button class="indicator-tab" data-indicator="mom">动量</button><div id="indicatorLegend" class="indicator-legend"></div><span id="indicatorSignal" class="indicator-signal">等待数据</span></div><div id="indicatorChart" class="indicator-chart"></div></div>
<div class="range-wrap"><div class="range-title">拖动蓝色选区移动日期范围，拖动两侧手柄缩放</div><div id="range" class="range"><svg id="spark" class="spark"></svg><div id="shadeL" class="shade"></div><div id="shadeR" class="shade"></div><div id="selection" class="selection"><i class="handle left" data-handle="left"></i><i class="handle right" data-handle="right"></i></div></div><div class="dates"><span id="dateL">--</span><span id="dateR">--</span></div></div></section><aside id="orderBook" class="order-book">${orderBookHtml}</aside></div>
</main><script nonce="${nonce}">
const vscode=acquireVsCodeApi(),payload=${data},stockName=${nameData},mode='${period}',all=payload.candles||[],maDefs=[{n:5,c:'var(--blue)'},{n:10,c:'var(--lime)'},{n:20,c:'var(--gold)'},{n:30,c:'var(--coral)'},{n:50,c:'var(--cyan)'},{n:250,c:'var(--emerald)'}],indicatorModes=['kdj','macd','rsi','mom'],savedState=vscode.getState()||{};let start=Math.max(0,all.length-60),end=all.length-1,indicatorMode=indicatorModes.includes(savedState.indicator)?savedState.indicator:'kdj',indicatorRender=null;
document.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>vscode.postMessage({type:'period',value:b.dataset.period}));
document.querySelectorAll('[data-indicator]').forEach(b=>{b.classList.toggle('active',b.dataset.indicator===indicatorMode);b.onclick=()=>{indicatorMode=b.dataset.indicator;vscode.setState({...savedState,indicator:indicatorMode});document.querySelectorAll('[data-indicator]').forEach(item=>item.classList.toggle('active',item.dataset.indicator===indicatorMode));drawIndicator()}});
window.addEventListener('message',event=>{if(event.data?.type==='orderBook'){const target=document.getElementById('orderBook');if(target)target.innerHTML=event.data.html}});
const chart=document.getElementById('chart'),tip=document.getElementById('tip'),minuteMode=mode==='minute'||mode==='fiveDay';if(minuteMode&&payload.points?.length)drawMinute(payload.points,payload.previousClose,mode==='fiveDay');else if(all.length){setupRange();drawK()}
function base(vals){const W=1200,H=530,p={l:78,r:78,t:28,b:70},vol=94,sep=24,pb=H-p.b-vol-sep,lo=Math.min(...vals),hi=Math.max(...vals),rg=hi-lo||Math.max(Math.abs(hi)*.01,.01);return{W,H,p,vol,pb,lo,hi,rg,y:v=>p.t+(hi-v)/rg*(pb-p.t)}}
function grid(b){let s='';for(let i=0;i<5;i++){let yy=b.p.t+i*(b.pb-b.p.t)/4,v=b.hi-i*b.rg/4;s+='<line x1="'+b.p.l+'" x2="'+(b.W-b.p.r)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--edge)"/><text x="'+(b.p.l-9)+'" y="'+(yy+4)+'" text-anchor="end" fill="var(--muted)" font-size="11">'+v.toFixed(2)+'</text>'}return s}
function minuteBase(d,pre){const vals=d.flatMap(a=>[a.price,a.average]).filter(v=>Number.isFinite(v)&&v>0),span=Math.max(...vals.map(v=>Math.abs(v-pre)),Math.abs(pre)*.006,.01)*1.08,b=base([pre-span,pre+span]);return b}
function minuteGrid(b,pre){let s='';for(let i=0;i<5;i++){const yy=b.p.t+i*(b.pb-b.p.t)/4,v=b.hi-i*b.rg/4,pct=(v-pre)/pre*100,color=v>pre?'var(--rise)':v<pre?'var(--fall)':'var(--muted)',dash=i===2?' stroke-dasharray="6 5"':'';s+='<line x1="'+b.p.l+'" x2="'+(b.W-b.p.r)+'" y1="'+yy+'" y2="'+yy+'" stroke="'+(i===2?'var(--muted)':'var(--edge)')+'"'+dash+'/><text x="'+(b.p.l-9)+'" y="'+(yy+4)+'" text-anchor="end" fill="'+color+'" font-size="11">'+v.toFixed(2)+'</text><text x="'+(b.W-b.p.r+10)+'" y="'+(yy+4)+'" fill="'+color+'" font-size="11">'+(pct>0?'+':'')+pct.toFixed(2)+'%</text>'}s+='<text x="'+(b.W-b.p.r-8)+'" y="'+(b.y(pre)-8)+'" text-anchor="end" fill="var(--muted)" font-size="11" font-weight="700">昨收 '+pre.toFixed(2)+'</text>';return s}
function movingAverage(n){return all.map((_,i)=>i<n-1?null:all.slice(i-n+1,i+1).reduce((sum,item)=>sum+item.close,0)/n)}
function seriesPath(values,x,y){let begun=false;return values.map((value,i)=>{if(value==null||!Number.isFinite(value)){begun=false;return''}const command=begun?'L':'M';begun=true;return command+x(i).toFixed(1)+' '+y(value).toFixed(1)}).join(' ')}
function drawK(){
  const maSeries=maDefs.map(def=>({n:def.n,c:def.c,values:movingAverage(def.n).slice(start,end+1)}));
  const d=all.slice(start,end+1),scaleValues=d.flatMap(item=>[item.low,item.high]).concat(maSeries.flatMap(series=>series.values.filter(value=>value!=null))),b=base(scaleValues),plotW=b.W-b.p.l-b.p.r,x=i=>b.p.l+(i+.5)*plotW/d.length,maxV=Math.max(...d.map(item=>item.volume),1),vy=value=>b.H-b.p.b-value/maxV*b.vol,bw=Math.max(2,plotW/d.length*.62);
  let s='<svg viewBox="0 0 '+b.W+' '+b.H+'" preserveAspectRatio="none">'+grid(b);
  d.forEach((item,i)=>{const color=item.close>=item.open?'var(--rise)':'var(--fall)',xx=x(i);s+='<g><line x1="'+xx+'" x2="'+xx+'" y1="'+b.y(item.high)+'" y2="'+b.y(item.low)+'" stroke="'+color+'"/><rect x="'+(xx-bw/2)+'" y="'+Math.min(b.y(item.open),b.y(item.close))+'" width="'+bw+'" height="'+Math.max(1,Math.abs(b.y(item.open)-b.y(item.close)))+'" fill="'+color+'"/><rect x="'+(xx-bw/2)+'" y="'+vy(item.volume)+'" width="'+bw+'" height="'+(b.H-b.p.b-vy(item.volume))+'" fill="'+color+'" opacity=".55"/></g>';if(i%Math.max(1,Math.ceil(d.length/6))===0)s+='<text x="'+xx+'" y="'+(b.H-22)+'" text-anchor="middle" fill="var(--muted)" font-size="11">'+axisDate(item.date)+'</text>'});
  maSeries.forEach(series=>{s+='<path d="'+seriesPath(series.values,x,b.y)+'" fill="none" stroke="'+series.c+'" stroke-width="1.55"/>'});
  s+='<rect data-hit="1" x="'+b.p.l+'" y="'+b.p.t+'" width="'+plotW+'" height="'+(b.H-b.p.t-b.p.b)+'" fill="transparent"/></svg>';
  chart.querySelector('svg')?.remove();chart.insertAdjacentHTML('afterbegin',s);hoverK(d,b,x,maSeries);drawIndicator();
}
function indicatorDefinition(){const source=payload.indicators||{};if(indicatorMode==='kdj')return{series:[{label:'K',values:source.kdj?.k||[],c:'var(--gold)'},{label:'D',values:source.kdj?.d||[],c:'var(--blue)'},{label:'J',values:source.kdj?.j||[],c:'var(--purple)'}],guides:[20,80]};if(indicatorMode==='rsi')return{series:[{label:'RSI6',values:source.rsi?.rsi6||[],c:'var(--purple)'},{label:'RSI12',values:source.rsi?.rsi12||[],c:'var(--gold)'},{label:'RSI24',values:source.rsi?.rsi24||[],c:'var(--cyan)'}],fixed:[0,100],guides:[30,70]};if(indicatorMode==='mom')return{series:[{label:'MOM(10)',values:source.mom?.mom||[],c:'var(--coral)'},{label:'MAMOM(6)',values:source.mom?.average||[],c:'var(--blue)'}],zero:true};return{series:[{label:'DIF',values:source.macd?.dif||[],c:'var(--gold)'},{label:'DEA',values:source.macd?.dea||[],c:'var(--purple)'}],bars:source.macd?.histogram||[],barLabel:'MACD',zero:true}}
function drawIndicator(){const target=document.getElementById('indicatorChart');if(!target||!all.length||!payload.indicators)return;const def=indicatorDefinition(),series=def.series.map(item=>({...item,visible:item.values.slice(start,end+1)})),bars=def.bars?.slice(start,end+1)||[],raw=series.flatMap(item=>item.visible).concat(bars).filter(Number.isFinite);if(!raw.length)return;const W=1200,H=150,p={l:78,r:78,t:10,b:25},baseLo=def.fixed?def.fixed[0]:Math.min(...raw,...(def.zero?[0]:[]),...(def.guides||[])),baseHi=def.fixed?def.fixed[1]:Math.max(...raw,...(def.zero?[0]:[]),...(def.guides||[])),pad=def.fixed?0:(baseHi-baseLo||1)*.09,lo=baseLo-pad,hi=baseHi+pad,rg=hi-lo||1,y=value=>p.t+(hi-value)/rg*(H-p.t-p.b),plotW=W-p.l-p.r,x=index=>p.l+(index+.5)*plotW/(end-start+1),barW=Math.max(2,plotW/(end-start+1)*.62);let s='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">';for(let n=0;n<3;n++){const value=hi-n*rg/2,yy=y(value);s+='<line x1="'+p.l+'" x2="'+(W-p.r)+'" y1="'+yy+'" y2="'+yy+'" stroke="var(--edge)"/><text x="'+(p.l-9)+'" y="'+(yy+4)+'" text-anchor="end" fill="var(--muted)" font-size="10">'+indicatorNumber(value)+'</text>'}(def.guides||[]).forEach(value=>{if(value>=lo&&value<=hi)s+='<line x1="'+p.l+'" x2="'+(W-p.r)+'" y1="'+y(value)+'" y2="'+y(value)+'" stroke="var(--muted)" stroke-dasharray="5 5" opacity=".65"/>'});if(def.zero&&lo<=0&&hi>=0)s+='<line x1="'+p.l+'" x2="'+(W-p.r)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--muted)" opacity=".8"/>';bars.forEach((value,index)=>{if(!Number.isFinite(value))return;const yy=y(value),zero=y(0),color=value>=0?'var(--rise)':'var(--fall)';s+='<rect x="'+(x(index)-barW/2)+'" y="'+Math.min(yy,zero)+'" width="'+barW+'" height="'+Math.max(1,Math.abs(yy-zero))+'" fill="'+color+'" opacity=".72"/>'});series.forEach(item=>{s+='<path d="'+seriesPath(item.visible,x,y)+'" fill="none" stroke="'+item.c+'" stroke-width="1.55"/>'});s+='<rect data-indicator-hit="1" x="'+p.l+'" y="'+p.t+'" width="'+plotW+'" height="'+(H-p.t-p.b)+'" fill="transparent"/></svg>';target.innerHTML=s;indicatorRender={b:{W,H,p,lo,hi,rg,y},x,series,bars,def};updateIndicatorLegend(end);hoverIndicator()}
function indicatorNumber(value){const absolute=Math.abs(value);return absolute>=1000?value.toFixed(0):absolute>=100?value.toFixed(1):value.toFixed(2)}
function updateIndicatorLegend(globalIndex){const legend=document.getElementById('indicatorLegend'),signal=document.getElementById('indicatorSignal'),def=indicatorDefinition();if(!legend||!signal)return;const values=def.series.map(item=>({label:item.label,value:item.values[globalIndex],c:item.c}));if(def.bars)values.push({label:def.barLabel,value:def.bars[globalIndex],c:(def.bars[globalIndex]||0)>=0?'var(--rise)':'var(--fall)'});legend.innerHTML=values.map(item=>'<span style="color:'+item.c+'">'+item.label+' <span class="value">'+(Number.isFinite(item.value)?indicatorNumber(item.value):'--')+'</span></span>').join('');const result=indicatorSignal(def,globalIndex);signal.textContent=result.text;signal.className='indicator-signal '+result.tone}
function indicatorSignal(def,index){if(indicatorMode==='macd'){const value=def.bars[index],previous=def.bars[index-1];if(!Number.isFinite(value))return{text:'数据积累中',tone:''};if(value>=0)return{text:!Number.isFinite(previous)||value>=previous?'上涨动量增强':'上涨动量减弱',tone:'rise'};return{text:Number.isFinite(previous)&&value<previous?'下跌动量增强':'下跌动量减弱',tone:'fall'}}if(indicatorMode==='kdj'){const k=def.series[0].values[index],d=def.series[1].values[index];if(!Number.isFinite(k)||!Number.isFinite(d))return{text:'数据积累中',tone:''};if(k>80&&d>80)return{text:'超买区',tone:'rise'};if(k<20&&d<20)return{text:'超卖区',tone:'fall'};return{text:k>=d?'K 在 D 上方 · 偏强':'K 在 D 下方 · 偏弱',tone:k>=d?'rise':'fall'}}if(indicatorMode==='rsi'){const value=def.series[0].values[index];if(!Number.isFinite(value))return{text:'数据积累中',tone:''};if(value>=70)return{text:'强势区 · 偏热',tone:'rise'};if(value<=30)return{text:'弱势区 · 超卖',tone:'fall'};return{text:value>=50?'动能偏强':'动能偏弱',tone:value>=50?'rise':'fall'}}const value=def.series[0].values[index],previous=def.series[0].values[index-1];if(!Number.isFinite(value))return{text:'数据积累中',tone:''};return{text:value>=0?(!Number.isFinite(previous)||value>=previous?'上涨动量增强':'上涨动量减弱'):(Number.isFinite(previous)&&value<previous?'下跌动量增强':'下跌动量减弱'),tone:value>=0?'rise':'fall'}}
function focusIndicator(localIndex){const target=document.getElementById('indicatorChart'),svg=target?.querySelector('svg'),render=indicatorRender;if(!svg||!render)return;svg.querySelector('#indicatorCrosshair')?.remove();localIndex=Math.max(0,Math.min(end-start,localIndex));const xx=render.x(localIndex),date=all[start+localIndex]?.date||'',label=axisDate(date),width=Math.max(58,label.length*7+14),left=Math.max(render.b.p.l,Math.min(render.b.W-render.b.p.r-width,xx-width/2));let s='<g id="indicatorCrosshair" pointer-events="none"><line x1="'+xx+'" x2="'+xx+'" y1="'+render.b.p.t+'" y2="'+(render.b.H-render.b.p.b)+'" stroke="#7b7e86"/><rect x="'+left+'" y="'+(render.b.H-render.b.p.b+2)+'" width="'+width+'" height="21" rx="3" fill="#676a72"/><text x="'+(left+width/2)+'" y="'+(render.b.H-7)+'" text-anchor="middle" fill="white" font-size="9">'+label+'</text>';render.series.forEach(item=>{const value=item.visible[localIndex];if(Number.isFinite(value))s+='<circle cx="'+xx+'" cy="'+render.b.y(value)+'" r="4" fill="var(--panel)" stroke="'+item.c+'" stroke-width="2"/>'});s+='</g>';svg.insertAdjacentHTML('beforeend',s);updateIndicatorLegend(start+localIndex)}
function resetIndicatorFocus(){document.getElementById('indicatorChart')?.querySelector('#indicatorCrosshair')?.remove();updateIndicatorLegend(end)}
function hoverIndicator(){const target=document.getElementById('indicatorChart'),svg=target?.querySelector('svg'),hit=svg?.querySelector('[data-indicator-hit]'),render=indicatorRender;if(!hit||!render)return;hit.onmousemove=event=>{const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)/rect.width*render.b.W,index=Math.max(0,Math.min(end-start,Math.floor((px-render.b.p.l)/(render.b.W-render.b.p.l-render.b.p.r)*(end-start+1))));focusIndicator(index)};hit.onmouseleave=resetIndicatorFocus}
function minuteSlot(time){const value=time.slice(-5).split(':'),minutes=Number(value[0])*60+Number(value[1]);if(minutes<=690)return Math.max(0,minutes-570);if(minutes>=780)return Math.min(240,121+Math.max(0,minutes-781));return 120}
function slotTime(slot){if(slot<=120){const minutes=570+slot;return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0')}const minutes=781+(slot-121);return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0')}
function drawMinute(d,pre,five){
  pre=Number(pre)||d[0].price;const b=minuteBase(d,pre),plotW=b.W-b.p.l-b.p.r,total=five?d.length:241,slotOf=(item,i)=>five?i:minuteSlot(item.time),xSlot=slot=>b.p.l+slot*plotW/Math.max(1,total-1),xItem=(item,i)=>xSlot(slotOf(item,i)),maxV=Math.max(...d.map(item=>item.volume),1),barW=Math.max(.7,Math.min(3,plotW/total*.72));
  const line=key=>{let begun=false;return d.map((item,i)=>{const value=item[key];if(!Number.isFinite(value)||value<=0)return'';const command=begun?'L':'M';begun=true;return command+xItem(item,i).toFixed(1)+' '+b.y(value).toFixed(1)}).join(' ')},lastX=xItem(d[d.length-1],d.length-1),firstX=xItem(d[0],0),area=line('price')+' L'+lastX+' '+b.pb+' L'+firstX+' '+b.pb+' Z',priceColor=d[d.length-1].price>=pre?'var(--rise)':'var(--fall)';
  let s='<svg viewBox="0 0 '+b.W+' '+b.H+'" preserveAspectRatio="none">'+minuteGrid(b,pre)+'<path d="'+area+'" fill="#2979ff12"/><path d="'+line('price')+'" fill="none" stroke="'+priceColor+'" stroke-width="1.8"/><path d="'+line('average')+'" fill="none" stroke="var(--gold)" stroke-width="1.4"/>';
  d.forEach((item,i)=>{const color=item.price>=pre?'var(--rise)':'var(--fall)',height=item.volume/maxV*b.vol,xx=xItem(item,i);s+='<rect x="'+(xx-barW/2)+'" y="'+(b.H-b.p.b-height)+'" width="'+barW+'" height="'+height+'" fill="'+color+'" opacity=".7"/>'});
  if(five){for(let n=0;n<6;n++){const i=Math.round(n*(d.length-1)/5);s+='<text x="'+xSlot(i)+'" y="'+(b.H-22)+'" text-anchor="middle" fill="var(--muted)" font-size="11">'+d[i].time.slice(5,10)+'</text>'}}else{[[0,'09:30'],[60,'10:30'],[120,'11:30'],[180,'14:00'],[240,'15:00']].forEach(label=>{s+='<text x="'+xSlot(label[0])+'" y="'+(b.H-22)+'" text-anchor="middle" fill="var(--muted)" font-size="11">'+label[1]+'</text>'})}
  const high=d.reduce((left,right)=>right.price>left.price?right:left),low=d.reduce((left,right)=>right.price<left.price?right:left),highIndex=d.indexOf(high),lowIndex=d.indexOf(low),highX=xItem(high,highIndex),lowX=xItem(low,lowIndex);
  s+='<circle cx="'+highX+'" cy="'+b.y(high.price)+'" r="4" fill="var(--blue)"/><text x="'+highX+'" y="'+(b.y(high.price)-9)+'" text-anchor="middle" fill="var(--muted)" font-size="10">最高 '+high.price.toFixed(2)+'</text><circle cx="'+lowX+'" cy="'+b.y(low.price)+'" r="4" fill="var(--blue)"/><text x="'+lowX+'" y="'+(b.y(low.price)+16)+'" text-anchor="middle" fill="var(--muted)" font-size="10">最低 '+low.price.toFixed(2)+'</text><rect data-hit="1" x="'+b.p.l+'" y="'+b.p.t+'" width="'+plotW+'" height="'+(b.H-b.p.t-b.p.b)+'" fill="transparent"/></svg>';
  chart.querySelector('svg')?.remove();chart.insertAdjacentHTML('afterbegin',s);hoverMinute(d,b,xSlot,slotOf,pre,five,total);
}
function crosshair(svg,b,xx,yy,xLabel,yValue,points,rightLabel){
  svg.querySelector('#crosshair')?.remove();xx=Math.max(b.p.l,Math.min(b.W-b.p.r,xx));yy=Math.max(b.p.t,Math.min(b.pb,yy));const xWidth=Math.max(66,xLabel.length*8+18),xLeft=Math.max(b.p.l,Math.min(b.W-b.p.r-xWidth,xx-xWidth/2)),leftWidth=b.p.l-10;let s='<g id="crosshair" pointer-events="none"><line x1="'+xx+'" x2="'+xx+'" y1="'+b.p.t+'" y2="'+(b.H-b.p.b)+'" stroke="#7b7e86" stroke-width="1"/><line x1="'+b.p.l+'" x2="'+(b.W-b.p.r)+'" y1="'+yy+'" y2="'+yy+'" stroke="#7b7e86" stroke-width="1" stroke-dasharray="6 4"/><rect x="2" y="'+(yy-12)+'" width="'+leftWidth+'" height="24" rx="4" fill="#676a72"/><text x="'+(2+leftWidth/2)+'" y="'+(yy+4)+'" text-anchor="middle" fill="white" font-size="11">'+yValue.toFixed(2)+'</text><rect x="'+xLeft+'" y="'+(b.pb+5)+'" width="'+xWidth+'" height="25" rx="4" fill="#676a72"/><text x="'+(xLeft+xWidth/2)+'" y="'+(b.pb+22)+'" text-anchor="middle" fill="white" font-size="11">'+xLabel+'</text>';
  if(rightLabel){s+='<rect x="'+(b.W-b.p.r+5)+'" y="'+(yy-12)+'" width="'+(b.p.r-8)+'" height="24" rx="4" fill="#676a72"/><text x="'+(b.W-b.p.r+(b.p.r-3)/2)+'" y="'+(yy+4)+'" text-anchor="middle" fill="white" font-size="11">'+rightLabel+'</text>'}
  points.forEach(point=>{if(Number.isFinite(point.y))s+='<circle cx="'+point.x+'" cy="'+point.y+'" r="5" fill="var(--panel)" stroke="'+point.color+'" stroke-width="2.5"/>'});s+='</g>';svg.insertAdjacentHTML('beforeend',s);
}
function pointerPosition(event,svg,b){const rect=svg.getBoundingClientRect();return{px:(event.clientX-rect.left)/rect.width*b.W,py:(event.clientY-rect.top)/rect.height*b.H}}
function placeTip(event){const rect=chart.getBoundingClientRect(),left=event.clientX-rect.left,top=event.clientY-rect.top;tip.style.display='block';tip.style.left=(left>chart.clientWidth*.62?Math.max(8,left-226):Math.min(chart.clientWidth-218,left+18))+'px';tip.style.top=Math.max(8,Math.min(chart.clientHeight-220,top-52))+'px'}
function hoverMinute(d,b,xSlot,slotOf,pre,five,total){const svg=chart.querySelector('svg'),hit=svg?.querySelector('[data-hit]');if(!hit)return;hit.onmousemove=event=>{const pos=pointerPosition(event,svg,b),target=Math.max(0,Math.min(total-1,Math.round((pos.px-b.p.l)/(b.W-b.p.l-b.p.r)*(total-1))));let index=0,distance=Infinity;d.forEach((item,i)=>{const next=Math.abs(slotOf(item,i)-target);if(next<distance){distance=next;index=i}});const item=d[index],hasData=five||distance<=1,xLabel=five?item.time.slice(5,16):slotTime(target),yValue=b.hi-(Math.max(b.p.t,Math.min(b.pb,pos.py))-b.p.t)/(b.pb-b.p.t)*b.rg,points=hasData?[{x:xSlot(slotOf(item,index)),y:b.y(item.price),color:item.price>=pre?'var(--rise)':'var(--fall)'},{x:xSlot(slotOf(item,index)),y:b.y(item.average),color:'var(--gold)'}]:[],right=((yValue-pre)/pre*100);crosshair(svg,b,xSlot(target),pos.py,xLabel,yValue,points,(right>0?'+':'')+right.toFixed(2)+'%');if(hasData){const change=(item.price-pre)/pre*100;placeTip(event);tip.innerHTML='<b>'+stockName+'</b><br>时间：'+item.time.slice(11,16)+'<br>价格：<span style="color:'+(change>=0?'var(--rise)':'var(--fall)')+'">'+item.price.toFixed(2)+'</span><br>涨跌幅：<span style="color:'+(change>=0?'var(--rise)':'var(--fall)')+'">'+(change>0?'+':'')+change.toFixed(2)+'%</span><br>均价：'+item.average.toFixed(2)+'<br>成交量：'+fmt(item.volume)}else tip.style.display='none'};hit.onmouseleave=()=>{tip.style.display='none';svg.querySelector('#crosshair')?.remove()}}
function hoverK(d,b,x,maSeries){const svg=chart.querySelector('svg'),hit=svg?.querySelector('[data-hit]');if(!hit)return;hit.onmousemove=event=>{const pos=pointerPosition(event,svg,b),index=Math.max(0,Math.min(d.length-1,Math.floor((pos.px-b.p.l)/(b.W-b.p.l-b.p.r)*d.length))),item=d[index],yValue=b.hi-(Math.max(b.p.t,Math.min(b.pb,pos.py))-b.p.t)/(b.pb-b.p.t)*b.rg,points=[{x:x(index),y:b.y(item.close),color:item.close>=item.open?'var(--rise)':'var(--fall)'}],maText=[];maSeries.forEach(series=>{const value=series.values[index];if(value!=null&&Number.isFinite(value)){points.push({x:x(index),y:b.y(value),color:series.c});maText.push('MA'+series.n+'：'+value.toFixed(2))}});crosshair(svg,b,x(index),pos.py,item.date,yValue,points,'');focusIndicator(index);const previous=all[start+index-1]?.close,change=Number.isFinite(item.changePercent)?item.changePercent:(previous?(item.close-previous)/previous*100:0);placeTip(event);tip.innerHTML='<b>'+stockName+'</b><br>时间：'+item.date+'<br>开盘：'+item.open.toFixed(2)+'　收盘：'+item.close.toFixed(2)+'<br>最低：'+item.low.toFixed(2)+'　最高：'+item.high.toFixed(2)+'<br>成交量：'+fmt(item.volume)+'<br>'+(Number.isFinite(item.amount)?'成交额：'+money(item.amount)+'<br>':'')+'涨跌幅：<span style="color:'+(change>=0?'var(--rise)':'var(--fall)')+'">'+(change>0?'+':'')+change.toFixed(2)+'%</span><br>'+maText.join('　')};hit.onmouseleave=()=>{tip.style.display='none';svg.querySelector('#crosshair')?.remove();resetIndicatorFocus()}}
function setupRange(){if(all.length<2)return;const box=document.getElementById('range'),sel=document.getElementById('selection'),sl=document.getElementById('shadeL'),sr=document.getElementById('shadeR'),dl=document.getElementById('dateL'),dr=document.getElementById('dateR'),spark=document.getElementById('spark'),closes=all.map(a=>a.close),lo=Math.min(...closes),rg=Math.max(...closes)-lo||1;spark.setAttribute('viewBox','0 0 1000 40');spark.innerHTML='<path d="'+closes.map((v,i)=>(i?'L':'M')+(i/(closes.length-1)*1000)+' '+(38-(v-lo)/rg*34)).join(' ')+'" fill="none" stroke="var(--blue)" stroke-width="2"/>';function sync(){const l=start/(all.length-1)*100,r=end/(all.length-1)*100;sel.style.left=l+'%';sel.style.width=(r-l)+'%';sl.style.left=0;sl.style.width=l+'%';sr.style.left=r+'%';sr.style.right=0;dl.textContent=all[start].date;dr.textContent=all[end].date}sync();let drag=null,x0=0,s0=0,e0=0;box.onpointerdown=e=>{const h=e.target.dataset?.handle;drag=h||((e.target===sel)?'move':'new');x0=e.clientX;s0=start;e0=end;box.setPointerCapture(e.pointerId);if(drag==='new'){const i=Math.round(e.offsetX/box.clientWidth*(all.length-1));start=i;end=Math.min(all.length-1,i+10);sync();drawK()}};box.onpointermove=e=>{if(!drag)return;const di=Math.round((e.clientX-x0)/box.clientWidth*(all.length-1));if(drag==='left')start=Math.max(0,Math.min(e0-4,s0+di));else if(drag==='right')end=Math.min(all.length-1,Math.max(s0+4,e0+di));else if(drag==='move'){const size=e0-s0;start=Math.max(0,Math.min(all.length-1-size,s0+di));end=start+size}else end=Math.max(start+4,Math.min(all.length-1,e0+di));sync();drawK()};box.onpointerup=()=>drag=null}
function axisDate(value){return value.length>10?value.slice(5,16):value.slice(5)}function fmt(v){return v>=1e8?(v/1e8).toFixed(2)+'亿':v>=1e4?(v/1e4).toFixed(2)+'万':Number(v).toFixed(0)}function money(v){return v>=1e8?(v/1e8).toFixed(2)+'亿':v>=1e4?(v/1e4).toFixed(2)+'万':Number(v).toFixed(2)}
</script></body></html>`;
  }
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function marketPhaseText(phase: MarketPhase): string {
  if (phase === 'continuous') return '交易中';
  if (phase === 'call-auction') return '集合竞价';
  if (phase === 'pre-open') return '待开盘';
  return '已收盘';
}

function priceTone(value: number, previousClose: number): string {
  return value > previousClose ? 'rise' : value < previousClose ? 'fall' : '';
}

function priceValue(value: number | undefined): string {
  return Number.isFinite(value) && value! > 0 ? value!.toFixed(2) : '--';
}

function numberValue(value: number | undefined): string {
  return Number.isFinite(value) ? value!.toFixed(2) : '--';
}

function percentValue(value: number | undefined): string {
  return Number.isFinite(value) ? `${value!.toFixed(2)}%` : '--';
}

function handsValue(shares: number | undefined): string {
  if (!Number.isFinite(shares)) return '--';
  const hands = shares! / 100;
  return hands >= 10_000 ? `${(hands / 10_000).toFixed(2)}万手` : `${hands.toFixed(0)}手`;
}

function moneyValue(value: number | undefined): string {
  if (!Number.isFinite(value)) return '--';
  return value! >= 1e8 ? `${(value! / 1e8).toFixed(2)}亿` : `${(value! / 1e4).toFixed(2)}万`;
}

function marketCapValue(value: number | undefined): string {
  return Number.isFinite(value) ? `${(value! / 1e8).toFixed(2)}亿` : '--';
}

function renderOrderBook(orderBook: OrderBook | undefined, previousClose: number, currentPrice: number): string {
  if (orderBook === undefined) {
    return '<div class="order-title"><span>买卖五档</span><span class="order-snapshot">实时</span></div><div class="order-empty">五档加载中…</div>';
  }
  if (!orderBook.bids.length && !orderBook.asks.length) {
    return '<div class="order-title"><span>买卖五档</span><span class="order-snapshot">自动重试</span></div><div class="order-empty">暂无五档数据</div>';
  }
  const empty: OrderBookLevel = { price: 0, volume: 0 };
  const bids = Array.from({ length: 5 }, (_, index) => orderBook.bids[index] ?? empty);
  const asks = Array.from({ length: 5 }, (_, index) => orderBook.asks[index] ?? empty);
  const row = (label: string, side: 'buy' | 'sell', level: OrderBookLevel) => `<div class="order-row"><span class="order-label ${side}">${label}</span><span class="${priceTone(level.price, previousClose)}">${priceValue(level.price)}</span><span>${orderHandsValue(level.volume)}</span></div>`;
  const askRows = asks.map((level, index) => ({ level, number: index + 1 })).reverse()
    .map(item => row(`卖${item.number}`, 'sell', item.level)).join('');
  const bidRows = bids.map((level, index) => row(`买${index + 1}`, 'buy', level)).join('');
  const displayedPrice = orderBook.currentPrice || currentPrice;
  const snapshotTime = orderBook.time || '实时';
  return `<div class="order-title"><span>买卖五档</span><span class="order-snapshot">${esc(snapshotTime)}</span></div><div class="order-head"><span>档位</span><span>价格</span><span>手数</span></div>${askRows}<div class="order-divider ${priceTone(displayedPrice, previousClose)}">${priceValue(displayedPrice)}</div>${bidRows}`;
}

function orderHandsValue(shares: number): string {
  if (!Number.isFinite(shares) || shares <= 0) return '--';
  const hands = shares / 100;
  return hands >= 10_000 ? `${(hands / 10_000).toFixed(2)}万` : hands.toFixed(0);
}
