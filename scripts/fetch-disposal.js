// scripts/fetch-disposal.js
// GitHub Actions 執行：抓取 TWSE + TPEx 處置清單，輸出 data/disposal.json
// 需要 Node.js 18+（內建 fetch）

const fs   = require('fs');
const path = require('path');

async function fetchJSON(url) {
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.json();
}

// TPEx 7 位數民國日期 1150604 → 115/06/04
function fmtROC(d) {
  const s = String(d || '').trim();
  if (/^\d{7}$/.test(s)) return `${s.slice(0,3)}/${s.slice(3,5)}/${s.slice(5,7)}`;
  return s;
}

// 從文字推算撮合分鐘數
function minutes(str) {
  const s = String(str || '');
  const m = s.match(/每\s*(\d+)\s*分鐘/);
  if (m) return parseInt(m[1]);
  if (/第[二三四五六七八九十]次|加重|曾發布處置/.test(s)) return 20;
  return 5;
}

// 解析期間字串（多次以 ；ー 取第一段）
function parsePeriod(period) {
  if (!period) return { startDate: '', endDate: '' };
  const first = String(period).split(/[；;]/)[0].trim();
  const parts = first.split(/[～~]/);
  return { startDate: (parts[0] || '').trim(), endDate: (parts[1] || '').trim() };
}

async function main() {
  const stocks = {};

  // ── TWSE 上市 ─────────────────────────────────────
  try {
    const list = await fetchJSON('https://openapi.twse.com.tw/v1/announcement/punish');
    let n = 0;
    for (const row of list) {
      const code = (row.Code || '').trim();
      if (!code || !/^\d{4,6}$/.test(code)) continue;
      const { startDate, endDate } = parsePeriod(row.DispositionPeriod);
      stocks[code] = {
        minutes:   minutes(row.DispositionMeasures),
        startDate,
        endDate,
        note: row.DispositionMeasures || '',
      };
      n++;
    }
    console.log(`TWSE 上市：${n} 支`);
  } catch (e) {
    console.error('TWSE 失敗：', e.message);
  }

  // ── TPEx 上櫃 ─────────────────────────────────────
  try {
    const list = await fetchJSON('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information');
    let n = 0;
    for (const item of list) {
      const code = (item.SecuritiesCompanyCode || '').trim();
      if (!code || !/^\d{4,6}$/.test(code)) continue;
      const note = String(item.DisposalCondition || item.DispositionReasons || '');
      const { startDate, endDate } = parsePeriod(item.DispositionPeriod);
      stocks[code] = {
        minutes:   minutes(note),
        startDate: fmtROC(startDate),
        endDate:   fmtROC(endDate),
        note,
      };
      n++;
    }
    console.log(`TPEx 上櫃：${n} 支`);
  } catch (e) {
    console.error('TPEx 失敗：', e.message);
  }

  const output = {
    updated: new Date().toISOString(),
    stocks,
  };

  const outPath = path.join(__dirname, '..', 'data', 'disposal.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`已儲存 ${Object.keys(stocks).length} 支處置股 → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
