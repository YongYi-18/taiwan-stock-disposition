/* =====================================================
   台股處置預測 - 核心邏輯
   資料來源：FinMind API / TWSE 官方 API
   規則依據：TWSE「注意及處置作業要點」第四條、第六條
   ===================================================== */

'use strict';

// ── 版本 ──────────────────────────────────────────────
const VERSION = '2026-06-05.1';

// ── 常數 ──────────────────────────────────────────────
const FINMIND_API   = 'https://api.finmindtrade.com/api/v4/data';
const DATASET       = 'TaiwanStockPrice';
const MAX_WATCHLIST = 20;
const NOTICE_THRESHOLD = 0.32;  // 第四條第一款：6日累積漲跌幅門檻
const NOTICE_WINDOW    = 6;
const LIMIT_THRESHOLD  = 0.095; // 漲跌停判定：約 ±10%（考慮四捨五入取 9.5%）
const DISPOSE_CONSEC_A  = 3;    // 條件A：連續3日（第一款）
const DISPOSE_CONSEC_B1 = 5;    // 條件B1：連續5日
const DISPOSE_IN10      = 6;    // 條件B2：10日內6次
const DISPOSE_IN30      = 12;   // 條件B3：30日內12次
const MINUTES_FIRST  = 5;
const MINUTES_REPEAT = 20;

// ── 全局快取 ──────────────────────────────────────────
const CACHE = {
  stockMap:  null,  // Map: code → name（供顯示用）
  nameMap:   null,  // Map: normalized_name → code（供搜尋用）
  disposals: null,  // Map: code → { minutes, startDate, endDate }
};

// ── 狀態 ──────────────────────────────────────────────
let watchlist        = loadWatchlist();
let renderedCards    = {};
let disposalCacheReady = null;  // Promise，供 analyzeAndRender 等候

// ── 頁面初始化 ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('versionLabel').textContent = `v ${VERSION}`;
  renderWatchlistChips();

  document.getElementById('searchBtn').addEventListener('click', onSearch);
  document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') onSearch();
  });

  // 背景載入股票清單與處置清單
  loadStockCache().catch(() => {});
  disposalCacheReady = loadDisposalCache().catch(() => {});

  if (watchlist.length > 0) {
    watchlist.forEach(code => analyzeAndRender(code));
  }
});

// ══════════════════════════════════════════════════════
// 背景資料載入
// ══════════════════════════════════════════════════════

// 股票代號↔名稱對照（FinMind TaiwanStockInfo）
async function loadStockCache() {
  const resp = await fetch(`${FINMIND_API}?dataset=TaiwanStockInfo`);
  const json = await resp.json();
  if (!json.data) return;

  CACHE.stockMap = new Map();
  CACHE.nameMap  = new Map();
  for (const item of json.data) {
    const code = (item.stock_id || '').trim();
    const name = (item.stock_name || '').trim();
    if (!code) continue;
    CACHE.stockMap.set(code, name);
    if (name) CACHE.nameMap.set(normStr(name), code);
  }
}

// 處置清單由 GitHub Actions 每日自動更新至 data/disposal.json
// 前端直接讀同源檔案，避免 CORS 問題
async function loadDisposalCache() {
  CACHE.disposals = new Map();
  try {
    const resp = await fetch('./data/disposal.json');
    if (!resp.ok) return;
    const json = await resp.json();
    if (!json.stocks || typeof json.stocks !== 'object') return;
    for (const [code, info] of Object.entries(json.stocks)) {
      CACHE.disposals.set(code, {
        minutes:   info.minutes   || MINUTES_FIRST,
        startDate: info.startDate || '',
        endDate:   info.endDate   || '',
        note:      info.note      || '',
      });
    }
    console.log(`[處置清單] 已載入 ${CACHE.disposals.size} 支（更新：${json.updated ? json.updated.slice(0,16).replace('T',' ') : '未知'}）`);
  } catch (e) {
    console.warn('[處置清單] 載入失敗：', e?.message);
  }
}

