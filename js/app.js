/* =====================================================
   台股處置預測 - 核心邏輯
   資料來源：FinMind API (https://api.finmindtrade.com)
   規則依據：TWSE「注意及處置作業要點」第四條、第六條
   ===================================================== */

'use strict';

// ── 常數 ──────────────────────────────────────────────
const FINMIND_API = 'https://api.finmindtrade.com/api/v4/data';
const DATASET = 'TaiwanStockPrice';
const MAX_WATCHLIST = 20;
const NOTICE_THRESHOLD = 0.32;   // 第四條第一款：6日累積漲跌幅門檻
const NOTICE_WINDOW = 6;          // 計算窗口（含當日）
const DISPOSE_CONSEC_A = 3;       // 條件A：連續注意日數（第一款）
const DISPOSE_CONSEC_B1 = 5;      // 條件B1：連續注意日數（第一至八款）
const DISPOSE_IN10 = 6;           // 條件B2：10日內注意次數
const DISPOSE_IN30 = 12;          // 條件B3：30日內注意次數
const MINUTES_FIRST = 5;          // 第一次處置：每N分鐘集合競價
const MINUTES_REPEAT = 20;        // 第二次以上：每N分鐘集合競價

// ── 狀態 ──────────────────────────────────────────────
let watchlist = loadWatchlist();
let renderedCards = {};  // stockCode → DOM element

// ── 頁面初始化 ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderWatchlistChips();

  document.getElementById('searchBtn').addEventListener('click', onSearch);
  document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') onSearch();
  });

  // 自動載入自選股
  if (watchlist.length > 0) {
    watchlist.forEach(code => analyzeAndRender(code));
  }
});

