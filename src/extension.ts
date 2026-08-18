import * as vscode from 'vscode';
import { displayPrice, fetchQuotes, marketPhase, MarketPhase, normalizeSymbol, Quote, searchStocks } from './market';
import { StockDetailPanel } from './stockDetailPanel';

const MAX_STATUS_ITEMS = 5;
const WATCHLIST_MIME = 'application/vnd.code.tree.asharequotes.watchlist';
const DEFAULT_GROUP_ID = '__my_watchlist__';
const DEFAULT_GROUP_LABEL = '我的自选';
const NAME_COLUMN_WIDTH = 13;
const EN_SPACE = '\u2002';
const FIGURE_SPACE = '\u2007';

type CustomGroups = Record<string, string[]>;
type SortMode = 'manual' | 'changeDesc' | 'changeAsc';

const SORT_OPTIONS: Array<{ mode: SortMode; label: string; description: string }> = [
  { mode: 'manual', label: '手动顺序', description: '保持拖拽和上下移动后的顺序' },
  { mode: 'changeDesc', label: '涨跌幅：从高到低', description: '实时刷新时自动重排' },
  { mode: 'changeAsc', label: '涨跌幅：从低到高', description: '实时刷新时自动重排' }
];

function sortModeLabel(mode: SortMode): string {
  return SORT_OPTIONS.find(item => item.mode === mode)?.label ?? '手动顺序';
}

function fixedNameColumn(value: string): string {
  let result = '';
  let width = 0;
  for (const char of value) {
    const charWidth = /^[\x00-\x7f]$/.test(char) ? 1 : 2;
    if (width + charWidth > NAME_COLUMN_WIDTH) break;
    result += char;
    width += charWidth;
  }
  return result + EN_SPACE.repeat(NAME_COLUMN_WIDTH - width);
}

function fixedNumberColumn(value: string, width: number): string {
  return value.padStart(width, FIGURE_SPACE);
}

function uniqueSymbols(values: string[]): string[] {
  return [...new Set(values.map(normalizeSymbol).filter((value): value is string => Boolean(value)))];
}

function configuredStatusSymbols(config: vscode.WorkspaceConfiguration): string[] {
  const scope = config.inspect<string[]>('statusBarSymbols');
  const explicit = scope?.workspaceFolderValue ?? scope?.workspaceValue ?? scope?.globalValue;
  if (explicit !== undefined) return uniqueSymbols(explicit).slice(0, MAX_STATUS_ITEMS);

  // Preserve the user's previous single-symbol selection until they first use
  // the new multi-select setting.
  const legacy = normalizeSymbol(config.get<string>('statusBarSymbol', 'sh000001'));
  return legacy ? [legacy] : [];
}

