import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const EASTMONEY_QUOTE = "https://push2delay.eastmoney.com/api/qt/clist/get";
const EASTMONEY_KLINE = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const EASTMONEY_NOTICE = "https://np-anotice-stock.eastmoney.com/api/security/ann";
const TENCENT_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const A_SHARE_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
const INDUSTRY_FS = "m:90+t:2";
const OUTPUT = resolve("data/audit.json");
const SEVERE_RISK_KEYWORDS = [
  "清仓式减持", "被立案", "立案调查", "行政处罚", "监管函", "警示函",
  "风险提示", "退市", "终止上市", "暂停上市", "预亏", "亏损", "业绩预告修正",
  "业绩预告更正", "债务逾期", "重大诉讼", "仲裁", "冻结", "破产", "重整",
  "大额计提", "商誉减值", "无法表示意见", "保留意见", "非标准审计",
];
const REDUCTION_HOLDER_KEYWORDS = ["控股股东", "实际控制人", "大股东", "持股5%以上", "持股 5%以上"];
const REDUCTION_ACTIVE_KEYWORDS = ["预披露", "计划", "时间过半", "尚未实施完毕", "进展", "期间"];
const REDUCTION_FINISHED_KEYWORDS = ["结果公告", "期限届满", "实施完毕", "完成", "届满暨实施情况"];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const round = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;

function params(values) {
  const search = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => search.set(key, String(value)));
  return search;
}

async function fetchJson(url, query, tries = 3) {
  const full = `${url}?${params(query).toString()}`;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(full, {
        headers: {
          "user-agent": "Mozilla/5.0 A-share strategy monitor",
          referer: "https://quote.eastmoney.com/",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === tries) throw error;
      await sleep(450 * attempt);
    }
  }
}

function marketFromCode(code) {
  return code.startsWith("6") || code.startsWith("9") ? "1" : "0";
}

function isGrowthBoard(code) {
  return code.startsWith("300") || code.startsWith("301") || code.startsWith("688") || code.startsWith("689");
}

async function fetchQuotePage(page, pageSize, fs, fields) {
  return fetchJson(EASTMONEY_QUOTE, {
    pn: page,
    pz: pageSize,
    po: 1,
    np: 1,
    ut: "bd1d9ddb04089700cf9c27f6f7426281",
    fltt: 2,
    invt: 2,
    fid: "f3",
    fs,
    fields,
  });
}

async function fetchAllQuotes() {
  const fields = [
    "f12", "f14", "f2", "f3", "f5", "f6", "f8", "f15", "f16", "f17", "f18",
    "f20", "f21", "f23", "f24", "f25", "f62", "f100", "f10",
  ].join(",");
  const pageSize = 100;
  const first = await fetchQuotePage(1, pageSize, A_SHARE_FS, fields);
  const total = first?.data?.total || 0;
  const pages = Math.ceil(total / pageSize);
  const rows = [...(first?.data?.diff || [])];

  for (let page = 2; page <= pages; page += 1) {
    const json = await fetchQuotePage(page, pageSize, A_SHARE_FS, fields);
    rows.push(...(json?.data?.diff || []));
    await sleep(80);
  }

  return rows.map((row) => ({
    code: String(row.f12),
    name: String(row.f14 || ""),
    latestPrice: num(row.f2),
    pctChange: num(row.f3),
    amount: num(row.f6),
    turnover: num(row.f8),
    quoteVolumeRatio: num(row.f10),
    marketCap: num(row.f20),
    mainNetInflow: num(row.f62),
    industry: row.f100 ? String(row.f100) : "",
  }));
}

async function fetchIndustryRanks() {
  const json = await fetchQuotePage(1, 300, INDUSTRY_FS, "f12,f14,f3,f109");
  const scored = (json?.data?.diff || [])
    .map((board) => ({
      code: String(board.f12 || ""),
      name: String(board.f14 || ""),
      fiveDayChange: num(board.f109) == null ? null : num(board.f109) / 100,
    }))
    .filter((board) => board.code && board.name && Number.isFinite(board.fiveDayChange));

  scored.sort((a, b) => b.fiveDayChange - a.fiveDayChange);
  const total = scored.length || 1;
  return new Map(scored.map((item, index) => [item.name, {
    ...item,
    rank: index + 1,
    total,
    rankPercent: (index + 1) / total,
  }]));
}

