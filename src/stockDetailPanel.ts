import * as vscode from 'vscode';
import { Candle, CandlePeriod, fetchCandles, fetchIntraday, MinutePoint } from './history';
import { fetchQuotes, fetchStockConcepts, marketPhase, MarketPhase, Quote } from './market';

type Period = 'minute' | 'fiveDay' | CandlePeriod;
type ChartData = { candles?: Candle[]; points?: MinutePoint[]; previousClose?: number };

const REFRESH_INTERVAL_MS = 10_000;

export class StockDetailPanel {
  private static current: StockDetailPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly timer: NodeJS.Timeout;
  private period: Period = 'minute';
  private requestId = 0;
  private concepts?: string[];
  private conceptsSymbol?: string;
  private conceptsPromise?: Promise<void>;

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
    try {
      let chartData: ChartData;
      if (period === 'minute' || period === 'fiveDay') {
        const result = await fetchIntraday(symbol, period === 'fiveDay' ? 5 : 1);
        chartData = { points: result.points, previousClose: result.previousClose ?? quoteSnapshot.previousClose };
      } else {
        const candles = await fetchCandles(symbol, period);
        if (period === 'day') this.mergeCurrentDay(candles, quoteSnapshot);
        chartData = { candles };
      }
      await quotePromise;
      await conceptsPromise;
      if (requestId !== this.requestId) return;
      this.panel.title = `${this.quote.name} · 行情`;
      this.panel.webview.html = this.html(period, chartData);
    } catch (error) {
      await quotePromise;
      await conceptsPromise;
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
    const data = JSON.stringify(chartData).replace(/</g, '\\u003c');
    const nameData = JSON.stringify(this.quote.name).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
:root{--rise:#f04438;--fall:#079447;--gold:#f2b800;--purple:#8b5cf6;--blue:#4f70d9;--lime:#81c968;--coral:#ef6666;--cyan:#58bce6;--emerald:#33a36c;--panel:color-mix(in srgb,var(--vscode-editor-background) 88%,white);--edge:color-mix(in srgb,var(--vscode-foreground) 13%,transparent);--muted:var(--vscode-descriptionForeground)}
*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:Inter,var(--vscode-font-family);font-variant-numeric:tabular-nums}.shell{max-width:1500px;margin:auto;padding:16px 20px 22px}
.overview{margin-bottom:12px;padding:11px 15px 13px;background:var(--panel);border:1px solid var(--edge);border-radius:9px;box-shadow:0 7px 20px #0001}.market-status{display:flex;align-items:center;gap:7px;min-width:0;margin-bottom:11px;font-size:13px}.phase{font-weight:700;flex:none}.overview-time{color:var(--muted);flex:none}.concepts{display:flex;align-items:center;gap:6px;min-width:0;margin-left:14px;font-size:12px}.concept-label{flex:none;color:var(--muted)}.concept-names{overflow:hidden;color:var(--vscode-foreground);text-overflow:ellipsis;white-space:nowrap}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 54px}.metric-group{display:grid;grid-template-columns:minmax(70px,auto) 1fr;gap:7px 14px;align-items:baseline}.metric-label{color:var(--muted);font-size:12px}.metric-value{font-size:13px;font-weight:650}.rise{color:var(--rise)}.fall{color:var(--fall)}
.terminal{background:var(--panel);border:1px solid var(--edge);border-radius:11px;overflow:hidden;box-shadow:0 9px 26px #0001}.bar{min-height:39px;display:flex;align-items:center;flex-wrap:wrap;padding:7px 14px;border-bottom:1px solid var(--edge);gap:5px}.tab{height:26px;padding:0 14px;border:0;border-radius:5px;background:transparent;color:var(--muted);cursor:pointer;font-size:12px;font-weight:600}.tab:hover{background:var(--edge);color:var(--vscode-foreground)}.tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.legend{margin-left:auto;display:flex;flex-wrap:wrap;gap:10px;font-size:11px}.dot:before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px}.ma5:before{background:var(--blue)}.ma10:before{background:var(--lime)}.ma20:before{background:var(--gold)}.ma30:before{background:var(--coral)}.ma50:before{background:var(--cyan)}.ma250:before{background:var(--emerald)}.avg:before{background:var(--gold)}
.chart{position:relative;height:420px;padding:8px}.chart svg{width:100%;height:100%;display:block}.empty{height:100%;display:grid;place-items:center;color:var(--muted)}.tip{position:absolute;display:none;pointer-events:none;background:color-mix(in srgb,var(--vscode-editor-background) 94%,transparent);border:1px solid var(--edge);border-radius:6px;padding:7px 9px;box-shadow:0 6px 17px #0004;font-size:11px;line-height:1.6;z-index:3}
.range-wrap{display:${period === 'minute' || period === 'fiveDay' ? 'none' : 'block'};padding:0 21px 14px}.range-title{font-size:10px;color:var(--muted);margin-bottom:6px}.range{height:36px;position:relative;border-radius:5px;background:color-mix(in srgb,var(--blue) 8%,var(--vscode-editor-background));overflow:hidden;touch-action:none;cursor:crosshair}.spark{position:absolute;inset:4px;opacity:.55}.shade{position:absolute;top:0;bottom:0;background:#0005;pointer-events:none}.selection{position:absolute;top:0;bottom:0;border:1px solid var(--blue);background:#4aa8ff16;cursor:grab}.selection:active{cursor:grabbing}.handle{position:absolute;top:0;bottom:0;width:7px;background:var(--blue);cursor:ew-resize}.handle.left{left:-3px}.handle.right{right:-3px}.dates{display:flex;justify-content:space-between;color:var(--muted);font-size:9px;margin-top:4px}
@media(max-width:800px){.shell{padding:9px}.metrics{grid-template-columns:1fr;gap:9px}.chart{height:338px}.legend{width:100%;margin-left:4px}.tab{padding:0 9px}}
</style></head><body><main class="shell">
<section class="overview"><div class="market-status"><span class="phase">${phaseText}</span><span class="overview-time">${esc(timeText)}</span><span class="concepts"><span class="concept-label">所属概念</span><span class="concept-names" title="${esc(conceptText)}">${esc(conceptText)}</span></span></div><div class="metrics">
<div class="metric-group"><span class="metric-label">今开</span><strong class="metric-value ${priceTone(this.quote.open, this.quote.previousClose)}">${priceValue(this.quote.open)}</strong><span class="metric-label">昨收</span><strong class="metric-value">${priceValue(this.quote.previousClose)}</strong><span class="metric-label">换手率</span><strong class="metric-value">${percentValue(this.quote.turnoverRate)}</strong></div>
<div class="metric-group"><span class="metric-label">最高</span><strong class="metric-value ${priceTone(this.quote.high, this.quote.previousClose)}">${priceValue(this.quote.high)}</strong><span class="metric-label">最低</span><strong class="metric-value ${priceTone(this.quote.low, this.quote.previousClose)}">${priceValue(this.quote.low)}</strong><span class="metric-label">市盈(TTM)</span><strong class="metric-value">${numberValue(this.quote.peTTM)}</strong></div>
<div class="metric-group"><span class="metric-label">成交量</span><strong class="metric-value">${handsValue(this.quote.volume)}</strong><span class="metric-label">成交额</span><strong class="metric-value">${moneyValue(this.quote.amount)}</strong><span class="metric-label">总市值</span><strong class="metric-value">${marketCapValue(this.quote.totalMarketCap)}</strong></div>
</div></section>
<section class="terminal"><div class="bar"><button class="tab ${period === 'minute' ? 'active' : ''}" data-period="minute">分时</button><button class="tab ${period === 'fiveDay' ? 'active' : ''}" data-period="fiveDay">五日</button><button class="tab ${period === 'day' ? 'active' : ''}" data-period="day">日 K</button><button class="tab ${period === 'week' ? 'active' : ''}" data-period="week">周 K</button><button class="tab ${period === 'month' ? 'active' : ''}" data-period="month">月 K</button><button class="tab ${period === '5min' ? 'active' : ''}" data-period="5min">5 分</button><div class="legend">${period === 'minute' || period === 'fiveDay' ? '<span class="dot avg">均价</span>' : '<span class="dot ma5">MA5</span><span class="dot ma10">MA10</span><span class="dot ma20">MA20</span><span class="dot ma30">MA30</span><span class="dot ma50">MA50</span><span class="dot ma250">MA250</span>'}</div></div>
<div id="chart" class="chart">${message ? `<div class="empty">${esc(message)}</div>` : ''}<div id="tip" class="tip"></div></div>
<div class="range-wrap"><div class="range-title">拖动蓝色选区移动日期范围，拖动两侧手柄缩放</div><div id="range" class="range"><svg id="spark" class="spark"></svg><div id="shadeL" class="shade"></div><div id="shadeR" class="shade"></div><div id="selection" class="selection"><i class="handle left" data-handle="left"></i><i class="handle right" data-handle="right"></i></div></div><div class="dates"><span id="dateL">--</span><span id="dateR">--</span></div></div></section>
</main><script nonce="${nonce}">
const vscode=acquireVsCodeApi(),payload=${data},stockName=${nameData},mode='${period}',all=payload.candles||[],maDefs=[{n:5,c:'var(--blue)'},{n:10,c:'var(--lime)'},{n:20,c:'var(--gold)'},{n:30,c:'var(--coral)'},{n:50,c:'var(--cyan)'},{n:250,c:'var(--emerald)'}];let start=Math.max(0,all.length-60),end=all.length-1;
document.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>vscode.postMessage({type:'period',value:b.dataset.period}));
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
  chart.querySelector('svg')?.remove();chart.insertAdjacentHTML('afterbegin',s);hoverK(d,b,x,maSeries);
}
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
function hoverK(d,b,x,maSeries){const svg=chart.querySelector('svg'),hit=svg?.querySelector('[data-hit]');if(!hit)return;hit.onmousemove=event=>{const pos=pointerPosition(event,svg,b),index=Math.max(0,Math.min(d.length-1,Math.floor((pos.px-b.p.l)/(b.W-b.p.l-b.p.r)*d.length))),item=d[index],yValue=b.hi-(Math.max(b.p.t,Math.min(b.pb,pos.py))-b.p.t)/(b.pb-b.p.t)*b.rg,points=[{x:x(index),y:b.y(item.close),color:item.close>=item.open?'var(--rise)':'var(--fall)'}],maText=[];maSeries.forEach(series=>{const value=series.values[index];if(value!=null&&Number.isFinite(value)){points.push({x:x(index),y:b.y(value),color:series.c});maText.push('MA'+series.n+'：'+value.toFixed(2))}});crosshair(svg,b,x(index),pos.py,item.date,yValue,points,'');const previous=all[start+index-1]?.close,change=Number.isFinite(item.changePercent)?item.changePercent:(previous?(item.close-previous)/previous*100:0);placeTip(event);tip.innerHTML='<b>'+stockName+'</b><br>时间：'+item.date+'<br>开盘：'+item.open.toFixed(2)+'　收盘：'+item.close.toFixed(2)+'<br>最低：'+item.low.toFixed(2)+'　最高：'+item.high.toFixed(2)+'<br>成交量：'+fmt(item.volume)+'<br>'+(Number.isFinite(item.amount)?'成交额：'+money(item.amount)+'<br>':'')+'涨跌幅：<span style="color:'+(change>=0?'var(--rise)':'var(--fall)')+'">'+(change>0?'+':'')+change.toFixed(2)+'%</span><br>'+maText.join('　')};hit.onmouseleave=()=>{tip.style.display='none';svg.querySelector('#crosshair')?.remove()}}
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