function statusSymbolsTarget(config: vscode.WorkspaceConfiguration): vscode.ConfigurationTarget {
  const current = config.inspect<string[]>('statusBarSymbols');
  if (current?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (current?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  if (current?.globalValue !== undefined) return vscode.ConfigurationTarget.Global;
  const legacy = config.inspect<string>('statusBarSymbol');
  if (legacy?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (legacy?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

function configuredGroups(config: vscode.WorkspaceConfiguration): CustomGroups {
  const raw = config.get<Record<string, unknown>>('groups', {});
  const result: CustomGroups = {};
  for (const [rawName, value] of Object.entries(raw)) {
    const name = rawName.trim();
    if (!name || name === DEFAULT_GROUP_LABEL || name === DEFAULT_GROUP_ID || !Array.isArray(value)) continue;
    result[name] = uniqueSymbols(value.filter((entry): entry is string => typeof entry === 'string'));
  }
  return result;
}

function groupsTarget(config: vscode.WorkspaceConfiguration): vscode.ConfigurationTarget {
  const scope = config.inspect<CustomGroups>('groups');
  if (scope?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (scope?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  if (scope?.globalValue !== undefined) return vscode.ConfigurationTarget.Global;
  const symbols = config.inspect<string[]>('symbols');
  if (symbols?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (symbols?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

function configuredGroupSorts(config: vscode.WorkspaceConfiguration): Record<string, SortMode> {
  const raw = config.get<Record<string, unknown>>('groupSorts', {});
  const valid = new Set<SortMode>(SORT_OPTIONS.map(item => item.mode));
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, SortMode] => valid.has(entry[1] as SortMode)));
}

function groupSortsTarget(config: vscode.WorkspaceConfiguration): vscode.ConfigurationTarget {
  const scope = config.inspect<Record<string, SortMode>>('groupSorts');
  if (scope?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (scope?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  if (scope?.globalValue !== undefined) return vscode.ConfigurationTarget.Global;
  return groupsTarget(config);
}

class QuoteItem extends vscode.TreeItem {
  constructor(public readonly quote: Quote, phase: MarketPhase, public readonly groupId: string, pinned = false) {
    const price = displayPrice(quote, phase);
    const change = quote.previousClose ? (price - quote.previousClose) / quote.previousClose * 100 : 0;
    const changeText = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
    const changeColumn = changeText.padEnd(8, FIGURE_SPACE);
    super(`${changeColumn}${EN_SPACE}${fixedNameColumn(quote.name)}`, vscode.TreeItemCollapsibleState.None);
    this.id = `${groupId}:${quote.symbol}`;
    const code = quote.symbol.slice(2);
    const priceLabel = phase === 'closed' ? '最新收盘' : '当前价';
    const priceColumn = fixedNumberColumn(price.toFixed(2), 8);
    // Keep the whole row compact: six code digits sit in an 11-digit-wide
    // centered column, which places the change near 90% of a typical sidebar.
    const codeColumnWidth = 11;
    const codePadding = codeColumnWidth - code.length;
    const codeColumn = `${FIGURE_SPACE.repeat(Math.floor(codePadding / 2))}${code}${FIGURE_SPACE.repeat(Math.ceil(codePadding / 2))}`;
    this.description = `${priceColumn}${FIGURE_SPACE.repeat(2)}${codeColumn}`;
    this.tooltip = new vscode.MarkdownString([
      `**${quote.name} (${quote.symbol})**`, '',
      `${priceLabel}：${price.toFixed(2)}  `,
      `今开：${quote.open.toFixed(2)}　最高：${quote.high.toFixed(2)}　最低：${quote.low.toFixed(2)}  `,
      `更新时间：${quote.date} ${quote.time}`
    ].join('\n'));
    this.contextValue = pinned ? 'quotePinned' : 'quote';
    this.iconPath = new vscode.ThemeIcon(change > 0 ? 'arrow-up' : change < 0 ? 'arrow-down' : 'dash',
      new vscode.ThemeColor(change > 0 ? 'charts.red' : change < 0 ? 'charts.green' : 'foreground'));
    if (quote.symbol) {
      this.command = { command: 'aShareQuotes.openStockDetail', title: '查看实时行情', arguments: [this] };
    }
  }
}

class GroupItem extends vscode.TreeItem {
  constructor(public readonly groupId: string, public readonly symbols: string[], public readonly sortMode: SortMode, isDefault = false) {
    super(isDefault ? DEFAULT_GROUP_LABEL : groupId, vscode.TreeItemCollapsibleState.Collapsed);
    // Bump the tree identity once so upgrades do not restore the old
    // all-expanded state cached by VS Code.
    this.id = `group:collapsed:${groupId}`;
    this.description = `${symbols.length}`;
    this.contextValue = `${isDefault ? 'defaultGroup' : 'customGroup'}.${sortMode}`;
    this.iconPath = new vscode.ThemeIcon(isDefault ? 'star-full' : 'folder');
    this.tooltip = `${isDefault ? DEFAULT_GROUP_LABEL : groupId} · ${symbols.length} 个证券 · ${sortModeLabel(sortMode)}`;
  }

  setAverageChange(value: number | undefined): void {
    const average = value === undefined ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
    this.description = `${this.symbols.length}  ${average}`;
    const label = this.groupId === DEFAULT_GROUP_ID ? DEFAULT_GROUP_LABEL : this.groupId;
    this.tooltip = `${label} · ${this.symbols.length} 个证券 · 平均涨跌幅 ${average} · ${sortModeLabel(this.sortMode)}`;
  }
}

type WatchlistItem = GroupItem | QuoteItem;
type DraggedQuote = { symbol: string; groupId: string };

class WatchlistDragAndDropController implements vscode.TreeDragAndDropController<WatchlistItem> {
  readonly dragMimeTypes = [WATCHLIST_MIME];
  readonly dropMimeTypes = [WATCHLIST_MIME];

  constructor(private readonly drop: (source: DraggedQuote[], targetGroup?: string, targetSymbol?: string) => Promise<void>) {}

  handleDrag(source: readonly WatchlistItem[], dataTransfer: vscode.DataTransfer): void {
    const entries = source
      .filter((item): item is QuoteItem => item instanceof QuoteItem)
      .map(item => ({ symbol: item.quote.symbol, groupId: item.groupId }));
    if (entries.length) dataTransfer.set(WATCHLIST_MIME, new vscode.DataTransferItem(entries));
  }

  async handleDrop(target: WatchlistItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested) return;
    const item = dataTransfer.get(WATCHLIST_MIME);
    if (!item) return;
    let value: unknown = item.value;
    if (!Array.isArray(value)) {
      try { value = JSON.parse(await item.asString()) as unknown; } catch { return; }
    }
    if (!Array.isArray(value)) return;
    const source = value.flatMap((entry): DraggedQuote[] => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as Partial<DraggedQuote>;
      const symbol = typeof candidate.symbol === 'string' ? normalizeSymbol(candidate.symbol) : undefined;
      return symbol && typeof candidate.groupId === 'string' ? [{ symbol, groupId: candidate.groupId }] : [];
    });
    if (!source.length || token.isCancellationRequested) return;
    await this.drop(
      source,
      target instanceof GroupItem ? target.groupId : target?.groupId,
      target instanceof QuoteItem ? target.quote.symbol : undefined
    );
  }
}

class QuoteProvider implements vscode.TreeDataProvider<WatchlistItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private quotes: Quote[] = [];
  private groups: GroupItem[] = [];
  private errorMessage = '';

  async refresh(): Promise<void> {
    const config = vscode.workspace.getConfiguration('aShareQuotes');
    const watchlistSymbols = uniqueSymbols(config.get<string[]>('symbols', []));
    const customGroups = configuredGroups(config);
    const groupSorts = configuredGroupSorts(config);
    this.groups = [
      new GroupItem(DEFAULT_GROUP_ID, watchlistSymbols, groupSorts[DEFAULT_GROUP_ID] ?? 'manual', true),
      ...Object.entries(customGroups).map(([name, symbols]) => new GroupItem(name, symbols, groupSorts[name] ?? 'manual'))
    ];
    // Also fetch manually configured status items, even if they are not in the
    // watchlist, so each pinned item can render independently.
    const symbols = uniqueSymbols([
      ...watchlistSymbols,
      ...Object.values(customGroups).flat(),
      ...configuredStatusSymbols(config)
    ]);
    try {
      const fetched = await fetchQuotes(symbols);
      const bySymbol = new Map(fetched.map(quote => [quote.symbol, quote]));
      this.quotes = symbols.map(symbol => bySymbol.get(symbol)).filter((quote): quote is Quote => Boolean(quote));
      this.errorMessage = '';
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }
    this.updateGroupAverages();
    this.emitter.fire();
  }

  private updateGroupAverages(): void {
    const phase = marketPhase();
    const bySymbol = new Map(this.quotes.map(quote => [quote.symbol, quote]));
    for (const group of this.groups) {
      const changes = group.symbols.flatMap(symbol => {
        const quote = bySymbol.get(symbol);
        if (!quote?.previousClose) return [];
        return [(displayPrice(quote, phase) - quote.previousClose) / quote.previousClose * 100];
      });
      const average = changes.length ? changes.reduce((sum, value) => sum + value, 0) / changes.length : undefined;
      group.setAverageChange(average);
    }
  }

  getQuotes(): Quote[] { return this.quotes; }
  getTreeItem(item: WatchlistItem): vscode.TreeItem { return item; }
  getChildren(element?: WatchlistItem): WatchlistItem[] {
    if (!element) return this.groups;
    if (element instanceof QuoteItem) return [];
    if (this.errorMessage && !this.quotes.length && element.groupId === DEFAULT_GROUP_ID) {
      const item = new QuoteItem({ symbol: '', name: '行情获取失败', open: 0, previousClose: 0, current: 0, bid: 0, ask: 0, high: 0, low: 0, volume: 0, date: '', time: '' }, 'closed', element.groupId);
      item.description = this.errorMessage;
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item];
    }
    const phase = marketPhase();
    const bySymbol = new Map(this.quotes.map(quote => [quote.symbol, quote]));
    const pinned = new Set(configuredStatusSymbols(vscode.workspace.getConfiguration('aShareQuotes')));
    const quotes = element.symbols
      .map(symbol => bySymbol.get(symbol))
      .filter((quote): quote is Quote => Boolean(quote));
    if (element.sortMode !== 'manual') {
      const price = (quote: Quote) => displayPrice(quote, phase);
      const change = (quote: Quote) => quote.previousClose ? (price(quote) - quote.previousClose) / quote.previousClose * 100 : 0;
      quotes.sort((left, right) => {
        let result = 0;
        if (element.sortMode === 'changeDesc') result = change(right) - change(left);
        else if (element.sortMode === 'changeAsc') result = change(left) - change(right);
        else result = change(left) - change(right);
        return result || left.symbol.localeCompare(right.symbol);
      });
    }
    return quotes
      .map(quote => new QuoteItem(quote, phase, element.groupId, pinned.has(quote.symbol)));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new QuoteProvider();
  const statusItems: Array<{ main: vscode.StatusBarItem; change: vscode.StatusBarItem }> = [];
  const statusItemsAt = (index: number): { main: vscode.StatusBarItem; change: vscode.StatusBarItem } => {
    let items = statusItems[index];
    if (!items) {
      const main = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100 - index * 2);
      const change = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99 - index * 2);
      main.name = `韭菜王 ${index + 1}`;
      change.name = `韭菜王 ${index + 1} 涨跌幅`;
      main.command = 'aShareQuotes.selectStatusStock';
      change.command = 'aShareQuotes.selectStatusStock';
      items = { main, change };
      statusItems[index] = items;
      context.subscriptions.push(main, change);
    }
    return items;
  };
  const refresh = async () => {
    await provider.refresh();
    const config = vscode.workspace.getConfiguration('aShareQuotes');
    const phase = marketPhase();
    const bySymbol = new Map(provider.getQuotes().map(quote => [quote.symbol, quote]));
    const pinned = configuredStatusSymbols(config);
    pinned.forEach((symbol, index) => {
      const status = statusItemsAt(index);
      const quote = bySymbol.get(symbol);
      if (!quote) {
        status.main.text = symbol.toUpperCase();
        status.main.tooltip = '暂无行情数据 · 点击管理状态栏固定项';
        status.main.command = 'aShareQuotes.selectStatusStock';
        status.main.color = new vscode.ThemeColor('statusBar.foreground');
        status.main.backgroundColor = undefined;
        status.main.show();
        status.change.hide();
        return;
      }
      const price = displayPrice(quote, phase);
      const change = quote.previousClose ? (price - quote.previousClose) / quote.previousClose * 100 : 0;
      const phaseTip = `${quote.date} ${quote.time} · 当前价 ${price.toFixed(2)}`;
      const command = { command: 'aShareQuotes.openStockDetail', title: '查看实时行情', arguments: [quote] };
      const tooltip = `${phaseTip}\n点击查看分时和 K 线`;
      status.main.text = `${quote.name} ${price.toFixed(2)}`;
      status.main.tooltip = tooltip;
      status.main.command = command;
      status.main.color = new vscode.ThemeColor('statusBar.foreground');
      status.main.backgroundColor = undefined;
      status.main.show();
      status.change.text = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
      status.change.tooltip = tooltip;
      status.change.command = command;
      status.change.color = new vscode.ThemeColor(change > 0 ? 'charts.red' : change < 0 ? 'charts.green' : 'statusBar.foreground');
      status.change.backgroundColor = undefined;
      status.change.show();
    });
    statusItems.slice(pinned.length).forEach(items => { items.main.hide(); items.change.hide(); });
  };

  const symbolsTarget = (config: vscode.WorkspaceConfiguration): vscode.ConfigurationTarget => {
    const scope = config.inspect<string[]>('symbols');
    if (scope?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
    if (scope?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
    return vscode.ConfigurationTarget.Global;
  };

  const symbolsInGroup = (config: vscode.WorkspaceConfiguration, groupId: string): string[] =>
    groupId === DEFAULT_GROUP_ID
      ? uniqueSymbols(config.get<string[]>('symbols', []))
      : configuredGroups(config)[groupId] ?? [];

  const updateGroupSymbols = async (config: vscode.WorkspaceConfiguration, groupId: string, symbols: string[]) => {
    const normalized = uniqueSymbols(symbols);
    if (groupId === DEFAULT_GROUP_ID) {
      await config.update('symbols', normalized, symbolsTarget(config));
      return;
    }
    const groups = configuredGroups(config);
    if (!(groupId in groups)) return;
    await config.update('groups', { ...groups, [groupId]: normalized }, groupsTarget(config));
  };

  const reorderStock = async (item: QuoteItem | undefined, destination: 'up' | 'down' | 'top' | 'bottom') => {
    const symbol = item?.quote.symbol;
    if (!symbol) return;
    const config = vscode.workspace.getConfiguration('aShareQuotes');
    const symbols = symbolsInGroup(config, item.groupId);
    const index = symbols.indexOf(symbol);
    if (index < 0) return;

    const next = [...symbols];
    const [selected] = next.splice(index, 1);
    if (destination === 'top') next.unshift(selected);
    else if (destination === 'bottom') next.push(selected);
    else if (destination === 'up') next.splice(Math.max(index - 1, 0), 0, selected);
    else next.splice(Math.min(index + 1, next.length), 0, selected);
    await updateGroupSymbols(config, item.groupId, next);
    await refresh();
  };

  const dragAndDropController = new WatchlistDragAndDropController(async (source, targetGroup, targetSymbol) => {
    const sourceGroups = new Set(source.map(item => item.groupId));
    const destination = targetGroup ?? (sourceGroups.size === 1 ? source[0].groupId : undefined);
    if (!destination) return;
    const dragged = uniqueSymbols(source.map(item => item.symbol));
    const draggedSet = new Set(dragged);
    if (targetSymbol && draggedSet.has(targetSymbol) && source.every(item => item.groupId === destination)) return;
    const config = vscode.workspace.getConfiguration('aShareQuotes');
    const current = symbolsInGroup(config, destination);
    const remaining = current.filter(symbol => !draggedSet.has(symbol));
    const targetIndex = targetSymbol ? remaining.indexOf(targetSymbol) : remaining.length;
    if (targetSymbol && targetIndex < 0) return;
    remaining.splice(targetIndex, 0, ...dragged);
    if (remaining.length === current.length && remaining.every((symbol, index) => symbol === current[index])) return;
    await updateGroupSymbols(config, destination, remaining);
    await refresh();
  });
  const tree = vscode.window.createTreeView('aShareQuotes.watchlist', { treeDataProvider: provider, dragAndDropController });

  let timer: NodeJS.Timeout | undefined;
  const resetTimer = () => {
    if (timer) clearInterval(timer);
    const seconds = vscode.workspace.getConfiguration('aShareQuotes').get<number>('refreshInterval', 3);
    timer = setInterval(refresh, Math.max(3, seconds) * 1000);
  };

  const showStockPicker = (item?: unknown) => {
    const target = item instanceof GroupItem ? item : undefined;
    const targetGroup = target?.groupId ?? DEFAULT_GROUP_ID;
    const targetLabel = targetGroup === DEFAULT_GROUP_ID ? DEFAULT_GROUP_LABEL : targetGroup;
    const picker = vscode.window.createQuickPick<{ label: string; description: string; detail: string; symbol: string }>();
    picker.title = `添加到“${targetLabel}”`;
    picker.placeholder = `搜索股票/可转债名称或代码，选中后直接加入“${targetLabel}”`;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    let requestId = 0;
    let searchTimer: NodeJS.Timeout | undefined;
    picker.onDidChangeValue(value => {
      if (searchTimer) clearTimeout(searchTimer);
      const current = ++requestId;
      if (!value.trim()) { picker.items = []; picker.busy = false; return; }
      picker.busy = true;
      searchTimer = setTimeout(async () => {
        try {
          const results = await searchStocks(value);
          if (current !== requestId) return;
          picker.items = results.map(result => ({ label: result.name, description: result.code, detail: result.symbol.toUpperCase(), symbol: result.symbol }));
        } catch (error) {
          if (current === requestId) picker.items = [{ label: '搜索失败', description: error instanceof Error ? error.message : String(error), detail: '', symbol: '' }];
        } finally { if (current === requestId) picker.busy = false; }
      }, 250);
    });
    picker.onDidAccept(async () => {
      const selected = picker.selectedItems[0];
      const symbol = selected?.symbol;
      if (!symbol) return;
      picker.hide();
      const config = vscode.workspace.getConfiguration('aShareQuotes');
      const symbols = symbolsInGroup(config, targetGroup);
      if (!symbols.includes(symbol)) {
        await updateGroupSymbols(config, targetGroup, [...symbols, symbol]);
        await refresh();
        void vscode.window.showInformationMessage(`已将 ${selected.label} (${selected.description}) 添加到“${targetLabel}”`);
      } else {
        void vscode.window.showInformationMessage(`该证券已在“${targetLabel}”中`);
      }
    });
    picker.onDidHide(() => { if (searchTimer) clearTimeout(searchTimer); picker.dispose(); });
    picker.show();
  };

  const setStatusSymbols = async (symbols: string[]) => {
    const config = vscode.workspace.getConfiguration('aShareQuotes');
    await config.update('statusBarSymbols', uniqueSymbols(symbols).slice(0, MAX_STATUS_ITEMS), statusSymbolsTarget(config));
  };

  const manageStatusSymbols = async (item?: QuoteItem) => {
    const config = vscode.workspace.getConfiguration('aShareQuotes');
    const pinned = configuredStatusSymbols(config);
    const symbol = item?.quote.symbol;
    if (symbol) {
      const index = pinned.indexOf(symbol);
      if (index >= 0) {
        await setStatusSymbols(pinned.filter(value => value !== symbol));
        void vscode.window.showInformationMessage(`已取消固定 ${item.quote.name}`);
      } else if (pinned.length >= MAX_STATUS_ITEMS) {
        void vscode.window.showWarningMessage(`状态栏最多固定 ${MAX_STATUS_ITEMS} 个证券，请先取消一个`);
      } else {
        await setStatusSymbols([...pinned, symbol]);
        void vscode.window.showInformationMessage(`已固定 ${item.quote.name} 到状态栏`);
      }
      return;
    }

    const quotes = provider.getQuotes();
    const selected = await vscode.window.showQuickPick(
      quotes.map(quote => ({
        label: quote.name,
        description: quote.symbol.toUpperCase(),
        detail: pinned.includes(quote.symbol) ? '已固定' : undefined,
        symbol: quote.symbol,
        picked: pinned.includes(quote.symbol)
      })),
      { canPickMany: true, placeHolder: `选择要在状态栏固定的证券（最多 ${MAX_STATUS_ITEMS} 个）`, title: '管理状态栏行情' }
    );
    if (!selected) return;
    if (selected.length > MAX_STATUS_ITEMS) {
      void vscode.window.showWarningMessage(`状态栏最多固定 ${MAX_STATUS_ITEMS} 个证券`);
      return;
    }
    await setStatusSymbols(selected.map(value => value.symbol));
  };

  const createGroup = async (): Promise<string | undefined> => {
    const config = vscode.workspace.getConfiguration('aShareQuotes');
    const existing = configuredGroups(config);
    const name = await vscode.window.showInputBox({
      title: '新增自选分组',
      prompt: '输入分组名称',
      placeHolder: '例如：可转债、长线持有、重点观察',
      validateInput: value => {
        const trimmed = value.trim();
        if (!trimmed) return '分组名称不能为空';
        if (trimmed === DEFAULT_GROUP_LABEL || trimmed === DEFAULT_GROUP_ID) return `“${trimmed}”是保留分组名`;
        if (trimmed.length > 30) return '分组名称最多 30 个字符';
        if (trimmed in existing) return '该分组已存在';
        return undefined;
      }
    });
    const trimmed = name?.trim();
    if (!trimmed) return undefined;
    await config.update('groups', { ...existing, [trimmed]: [] }, groupsTarget(config));
    await refresh();
    void vscode.window.showInformationMessage(`已创建分组“${trimmed}”`);
    return trimmed;
  };

  const addStockToGroup = async (item?: QuoteItem) => {
    const symbol = item?.quote.symbol;
    if (!symbol || !item) return;
    let config = vscode.workspace.getConfiguration('aShareQuotes');
    let groups = configuredGroups(config);
    const choice = await vscode.window.showQuickPick([
      { label: '$(add) 新建分组…', groupId: '' },
      ...Object.keys(groups).map(name => ({
        label: name,
        description: groups[name].includes(symbol) ? '已在该分组中' : undefined,
        groupId: name
      }))
    ], { title: `将 ${item.quote.name} 添加到分组`, placeHolder: '选择目标分组' });
    if (!choice) return;
    const groupId = choice.groupId || await createGroup();
    if (!groupId) return;
    config = vscode.workspace.getConfiguration('aShareQuotes');
    groups = configuredGroups(config);
    const current = groups[groupId];
    if (!current) return;
    if (current.includes(symbol)) {
      void vscode.window.showInformationMessage(`${item.quote.name} 已在分组“${groupId}”中`);
      return;
    }
    await updateGroupSymbols(config, groupId, [...current, symbol]);
    await refresh();
    void vscode.window.showInformationMessage(`已将 ${item.quote.name} 添加到“${groupId}”`);
  };

  const deleteGroup = async (item?: GroupItem) => {
    if (!item || item.groupId === DEFAULT_GROUP_ID) return;
    const confirmed = await vscode.window.showWarningMessage(
      `删除分组“${item.groupId}”？“${DEFAULT_GROUP_LABEL}”中的证券不会被删除。`,
      { modal: true },
      '删除'
    );
    if (confirmed !== '删除') return;
    const config = vscode.workspace.getConfiguration('aShareQuotes');
    const groups = configuredGroups(config);
    delete groups[item.groupId];
    await config.update('groups', groups, groupsTarget(config));
    await refresh();
  };

  const sortGroup = async (item?: GroupItem) => {
    if (!item) return;
    const config = vscode.workspace.getConfiguration('aShareQuotes');
    const modes = configuredGroupSorts(config);
    if (item.sortMode === 'manual') modes[item.groupId] = 'changeDesc';
    else if (item.sortMode === 'changeDesc') modes[item.groupId] = 'changeAsc';
    else delete modes[item.groupId];
    await config.update('groupSorts', modes, groupSortsTarget(config));
    await refresh();
  };

  context.subscriptions.push(tree,
    vscode.commands.registerCommand('aShareQuotes.openStockDetail', (item?: QuoteItem | Quote) => {
      const quote = item instanceof QuoteItem ? item.quote : item;
      if (quote?.symbol) StockDetailPanel.show(context.extensionUri, quote);
    }),
    vscode.commands.registerCommand('aShareQuotes.refresh', refresh),
    vscode.commands.registerCommand('aShareQuotes.addStock', showStockPicker),
    vscode.commands.registerCommand('aShareQuotes.addGroup', createGroup),
    vscode.commands.registerCommand('aShareQuotes.addToGroup', addStockToGroup),
    vscode.commands.registerCommand('aShareQuotes.deleteGroup', deleteGroup),
    vscode.commands.registerCommand('aShareQuotes.sortGroup', sortGroup),
    vscode.commands.registerCommand('aShareQuotes.sortGroupManual', sortGroup),
    vscode.commands.registerCommand('aShareQuotes.sortGroupDesc', sortGroup),
    vscode.commands.registerCommand('aShareQuotes.sortGroupAsc', sortGroup),
    vscode.commands.registerCommand('aShareQuotes.removeStock', async (item?: QuoteItem) => {
      const symbol = item?.quote.symbol;
      if (!symbol || !item) return;
      const config = vscode.workspace.getConfiguration('aShareQuotes');
      await updateGroupSymbols(config, item.groupId, symbolsInGroup(config, item.groupId).filter(value => value !== symbol));
      const pinned = configuredStatusSymbols(config);
      const stillTracked = symbolsInGroup(config, DEFAULT_GROUP_ID).includes(symbol)
        || Object.values(configuredGroups(config)).some(symbols => symbols.includes(symbol));
      if (!stillTracked && pinned.includes(symbol)) await setStatusSymbols(pinned.filter(value => value !== symbol));
      await refresh();
    }),
    vscode.commands.registerCommand('aShareQuotes.moveUp', (item?: QuoteItem) => reorderStock(item, 'up')),
    vscode.commands.registerCommand('aShareQuotes.moveDown', (item?: QuoteItem) => reorderStock(item, 'down')),
    vscode.commands.registerCommand('aShareQuotes.moveTop', (item?: QuoteItem) => reorderStock(item, 'top')),
    vscode.commands.registerCommand('aShareQuotes.moveBottom', (item?: QuoteItem) => reorderStock(item, 'bottom')),
    vscode.commands.registerCommand('aShareQuotes.selectStatusStock', manageStatusSymbols),
    vscode.commands.registerCommand('aShareQuotes.unpinStatusStock', manageStatusSymbols),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('aShareQuotes')) { resetTimer(); void refresh(); }
    }),
    { dispose: () => { if (timer) clearInterval(timer); } }
  );
  resetTimer();
  void refresh();
}

export function deactivate(): void {}