async function fetchKlines(secid, limit = 260) {
  try {
    const json = await fetchJson(EASTMONEY_KLINE, {
      secid,
      fields1: "f1,f2,f3,f4,f5,f6",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
      klt: 101,
      fqt: 1,
      end: 20500101,
      lmt: limit,
    });

    return (json?.data?.klines || []).map((line) => {
      const parts = String(line).split(",");
      return {
        date: parts[0],
        open: num(parts[1]),
        close: num(parts[2]),
        high: num(parts[3]),
        low: num(parts[4]),
        volume: num(parts[5]),
        amount: num(parts[6]),
        pctChange: num(parts[8]),
        turnover: num(parts[10]),
      };
    }).filter((row) => [row.open, row.close, row.high, row.low, row.volume].every(Number.isFinite));
  } catch {
    return fetchTencentKlines(secid, limit);
  }
}

async function fetchTencentKlines(secid, limit = 260) {
  const code = secid.split(".").at(-1);
  const symbol = `${marketFromCode(code) === "1" ? "sh" : "sz"}${code}`;
  const json = await fetchJson(TENCENT_KLINE, { param: `${symbol},day,,,${limit},qfq` });
  const rows = json?.data?.[symbol]?.qfqday || json?.data?.[symbol]?.day || [];
  return rows.map((line, index) => {
    const prevClose = index > 0 ? num(rows[index - 1][2]) : null;
    const close = num(line[2]);
    return {
      date: line[0],
      open: num(line[1]),
      close,
      high: num(line[3]),
      low: num(line[4]),
      volume: num(line[5]),
      amount: null,
      pctChange: prevClose ? (close / prevClose - 1) * 100 : null,
      turnover: null,
    };
  }).filter((row) => [row.open, row.close, row.high, row.low, row.volume].every(Number.isFinite));
}

async function checkAnnouncementRisk(code) {
  try {
    const json = await fetchJson(EASTMONEY_NOTICE, {
      sr: -1,
      page_size: 20,
      page_index: 1,
      ann_type: "A",
      client_source: "web",
      stock_list: code,
      f_node: 0,
      s_node: 0,
    }, 2);
    const announcements = (json?.data?.list || []).map((item) => ({
      title: String(item.title_ch || item.title || ""),
      date: String(item.notice_date || item.display_time || "").slice(0, 10),
    }));
    const hit = announcements.find((item) => isRiskAnnouncement(item.title));
    return { checked: true, blocked: Boolean(hit), hit };
  } catch (error) {
    return { checked: false, blocked: false, error: error.message };
  }
}

function isRiskAnnouncement(title) {
  if (SEVERE_RISK_KEYWORDS.some((keyword) => title.includes(keyword))) return true;
  if (!title.includes("减持")) return false;
  if (REDUCTION_FINISHED_KEYWORDS.some((keyword) => title.includes(keyword))) return false;
  const isImportantHolder = REDUCTION_HOLDER_KEYWORDS.some((keyword) => title.includes(keyword));
  const isActivePeriod = REDUCTION_ACTIVE_KEYWORDS.some((keyword) => title.includes(keyword));
  return isImportantHolder && isActivePeriod;
}

function max(rows, key) {
  return Math.max(...rows.map((row) => row[key]).filter(Number.isFinite));
}

function min(rows, key) {
  return Math.min(...rows.map((row) => row[key]).filter(Number.isFinite));
}