// ══════════════════════════════════════════════════════
// 搜尋邏輯（支援代號 + 名稱）
// ══════════════════════════════════════════════════════

function resolveInput(raw) {
  const input = raw.trim();
  if (!input) return { code: null, error: '請輸入股票代號或名稱' };

  // 純數字 → 直接當代號
  if (/^\d{4,6}$/.test(input)) {
    return { code: input, foundName: CACHE.stockMap?.get(input) || '' };
  }

  // 名稱搜尋
  if (!CACHE.nameMap) {
    return { code: null, error: '股票名稱資料尚未載入，請稍後再試，或直接輸入代號' };
  }

  const q = normStr(input);

  // 1. 完全符合
  if (CACHE.nameMap.has(q)) {
    const code = CACHE.nameMap.get(q);
    return { code, foundName: CACHE.stockMap.get(code) || input };
  }

  // 2. 部分符合（名稱包含搜尋字）
  for (const [name, code] of CACHE.nameMap) {
    if (name.includes(q)) {
      return { code, foundName: CACHE.stockMap.get(code) || name };
    }
  }

  return { code: null, error: `找不到「${input}」，請確認名稱或改用代號查詢` };
}

async function onSearch() {
  const inputEl = document.getElementById('searchInput');
  const errEl   = document.getElementById('searchError');
  const raw = inputEl.value;

  if (!raw.trim()) return;

  const resolved = resolveInput(raw);
  if (!resolved.code) {
    showError(errEl, resolved.error);
    return;
  }

  errEl.classList.add('hidden');
  inputEl.value = '';

  const code = resolved.code.toUpperCase();
  if (renderedCards[code]) {
    renderedCards[code].scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  await analyzeAndRender(code);
}

// ══════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════

async function analyzeAndRender(code) {
  const container = document.getElementById('resultsContainer');
  const loadingEl = createLoadingCard(code);
  container.prepend(loadingEl);

  try {
    // 並行抓：價格資料 + 等候處置清單（disposal.json）
    const [prices] = await Promise.all([
      fetchPrices(code),
      disposalCacheReady,
    ]);

    if (!prices || prices.length < NOTICE_WINDOW) {
      throw new Error('資料不足，請確認股票代碼是否正確');
    }

    const result = computeDispositionRisk(prices);
    const disposalInfo = CACHE.disposals?.get(code) || null;

    const card = buildCard(code, result, disposalInfo);
    loadingEl.replaceWith(card);
    renderedCards[code] = card;
  } catch (err) {
    loadingEl.innerHTML = `<span style="color:#d93025">⚠ ${err.message}</span>`;
    setTimeout(() => loadingEl.remove(), 4000);
  }
}

// ── FinMind 價格資料 ──────────────────────────────────
async function fetchPrices(stockCode) {
  const endDate   = formatDate(new Date());
  const startDate = formatDate(daysAgo(60));  // 60 日確保 30+ 個交易日

  const url = `${FINMIND_API}?dataset=${DATASET}&data_id=${encodeURIComponent(stockCode)}&start_date=${startDate}&end_date=${endDate}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`API 連線失敗（HTTP ${resp.status}）`);

  const json = await resp.json();
  if (!json.data || json.data.length === 0) {
    throw new Error(`找不到「${stockCode}」的資料，請確認代碼正確`);
  }

  return json.data
    .map(d => ({
      date:   d.date,
      close:  parseFloat(d.close),
      open:   parseFloat(d.open),
      high:   parseFloat(d.max),
      low:    parseFloat(d.min),
      spread: parseFloat(d.spread),
      volume: parseInt(d.Trading_Volume, 10),
      name:   d.stock_name || '',
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ══════════════════════════════════════════════════════
// 核心計算
// ══════════════════════════════════════════════════════

function computeDispositionRisk(prices) {
  const n = prices.length;

  // 逐日標記注意日（兩個條件任一成立即算注意日）
  const noticeDays = prices.map((_, i) => isNoticeDay(prices, i));
  const limitDays  = prices.map((_, i) => isLimitHitDay(prices, i));

  // 連續注意天數（從最末日往回數）
  let consecutive = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (noticeDays[i]) consecutive++;
    else break;
  }

  const countIn10 = noticeDays.slice(-10).filter(Boolean).length;
  const countIn30 = noticeDays.slice(-30).filter(Boolean).length;
  const limitIn10 = limitDays.slice(-10).filter(Boolean).length;
  const limitIn30 = limitDays.slice(-30).filter(Boolean).length;

  // 各條件距觸發還需幾天
  const needA  = Math.max(0, DISPOSE_CONSEC_A  - consecutive);
  const needB1 = Math.max(0, DISPOSE_CONSEC_B1 - consecutive);
  const needB2 = Math.max(0, DISPOSE_IN10      - countIn10);
  const needB3 = Math.max(0, DISPOSE_IN30      - countIn30);

  const minDays        = Math.min(needA, needB1, needB2, needB3);
  const alreadyTriggered = minDays === 0;

  const pastDisposeTrigger = checkPastDisposalInWindow(noticeDays);
  const isRepeatDisposal   = pastDisposeTrigger && alreadyTriggered;
  const dispositionMinutes = isRepeatDisposal ? MINUTES_REPEAT : MINUTES_FIRST;

  // 今日 6 日累積漲跌幅
  const todayClose = prices[n - 1].close;
  const baseClose6 = n >= NOTICE_WINDOW ? prices[n - NOTICE_WINDOW].close : prices[0].close;
  const cum6       = (todayClose - baseClose6) / baseClose6;

  const threshold    = calcThresholdPrice(prices);
  const todayIsNotice = noticeDays[n - 1];
  const todayIsLimit  = limitDays[n - 1];
  const riskLevel    = getRiskLevel(consecutive, countIn10, minDays, alreadyTriggered);

  return {
    stockName: prices[n - 1].name || prices[0].name,
    latestDate: prices[n - 1].date,
    latestClose: todayClose,
    latestSpread: prices[n - 1].spread,
    cum6, baseClose6,
    consecutive, countIn10, countIn30,
    limitIn10, limitIn30,
    todayIsNotice, todayIsLimit,
    minDays, alreadyTriggered,
    dispositionMinutes, isRepeatDisposal, pastDisposeTrigger,
    threshold, riskLevel,
    needA, needB1, needB2, needB3,
  };
}

// ── 注意日判定 ────────────────────────────────────────
// 條件一：6日累積漲跌幅 ≥ ±32%（第四條第一款）
function isCum32Day(prices, index) {
  if (index < NOTICE_WINDOW - 1) return false;
  const baseClose = prices[index - (NOTICE_WINDOW - 1)].close;
  const todayClose = prices[index].close;
  if (baseClose <= 0) return false;
  return Math.abs((todayClose - baseClose) / baseClose) >= NOTICE_THRESHOLD;
}

// 條件二：當日觸及漲跌停板（±10%，以 spread/prevClose 判斷）
function isLimitHitDay(prices, index) {
  const d = prices[index];
  if (d.spread === 0 || isNaN(d.spread)) return false;
  const prevClose = d.close - d.spread;
  if (prevClose <= 0) return false;
  return Math.abs(d.spread / prevClose) >= LIMIT_THRESHOLD;
}

// 兩個條件取 OR
function isNoticeDay(prices, index) {
  return isCum32Day(prices, index) || isLimitHitDay(prices, index);
}

// ── 過去30日是否曾觸發處置條件 ───────────────────────
function checkPastDisposalInWindow(noticeDays) {
  const past = noticeDays.slice(0, -1).slice(-30);
  let prevConsec = 0, maxConsec = 0;
  for (const d of past) {
    if (d) { prevConsec++; maxConsec = Math.max(maxConsec, prevConsec); }
    else prevConsec = 0;
  }
  const pastCount10 = past.slice(-10).filter(Boolean).length;
  return maxConsec >= DISPOSE_CONSEC_A || pastCount10 >= DISPOSE_IN10;
}

// ── 今日觸發注意的門檻收盤價 ─────────────────────────
function calcThresholdPrice(prices) {
  const n = prices.length;
  if (n < NOTICE_WINDOW) return { upper: null, lower: null, alreadyUp: false, alreadyDown: false };
  const baseClose  = prices[n - NOTICE_WINDOW].close;
  const upper      = roundTick(baseClose * (1 + NOTICE_THRESHOLD));
  const lower      = roundTick(baseClose * (1 - NOTICE_THRESHOLD));
  const todayClose = prices[n - 1].close;
  return { upper, lower, alreadyUp: todayClose >= upper, alreadyDown: todayClose <= lower };
}

// ── 升降單位四捨五入 ──────────────────────────────────
function roundTick(price) {
  const tick = price < 10 ? 0.01 : price < 50 ? 0.05 : price < 100 ? 0.10
             : price < 500 ? 0.50 : price < 1000 ? 1.00 : 5.00;
  return Math.round(price / tick) * tick;
}

// ── 風險等級 ──────────────────────────────────────────
function getRiskLevel(consecutive, countIn10, minDays, alreadyTriggered) {
  if (alreadyTriggered)                  return 'critical';
  if (minDays === 1 || consecutive >= 2) return 'high';
  if (minDays <= 3  || countIn10 >= 3)  return 'mid';
  return 'low';
}

// ══════════════════════════════════════════════════════
// 建構股票卡片 DOM
// ══════════════════════════════════════════════════════

function buildCard(code, r, disposalInfo) {
  const tpl  = document.getElementById('stockCardTemplate');
  const frag = tpl.content.cloneNode(true);
  const card = frag.querySelector('.stock-card');

  const isOfficiallyDisposed = !!disposalInfo;
  const displayMinutes = isOfficiallyDisposed ? disposalInfo.minutes : r.dispositionMinutes;

  // 邊框顏色
  const riskClass = isOfficiallyDisposed ? 'risk-critical' :
    { low: 'risk-low', mid: 'risk-mid', high: 'risk-high', critical: 'risk-critical' }[r.riskLevel];
  card.classList.add(riskClass);

  // ── 處置中 Banner（官方來源） ──────────────────────
  if (isOfficiallyDisposed) {
    const banner = document.createElement('div');
    banner.className = 'disposal-banner';
    let periodHtml = '';
    if (disposalInfo.startDate || disposalInfo.endDate) {
      const start = disposalInfo.startDate ? formatROCDate(disposalInfo.startDate) : '—';
      const end   = disposalInfo.endDate   ? formatROCDate(disposalInfo.endDate)   : '—';
      periodHtml = `<div class="disposal-row"><span class="disposal-label">處置期間</span><span class="disposal-val">${start}～${end}</span></div>`;
    }
    banner.innerHTML = `
      <div class="disposal-row"><span class="disposal-label">狀態</span><span class="disposal-val disposal-status">🔴 處置中</span></div>
      <div class="disposal-row"><span class="disposal-label">撮合週期</span><span class="disposal-val">${displayMinutes} 分鐘</span></div>
      ${periodHtml}
    `;
    card.insertBefore(banner, card.firstChild);
  }

  // ── 股票標題 ───────────────────────────────────────
  card.querySelector('.stock-code').textContent = code;
  // 名稱優先從快取取（FinMind TaiwanStockInfo），若快取未載入則用價格資料附帶的名稱
  card.querySelector('.stock-name').textContent = CACHE.stockMap?.get(code) || r.stockName || '';

  // ── 價格 ───────────────────────────────────────────
  card.querySelector('.price-value').textContent = `$${r.latestClose.toFixed(2)}`;

  const changeEl = card.querySelector('.price-change');
  const prevClose  = r.latestClose - r.latestSpread;
  const spreadPct  = prevClose > 0 ? (r.latestSpread / prevClose) * 100 : 0;
  const sign = r.latestSpread >= 0 ? '+' : '';
  changeEl.textContent = `${sign}${r.latestSpread.toFixed(2)} (${sign}${spreadPct.toFixed(2)}%)`;
  changeEl.className   = 'price-change ' + (r.latestSpread > 0 ? 'up' : r.latestSpread < 0 ? 'down' : 'flat');

  // 漲跌停標籤
  if (r.todayIsLimit) {
    const tag = document.createElement('span');
    tag.className   = 'limit-tag ' + (r.latestSpread > 0 ? 'limit-up' : 'limit-down');
    tag.textContent = r.latestSpread > 0 ? '漲停' : '跌停';
    changeEl.after(tag);
  }

  card.querySelector('.price-date').textContent = r.latestDate;

  // ── 風險標籤 ───────────────────────────────────────
  const badgeMap = { low:'🟢', mid:'🟡', high:'🟠', critical:'🔴' };
  const labelMap = {
    low: '處置風險：低', mid: '處置風險：中',
    high: '處置風險：高', critical: '⚠ 已達處置觸發條件',
  };
  card.querySelector('.risk-badge').textContent = isOfficiallyDisposed ? '🔴' : badgeMap[r.riskLevel];
  const riskLabelEl = card.querySelector('.risk-label');
  riskLabelEl.textContent = isOfficiallyDisposed
    ? `官方處置中（每 ${displayMinutes} 分鐘）`
    : labelMap[r.riskLevel];
  riskLabelEl.className = `risk-label risk-critical`;

  // ── 指標格線 ───────────────────────────────────────
  // 6日累積幅度 + 進度條
  const cum6Pct = (r.cum6 * 100).toFixed(1);
  const cum6El  = card.querySelector('[data-key="cum6"]');
  cum6El.textContent = `${r.cum6 >= 0 ? '+' : ''}${cum6Pct}%`;
  cum6El.className   = `metric-value ${Math.abs(r.cum6) >= NOTICE_THRESHOLD ? 'alert' : Math.abs(r.cum6) >= 0.2 ? 'warn' : 'ok'}`;

  const pct = Math.min(100, Math.abs(r.cum6) / NOTICE_THRESHOLD * 100);
  const barWrap = document.createElement('div'); barWrap.className = 'progress-bar-wrap';
  const barFill = document.createElement('div');
  barFill.className = `progress-bar-fill ${r.cum6 >= 0 ? 'up' : 'down'}`;
  barFill.style.width = `${pct}%`;
  barWrap.appendChild(barFill);
  cum6El.parentElement.appendChild(barWrap);

  // 距32%門檻
  const gap   = NOTICE_THRESHOLD - Math.abs(r.cum6);
  const gapEl = card.querySelector('[data-key="gap32"]');
  if (gap <= 0) {
    gapEl.textContent = '已超過門檻'; gapEl.className = 'metric-value alert';
  } else {
    gapEl.textContent = `還差 ${(gap * 100).toFixed(1)}%`;
    gapEl.className   = `metric-value ${gap < 0.1 ? 'warn' : 'ok'}`;
  }

  // 連續注意天數
  const consecEl = card.querySelector('[data-key="consecutive"]');
  consecEl.textContent = `${r.consecutive} 天`;
  consecEl.className   = `metric-value ${r.consecutive >= 2 ? 'alert' : r.consecutive >= 1 ? 'warn' : 'ok'}`;

  // 10日內注意次數（附漲跌停次數）
  const c10El = card.querySelector('[data-key="count10"]');
  c10El.textContent = `${r.countIn10} / ${DISPOSE_IN10}`;
  c10El.className   = `metric-value ${r.countIn10 >= DISPOSE_IN10 ? 'alert' : r.countIn10 >= 4 ? 'warn' : 'ok'}`;
  if (r.limitIn10 > 0) {
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:#5f6368;margin-top:2px;';
    sub.textContent   = `其中漲跌停 ${r.limitIn10} 次`;
    c10El.parentElement.appendChild(sub);
  }

  // 30日內注意次數
  const c30El = card.querySelector('[data-key="count30"]');
  c30El.textContent = `${r.countIn30} / ${DISPOSE_IN30}`;
  c30El.className   = `metric-value ${r.countIn30 >= DISPOSE_IN30 ? 'alert' : r.countIn30 >= 8 ? 'warn' : 'ok'}`;
  if (r.limitIn30 > 0) {
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:#5f6368;margin-top:2px;';
    sub.textContent   = `其中漲跌停 ${r.limitIn30} 次`;
    c30El.parentElement.appendChild(sub);
  }

  // 過去處置紀錄
  const prevEl = card.querySelector('[data-key="prevDispose"]');
  prevEl.textContent = r.pastDisposeTrigger ? '有（可能加重處置）' : '無（預計第一次）';
  prevEl.className   = `metric-value ${r.pastDisposeTrigger ? 'warn' : 'ok'}`;

  // ── 處置風險提示框 ─────────────────────────────────
  const disposeBox    = card.querySelector('.disposition-box');
  const disposeDetail = card.querySelector('[data-key="disposeDetail"]');

  if (r.alreadyTriggered && !isOfficiallyDisposed) {
    disposeBox.classList.remove('hidden');
    disposeDetail.innerHTML = `
      預測已達處置觸發條件，預計<strong>明日起</strong>進入處置。<br>
      預計每 <strong>${r.dispositionMinutes} 分鐘</strong>集合競價，持續 10 個營業日。
      ${r.isRepeatDisposal ? '<br>（近期已有處置紀錄，可能為<strong>加重處置 20 分鐘</strong>）' : ''}
    `;
  } else if (!isOfficiallyDisposed && r.minDays >= 1 && r.minDays <= 3) {
    disposeBox.classList.remove('hidden');
    disposeBox.style.background   = '#fef3e2';
    disposeBox.style.borderColor  = '#fbbc04';
    disposeBox.querySelector('.disposition-title').style.color    = '#b06000';
    disposeBox.querySelector('.disposition-title').textContent    = '⚡ 處置預警';
    disposeDetail.style.color = '#5a3000';
    disposeDetail.innerHTML = `
      最快 <strong>${r.minDays} 個交易日後</strong>可能進入處置
      （假設後續每日持續觸發注意條件）。<br>
      屆時每 <strong>${r.dispositionMinutes} 分鐘</strong>集合競價一次。
    `;
  }

  // ── 門檻價格 ───────────────────────────────────────
  const { upper, lower, alreadyUp, alreadyDown } = r.threshold;
  const upEl   = card.querySelector('[data-key="threshUpper"]');
  const downEl = card.querySelector('[data-key="threshLower"]');
  if (upper) {
    upEl.textContent = alreadyUp ? `$${upper.toFixed(2)} ✓ 今日已達` : `≥ $${upper.toFixed(2)}`;
    if (alreadyUp) upEl.classList.add('triggered');
  } else { upEl.textContent = '資料不足'; }
  if (lower) {
    downEl.textContent = alreadyDown ? `$${lower.toFixed(2)} ✓ 今日已達` : `≤ $${lower.toFixed(2)}`;
    if (alreadyDown) downEl.classList.add('triggered');
  } else { downEl.textContent = '資料不足'; }

  // ── 底部 ───────────────────────────────────────────
  card.querySelector('.data-time').textContent = `資料截至 ${r.latestDate}（收盤後更新）`;
  card.querySelector('.twse-link').href = 'https://www.twse.com.tw/zh/announcement/punish.html';

  // ── 追蹤按鈕 ───────────────────────────────────────
  const btnWatch = card.querySelector('.btn-watchlist');
  const isWatching = watchlist.includes(code);
  btnWatch.textContent = isWatching ? '★ 已追蹤' : '☆ 追蹤';
  if (isWatching) btnWatch.classList.add('is-watching');
  btnWatch.addEventListener('click', () => {
    if (watchlist.includes(code)) {
      watchlist = watchlist.filter(c => c !== code);
      btnWatch.textContent = '☆ 追蹤';
      btnWatch.classList.remove('is-watching');
    } else {
      if (watchlist.length >= MAX_WATCHLIST) { alert(`自選股最多 ${MAX_WATCHLIST} 支`); return; }
      watchlist.push(code);
      btnWatch.textContent = '★ 已追蹤';
      btnWatch.classList.add('is-watching');
    }
    saveWatchlist();
    renderWatchlistChips();
  });

  // ── 關閉按鈕 ───────────────────────────────────────
  card.querySelector('.btn-remove-card').addEventListener('click', () => {
    card.remove();
    delete renderedCards[code];
  });

  return card;
}

// ══════════════════════════════════════════════════════
// 自選股 Chip
// ══════════════════════════════════════════════════════

function renderWatchlistChips() {
  const container = document.getElementById('watchlistChips');
  document.getElementById('watchlistCount').textContent = `${watchlist.length} / ${MAX_WATCHLIST}`;
  container.innerHTML = '';

  if (watchlist.length === 0) {
    container.innerHTML = '<span class="watchlist-empty">尚無自選股，查詢後點「追蹤」即可加入</span>';
    return;
  }

  watchlist.forEach(code => {
    const isDisposed = CACHE.disposals?.has(code);
    const chip = document.createElement('button');
    chip.className = 'chip' + (isDisposed ? ' chip-disposed' : '');
    chip.innerHTML = `${isDisposed ? '🔴 ' : ''}${code} <span class="chip-remove">✕</span>`;

    chip.addEventListener('click', e => {
      if (e.target.classList.contains('chip-remove')) {
        watchlist = watchlist.filter(c => c !== code);
        saveWatchlist();
        renderWatchlistChips();
        if (renderedCards[code]) {
          const btn = renderedCards[code].querySelector('.btn-watchlist');
          if (btn) { btn.textContent = '☆ 追蹤'; btn.classList.remove('is-watching'); }
        }
      } else {
        if (renderedCards[code]) {
          renderedCards[code].scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          analyzeAndRender(code);
        }
      }
    });
    container.appendChild(chip);
  });
}

// ══════════════════════════════════════════════════════
// 工具函式
// ══════════════════════════════════════════════════════

function createLoadingCard(code) {
  const el = document.createElement('div');
  el.className = 'loading-card';
  el.innerHTML = `<span class="spinner"></span>正在分析 ${code}...`;
  return el;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function normStr(s) {
  return s.replace(/[\s　]/g, '').toLowerCase();
}

// disposal.json 的日期已由 fetch-disposal.js 統一為 YYY/MM/DD 格式
function formatROCDate(dateStr) {
  if (!dateStr) return '';
  let year, month, day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    [year, month, day] = dateStr.split('-').map(Number);
  } else if (/^\d{3}[\/\-]\d{2}[\/\-]\d{2}$/.test(dateStr)) {
    const parts = dateStr.split(/[\/\-]/);
    year = parseInt(parts[0]) + 1911;
    month = parseInt(parts[1]);
    day = parseInt(parts[2]);
  } else {
    return dateStr;
  }
  const rocYear  = year - 1911;
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekDay  = weekDays[new Date(year, month - 1, day).getDay()];
  return `${rocYear}/${String(month).padStart(2,'0')}/${String(day).padStart(2,'0')}(${weekDay})`;
}

function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem('twse_watchlist') || '[]'); }
  catch { return []; }
}

function saveWatchlist() {
  localStorage.setItem('twse_watchlist', JSON.stringify(watchlist));
}