// ── 搜尋觸發 ─────────────────────────────────────────
async function onSearch() {
  const input = document.getElementById('searchInput');
  const code = input.value.trim().toUpperCase();
  const errEl = document.getElementById('searchError');

  if (!code) return;

  if (!/^\d{4,6}$/.test(code)) {
    showError(errEl, '請輸入 4–6 位數字的股票代碼，如 2330');
    return;
  }

  errEl.classList.add('hidden');
  input.value = '';

  // 若已有此卡片，滾動到該卡片
  if (renderedCards[code]) {
    renderedCards[code].scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  await analyzeAndRender(code);
}

// ── 主流程：抓資料 → 計算 → 渲染 ────────────────────
async function analyzeAndRender(code) {
  const container = document.getElementById('resultsContainer');

  // 顯示載入卡片
  const loadingEl = createLoadingCard(code);
  container.prepend(loadingEl);

  try {
    const prices = await fetchPrices(code);

    if (!prices || prices.length < NOTICE_WINDOW) {
      throw new Error('資料不足，請確認股票代碼是否正確');
    }

    const result = computeDispositionRisk(prices);
    const card = buildCard(code, result);
    loadingEl.replaceWith(card);
    renderedCards[code] = card;

  } catch (err) {
    loadingEl.innerHTML = `<span style="color:#d93025">⚠ ${err.message}</span>`;
    setTimeout(() => loadingEl.remove(), 4000);
  }
}

// ── FinMind API 呼叫 ──────────────────────────────────
async function fetchPrices(stockCode) {
  // 取最近 55 個自然日（確保拿到 35+ 個交易日）
  const endDate = formatDate(new Date());
  const startDate = formatDate(daysAgo(55));

  const url = `${FINMIND_API}?dataset=${DATASET}&data_id=${encodeURIComponent(stockCode)}&start_date=${startDate}&end_date=${endDate}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`API 連線失敗（HTTP ${resp.status}）`);

  const json = await resp.json();

  if (!json.data || json.data.length === 0) {
    throw new Error(`找不到代碼「${stockCode}」的資料，請確認代碼正確`);
  }

  // 依日期正序排列
  return json.data
    .map(d => ({
      date: d.date,
      close: parseFloat(d.close),
      open: parseFloat(d.open),
      high: parseFloat(d.max),
      low: parseFloat(d.min),
      spread: parseFloat(d.spread),
      volume: parseInt(d.Trading_Volume, 10),
      name: d.stock_name || ''
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── 核心計算 ──────────────────────────────────────────
function computeDispositionRisk(prices) {
  const n = prices.length;

  // 1. 逐日標記是否為注意日（第一款：6日累積漲跌幅 > ±32%）
  const noticeDays = prices.map((_, i) => isNoticeDay(prices, i));

  // 2. 統計連續注意天數（從最末日往前數）
  let consecutive = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (noticeDays[i]) consecutive++;
    else break;
  }

  // 3. 最近 10 / 30 個交易日內的注意天數
  const last10 = noticeDays.slice(-10);
  const last30 = noticeDays.slice(-30);
  const countIn10 = last10.filter(Boolean).length;
  const countIn30 = last30.filter(Boolean).length;

  // 4. 各條件尚需的注意日數（假設後續每天都觸發注意）
  const needA  = Math.max(0, DISPOSE_CONSEC_A  - consecutive);  // 連續3日（第一款）
  const needB1 = Math.max(0, DISPOSE_CONSEC_B1 - consecutive);  // 連續5日
  const needB2 = Math.max(0, DISPOSE_IN10      - countIn10);    // 10日內6次
  const needB3 = Math.max(0, DISPOSE_IN30      - countIn30);    // 30日內12次

  const minDays = Math.min(needA, needB1, needB2, needB3);
  const alreadyTriggered = minDays === 0;

  // 5. 本次若進入處置，是第幾次？（近30日曾有處置紀錄視為第二次）
  //    簡化：若 countIn30 > 0（過去已有注意紀錄）且不是第一次 → 第二次
  //    完整判斷需 TWSE 歷史處置清單，這裡以「過去30日是否曾達處置條件」估算
  const pastDisposeTrigger = checkPastDisposalInWindow(noticeDays);
  const isRepeatDisposal = pastDisposeTrigger && alreadyTriggered;
  const dispositionMinutes = isRepeatDisposal ? MINUTES_REPEAT : MINUTES_FIRST;

  // 6. 今日 6日窗口的累積漲跌幅
  const todayClose = prices[n - 1].close;
  const baseClose6 = n >= NOTICE_WINDOW ? prices[n - NOTICE_WINDOW].close : prices[0].close;
  const cum6 = (todayClose - baseClose6) / baseClose6;

  // 7. 今日觸發注意的門檻收盤價
  const threshold = calcThresholdPrice(prices);

  // 8. 是否今日已達注意（最新一天）
  const todayIsNotice = noticeDays[n - 1];

  // 9. 風險等級
  const riskLevel = getRiskLevel(consecutive, countIn10, minDays, alreadyTriggered);

  return {
    stockName: prices[0].name,
    latestDate: prices[n - 1].date,
    latestClose: todayClose,
    latestSpread: prices[n - 1].spread,
    cum6,
    baseClose6,
    consecutive,
    countIn10,
    countIn30,
    noticeDays,
    todayIsNotice,
    minDays,
    alreadyTriggered,
    dispositionMinutes,
    isRepeatDisposal,
    pastDisposeTrigger,
    threshold,
    riskLevel,
    needA, needB1, needB2, needB3
  };
}

// ── 注意日判定（第四條第一款簡化版） ─────────────────
function isNoticeDay(prices, index) {
  if (index < NOTICE_WINDOW - 1) return false;
  const baseClose = prices[index - (NOTICE_WINDOW - 1)].close;
  const todayClose = prices[index].close;
  if (baseClose <= 0) return false;
  const change = (todayClose - baseClose) / baseClose;
  return Math.abs(change) >= NOTICE_THRESHOLD;
}

// ── 判斷過去30日是否曾觸發處置條件（簡化） ──────────
function checkPastDisposalInWindow(noticeDays) {
  // 取最後31天（去掉最後一天），看過去是否曾達條件A或B2
  const past = noticeDays.slice(0, -1);
  const pastLast30 = past.slice(-30);

  let prevConsec = 0;
  let maxConsec = 0;
  for (const d of pastLast30) {
    if (d) { prevConsec++; maxConsec = Math.max(maxConsec, prevConsec); }
    else prevConsec = 0;
  }

  const pastCount10 = pastLast30.slice(-10).filter(Boolean).length;
  return maxConsec >= DISPOSE_CONSEC_A || pastCount10 >= DISPOSE_IN10;
}

// ── 今日門檻收盤價計算 ────────────────────────────────
function calcThresholdPrice(prices) {
  const n = prices.length;
  // 6日窗口的基準：5個交易日前的收盤（index = n-6）
  if (n < NOTICE_WINDOW) {
    return { upper: null, lower: null, alreadyUp: false, alreadyDown: false };
  }

  const baseClose = prices[n - NOTICE_WINDOW].close;
  const upper = roundTick(baseClose * (1 + NOTICE_THRESHOLD));
  const lower = roundTick(baseClose * (1 - NOTICE_THRESHOLD));
  const todayClose = prices[n - 1].close;

  return {
    upper,
    lower,
    alreadyUp:   todayClose >= upper,
    alreadyDown: todayClose <= lower
  };
}

// ── 漲跌幅升降單位四捨五入 ───────────────────────────
function roundTick(price) {
  let tick;
  if      (price < 10)    tick = 0.01;
  else if (price < 50)    tick = 0.05;
  else if (price < 100)   tick = 0.10;
  else if (price < 500)   tick = 0.50;
  else if (price < 1000)  tick = 1.00;
  else                    tick = 5.00;
  return Math.round(price / tick) * tick;
}

// ── 風險等級 ──────────────────────────────────────────
function getRiskLevel(consecutive, countIn10, minDays, alreadyTriggered) {
  if (alreadyTriggered) return 'critical';
  if (minDays === 1 || consecutive >= 2) return 'high';
  if (minDays <= 3 || countIn10 >= 3)   return 'mid';
  return 'low';
}

// ── 建構股票卡片 DOM ─────────────────────────────────
function buildCard(code, r) {
  const tpl = document.getElementById('stockCardTemplate');
  const frag = tpl.content.cloneNode(true);
  const card = frag.querySelector('.stock-card');

  // 風險樣式
  const riskClass = {
    low: 'risk-low', mid: 'risk-mid',
    high: 'risk-high', critical: 'risk-critical'
  }[r.riskLevel];
  card.classList.add(riskClass);

  // 股票資訊
  card.querySelector('.stock-code').textContent = code;
  card.querySelector('.stock-name').textContent = r.stockName || '';

  // 價格
  const priceEl = card.querySelector('.price-value');
  priceEl.textContent = `$${r.latestClose.toFixed(2)}`;

  const changeEl = card.querySelector('.price-change');
  const spreadPct = r.latestClose > 0 ? (r.latestSpread / (r.latestClose - r.latestSpread)) * 100 : 0;
  const sign = r.latestSpread >= 0 ? '+' : '';
  changeEl.textContent = `${sign}${r.latestSpread.toFixed(2)} (${sign}${spreadPct.toFixed(2)}%)`;
  changeEl.className = 'price-change ' + (r.latestSpread > 0 ? 'up' : r.latestSpread < 0 ? 'down' : 'flat');

  card.querySelector('.price-date').textContent = r.latestDate;

  // 風險標籤
  const badgeMap = {
    low: '🟢', mid: '🟡', high: '🟠', critical: '🔴'
  };
  const labelMap = {
    low: '處置風險：低',
    mid: '處置風險：中',
    high: '處置風險：高',
    critical: '⚠ 已達處置觸發條件'
  };
  card.querySelector('.risk-badge').textContent = badgeMap[r.riskLevel];
  const riskLabelEl = card.querySelector('.risk-label');
  riskLabelEl.textContent = labelMap[r.riskLevel];
  riskLabelEl.className = `risk-label ${riskClass}`;

  // 指標數值
  const cum6Pct = (r.cum6 * 100).toFixed(1);
  const cum6El = card.querySelector('[data-key="cum6"]');
  cum6El.textContent = `${r.cum6 >= 0 ? '+' : ''}${cum6Pct}%`;
  cum6El.className = `metric-value ${Math.abs(r.cum6) >= NOTICE_THRESHOLD ? 'alert' : Math.abs(r.cum6) >= 0.2 ? 'warn' : 'ok'}`;

  // 進度條
  const pct = Math.min(100, Math.abs(r.cum6) / NOTICE_THRESHOLD * 100);
  const barWrap = document.createElement('div');
  barWrap.className = 'progress-bar-wrap';
  const barFill = document.createElement('div');
  barFill.className = `progress-bar-fill ${r.cum6 >= 0 ? 'up' : 'down'}`;
  barFill.style.width = `${pct}%`;
  barWrap.appendChild(barFill);
  cum6El.parentElement.appendChild(barWrap);

  const gap = NOTICE_THRESHOLD - Math.abs(r.cum6);
  const gapEl = card.querySelector('[data-key="gap32"]');
  if (gap <= 0) {
    gapEl.textContent = '已超過門檻';
    gapEl.className = 'metric-value alert';
  } else {
    gapEl.textContent = `還差 ${(gap * 100).toFixed(1)}%`;
    gapEl.className = `metric-value ${gap < 0.1 ? 'warn' : 'ok'}`;
  }

  const consecEl = card.querySelector('[data-key="consecutive"]');
  consecEl.textContent = `${r.consecutive} 天`;
  consecEl.className = `metric-value ${r.consecutive >= 2 ? 'alert' : r.consecutive >= 1 ? 'warn' : 'ok'}`;

  const c10El = card.querySelector('[data-key="count10"]');
  c10El.textContent = `${r.countIn10} / ${DISPOSE_IN10}`;
  c10El.className = `metric-value ${r.countIn10 >= DISPOSE_IN10 ? 'alert' : r.countIn10 >= 4 ? 'warn' : 'ok'}`;

  const c30El = card.querySelector('[data-key="count30"]');
  c30El.textContent = `${r.countIn30} / ${DISPOSE_IN30}`;
  c30El.className = `metric-value ${r.countIn30 >= DISPOSE_IN30 ? 'alert' : r.countIn30 >= 8 ? 'warn' : 'ok'}`;

  const prevEl = card.querySelector('[data-key="prevDispose"]');
  prevEl.textContent = r.pastDisposeTrigger ? '有（估計第二次）' : '無（估計第一次）';
  prevEl.className = `metric-value ${r.pastDisposeTrigger ? 'warn' : 'ok'}`;

  // 處置風險提示框
  const disposeBox = card.querySelector('.disposition-box');
  const disposeDetail = card.querySelector('[data-key="disposeDetail"]');
  if (r.alreadyTriggered) {
    disposeBox.classList.remove('hidden');
    disposeDetail.innerHTML = `
      已達處置觸發條件，預計<strong>明日起</strong>進入處置。<br>
      處置期間每 <strong>${r.dispositionMinutes} 分鐘</strong>集合競價一次，持續 10 個營業日。
      ${r.isRepeatDisposal ? '<br>（本次為<strong>重複／加重處置</strong>，每20分鐘競價）' : ''}
    `;
  } else if (r.minDays <= 3) {
    disposeBox.classList.remove('hidden');
    disposeBox.style.background = '#fef3e2';
    disposeBox.style.borderColor = '#fbbc04';
    const dt = disposeBox.querySelector('.disposition-title');
    dt.style.color = '#b06000';
    dt.textContent = '⚡ 處置預警';
    disposeDetail.style.color = '#5a3000';
    disposeDetail.innerHTML = `
      最快 <strong>${r.minDays} 個交易日後</strong>可能進入處置（若後續每日持續觸發注意條件）。<br>
      屆時每 <strong>${r.dispositionMinutes} 分鐘</strong>集合競價一次。
    `;
  }

  // 門檻價格
  const { upper, lower, alreadyUp, alreadyDown } = r.threshold;
  const upEl = card.querySelector('[data-key="threshUpper"]');
  const downEl = card.querySelector('[data-key="threshLower"]');

  if (upper) {
    upEl.textContent = alreadyUp ? `$${upper.toFixed(2)} ✓ 今日已達` : `≥ $${upper.toFixed(2)}`;
    if (alreadyUp) upEl.classList.add('triggered');
  } else {
    upEl.textContent = '資料不足';
  }

  if (lower) {
    downEl.textContent = alreadyDown ? `$${lower.toFixed(2)} ✓ 今日已達` : `≤ $${lower.toFixed(2)}`;
    if (alreadyDown) downEl.classList.add('triggered');
  } else {
    downEl.textContent = '資料不足';
  }

  // 底部資訊
  card.querySelector('.data-time').textContent = `資料截至 ${r.latestDate}（收盤後更新）`;
  card.querySelector('.twse-link').href =
    `https://www.twse.com.tw/zh/announcement/notice.html`;

  // 加入/移除自選股按鈕
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
      if (watchlist.length >= MAX_WATCHLIST) {
        alert(`自選股最多 ${MAX_WATCHLIST} 支`);
        return;
      }
      watchlist.push(code);
      btnWatch.textContent = '★ 已追蹤';
      btnWatch.classList.add('is-watching');
    }
    saveWatchlist();
    renderWatchlistChips();
  });

  // 關閉按鈕
  card.querySelector('.btn-remove-card').addEventListener('click', () => {
    card.remove();
    delete renderedCards[code];
  });

  return card;
}