function avg(rows, key) {
  const values = rows.map((row) => row[key]).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function scoreCandidate(quote, klines, industryRank) {
  const failures = [];
  const metrics = {};
  if (klines.length < 120) failures.push("上市或K线不足120日");
  const day = klines.at(-1);
  if (!day) return { failures: ["无K线"], metrics };

  const prev = klines.slice(0, -1);
  const prev20 = prev.slice(-20);
  const prev60 = prev.slice(-60);
  const prev120 = prev.slice(-120);
  const prev250 = prev.slice(-250);
  const recent5 = klines.slice(-5);
  if (prev20.length < 20 || prev60.length < 60) failures.push("20/60日样本不足");

  const high60 = max(prev60, "high");
  const drop = day.close / high60 - 1;
  metrics.dropFrom60High = round(drop * 100, 2);
  if (drop > -0.3) failures.push("距60日高点跌幅不足30%");

  const recent5Low = min(recent5, "low");
  const prior60LowBeforeRecent = min(klines.slice(0, -5).slice(-60), "low");
  metrics.recent5Low = recent5Low;
  metrics.prior60LowBeforeRecent = prior60LowBeforeRecent;
  if (recent5Low > prior60LowBeforeRecent) failures.push("最近5日未创60日新低");

  const previousLow = min(prev60, "low");
  const breakPct = day.low / previousLow - 1;
  metrics.previousLow = previousLow;
  metrics.breakPct = round(breakPct * 100, 2);
  if (breakPct < -0.08) failures.push("跌破前低超过8%");
  if (!(breakPct >= -0.06 && breakPct <= -0.02 && day.close >= previousLow * 0.98)) {
    failures.push("未满足跌破前低2%-6%且收回");
  }

  const requiredGain = isGrowthBoard(quote.code) ? 8 : 6;
  metrics.dayPctChange = round(day.pctChange, 2);
  if (!day.pctChange || day.pctChange < requiredGain) failures.push("当日涨幅不足");

  const avgVolume20 = avg(prev20, "volume");
  const volumeRatio = avgVolume20 ? day.volume / avgVolume20 : 0;
  metrics.volumeRatio = round(volumeRatio, 2);
  if (volumeRatio < 2) failures.push("成交量不足20日均量2倍");

  const range = day.high - day.low;
  const entity = Math.abs(day.close - day.open);
  const entityStrength = range > 0 ? entity / range : 0;
  const closePosition = range > 0 ? (day.close - day.low) / range : 0;
  metrics.entityStrength = round(entityStrength * 100, 1);
  metrics.closePosition = round(closePosition * 100, 1);
  if (entityStrength < 0.6) failures.push("实体强度不足60%");
  if (closePosition < 0.8) failures.push("收盘位置不足80%");
  if (day.high - day.close > entity * 0.8) failures.push("上影线过长");

  const turnover = day.turnover ?? quote.turnover;
  const minTurnover = isGrowthBoard(quote.code) ? 8 : 5;
  metrics.turnover = round(turnover, 2);
  if (!turnover || turnover < minTurnover) failures.push("换手率不足");
  if (turnover > 35) failures.push("换手率超过35%");

  const mainNet = quote.mainNetInflow ?? 0;
  const dayAmount = day.amount ?? quote.amount;
  const mainNetRatio = dayAmount ? mainNet / dayAmount : 0;
  metrics.mainNetInflowWan = round(mainNet / 10000, 1);
  metrics.mainNetRatio = round(mainNetRatio * 100, 2);
  if (mainNet <= 0) failures.push("主力净流入非正");

  metrics.industryRankPercent = industryRank ? round(industryRank.rankPercent * 100, 1) : null;
  if (!industryRank || industryRank.rankPercent > 0.3) failures.push("板块强度不在前30%");

  const scores = {
    oversold: drop <= -0.5 ? 20 : drop <= -0.4 ? 15 : 10,
    newLow: recent5Low <= min(prev250, "low") ? 20 : recent5Low <= min(prev120, "low") ? 15 : 10,
    falseBreak: 20,
    priceRise: day.pctChange >= (isGrowthBoard(quote.code) ? 19.5 : 9.8) ? 20 : day.pctChange >= 8 ? 15 : 10,
    volume: volumeRatio >= 5 ? 20 : volumeRatio >= 3 ? 15 : 10,
    candleEntity: 10,
    closePosition: closePosition >= 0.9 ? 15 : 10,
    turnover: turnover >= 15 ? 15 : turnover >= 10 ? 10 : 5,
    moneyFlow: mainNetRatio >= 0.1 ? 20 : mainNetRatio >= 0.05 ? 15 : 10,
    sector: industryRank?.rankPercent <= 0.1 ? 20 : industryRank?.rankPercent <= 0.2 ? 15 : 10,
  };
  metrics.totalScoreIfGatesPassed = Object.values(scores).reduce((sum, value) => sum + value, 0);
  metrics.klineDate = day.date;

  return { failures, metrics };
}

function basicFailure(quote, industryRank) {
  const failures = [];
  if (!quote.code || !quote.name) failures.push("无代码或名称");
  if (/ST|退/.test(quote.name)) failures.push("ST/退市");
  if (!quote.amount || quote.amount < 100_000_000) failures.push("成交额低于1亿元");
  if (!quote.marketCap || quote.marketCap < 3_000_000_000) failures.push("总市值低于30亿元");
  if (!quote.latestPrice || quote.latestPrice < 2) failures.push("股价低于2元");
  if (!quote.pctChange || quote.pctChange < (isGrowthBoard(quote.code) ? 8 : 6)) failures.push("当日涨幅未达到粗筛");
  if (!quote.turnover || quote.turnover < (isGrowthBoard(quote.code) ? 8 : 5) || quote.turnover > 35) failures.push("换手率未达到粗筛");
  if (!quote.mainNetInflow || quote.mainNetInflow <= 0) failures.push("主力净流入未达到粗筛");
  if (quote.quoteVolumeRatio && quote.quoteVolumeRatio < 1.8) failures.push("量比粗筛不足1.8");
  if (!industryRank || industryRank.rankPercent > 0.3) failures.push("行业强度粗筛不足前30%");
  return failures;
}

async function main() {
  const [quotes, industryRanks] = await Promise.all([fetchAllQuotes(), fetchIndustryRanks()]);
  const basicCounts = new Map();
  const prefiltered = [];

  for (const quote of quotes) {
    const industryRank = industryRanks.get(quote.industry);
    const failures = basicFailure(quote, industryRank);
    if (!failures.length) prefiltered.push(quote);
    failures.forEach((failure) => basicCounts.set(failure, (basicCounts.get(failure) || 0) + 1));
  }

  const candidates = [];
  const strictCounts = new Map();
  for (const quote of prefiltered) {
    const announcementRisk = await checkAnnouncementRisk(quote.code);
    const klines = await fetchKlines(`${marketFromCode(quote.code)}.${quote.code}`, 260);
    const result = scoreCandidate(quote, klines, industryRanks.get(quote.industry));
    if (announcementRisk.blocked) {
      result.failures.unshift(`公告风控命中：${announcementRisk.hit?.title || ""}`);
      strictCounts.set("公告风控命中", (strictCounts.get("公告风控命中") || 0) + 1);
    }
    result.failures.forEach((failure) => strictCounts.set(failure, (strictCounts.get(failure) || 0) + 1));
    candidates.push({
      code: quote.code,
      name: quote.name,
      industry: quote.industry,
      quote: {
        pctChange: quote.pctChange,
        turnover: quote.turnover,
        amountYi: round(quote.amount / 100000000, 2),
        mainNetInflowWan: round(quote.mainNetInflow / 10000, 1),
        quoteVolumeRatio: quote.quoteVolumeRatio,
      },
      failures: result.failures,
      metrics: result.metrics,
    });
    await sleep(120);
  }

  const output = {
    generatedAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    quoteCount: quotes.length,
    prefilteredCount: prefiltered.length,
    basicRejectTop: Object.fromEntries([...basicCounts.entries()].sort((a, b) => b[1] - a[1])),
    strictRejectTop: Object.fromEntries([...strictCounts.entries()].sort((a, b) => b[1] - a[1])),
    candidates,
  };

  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    generatedAt: output.generatedAt,
    quoteCount: output.quoteCount,
    prefilteredCount: output.prefilteredCount,
    strictRejectTop: output.strictRejectTop,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