// ── 自選股 Chip 渲染 ──────────────────────────────────
function renderWatchlistChips() {
  const container = document.getElementById('watchlistChips');
  document.getElementById('watchlistCount').textContent = `${watchlist.length} / ${MAX_WATCHLIST}`;
  container.innerHTML = '';

  if (watchlist.length === 0) {
    container.innerHTML = '<span class="watchlist-empty">尚無自選股，查詢後點「追蹤」即可加入</span>';
    return;
  }

  watchlist.forEach(code => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.innerHTML = `${code} <span class="chip-remove">✕</span>`;

    // 點擊代碼部分 → 查詢
    chip.addEventListener('click', e => {
      if (e.target.classList.contains('chip-remove')) {
        // 移除自選股
        watchlist = watchlist.filter(c => c !== code);
        saveWatchlist();
        renderWatchlistChips();
        // 同步更新已渲染卡片的按鈕
        if (renderedCards[code]) {
          const btn = renderedCards[code].querySelector('.btn-watchlist');
          if (btn) {
            btn.textContent = '☆ 追蹤';
            btn.classList.remove('is-watching');
          }
        }
      } else {
        // 切換到該股票卡片或重新查詢
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

// ── 載入動畫卡片 ─────────────────────────────────────
function createLoadingCard(code) {
  const el = document.createElement('div');
  el.className = 'loading-card';
  el.innerHTML = `<span class="spinner"></span>正在分析 ${code}...`;
  return el;
}

// ── 工具函式 ─────────────────────────────────────────
function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function loadWatchlist() {
  try {
    const raw = localStorage.getItem('twse_watchlist');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveWatchlist() {
  localStorage.setItem('twse_watchlist', JSON.stringify(watchlist));
}
