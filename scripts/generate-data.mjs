import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const STRATEGY_NAME = "A股低位假跌破放量反转策略 V2";
const EASTMONEY_QUOTE = "https://push2delay.eastmoney.com/api/qt/clist/get";
const EASTMONEY_KLINE = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const EASTMONEY_NOTICE = "https://np-anotice-stock.eastmoney.com/api/security/ann";
const TENCENT_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const A_SHARE_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
const INDUSTRY_FS = "m:90+t:2";
const OUTPUT = resolve("data/recommendations.json");
const MAX_RECOMMENDATIONS = 5;
const SEVERE_RISK_KEYWORDS = [
  "清仓式减持", "被立案", "立案调查", "行政处罚", "监管函", "警示函",
  "风险提示", "退市", "终止上市", "暂停上市", "预亏", "亏损", "业绩预告修正",
  "业绩预告更正", "债务逾期", "重大诉讼", "仲裁", "冻结", "破产", "重整",
  "大额计提", "商誉减值", "无法表示意见", "保留意见", "非标准审计"
];
const REDUCTION_HOLDER_KEYWORDS = ["控股股东", "实际控制人", "大股东", "持股5%以上", "持股 5%以上"];
const REDUCTION_ACTIVE_KEYWORDS = ["预披露", "计划", "时间过半", "尚未实施完毕", "进展", "期间"];
const REDUCTION_FINISHED_KEYWORDS = ["结果公告", "期限届满", "实施完毕", "完成", "届满暨实施情况"];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const round = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

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
  if (code.startsWith("6") || code.startsWith("9")) return "1";
  return "0";
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
    "f20", "f21", "f23", "f24", "f25", "f62", "f100", "f10"
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
    high: num(row.f15),
    low: num(row.f16),
    open: num(row.f17),
    prevClose: num(row.f18),
    marketCap: num(row.f20),
    mainNetInflow: num(row.f62),
    industry: row.f100 ? String(row.f100) : "",
  }));
}

async function fetchIndustryRanks() {
  const fields = "f12,f14,f3,f109,f164,f165";
  const json = await fetchQuotePage(1, 300, INDUSTRY_FS, fields);
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
        amplitude: num(parts[7]),
        pctChange: num(parts[8]),
        change: num(parts[9]),
        turnover: num(parts[10]),
      };
    }).filter((row) => [row.open, row.close, row.high, row.low, row.volume].every(Number.isFinite));
  } catch {
    return fetchTencentKlines(secid, limit);
  }
}

async function fetchAnnouncements(code) {
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

  return (json?.data?.list || []).map((item) => ({
    title: String(item.title_ch || item.title || ""),
    date: String(item.notice_date || item.display_time || "").slice(0, 10),
    url: item.art_code ? `https://data.eastmoney.com/notices/detail/${code}/${item.art_code}.html` : "",
  })).filter((item) => item.title);
}

async function checkAnnouncementRisk(code) {
  try {
    const announcements = await fetchAnnouncements(code);
    const hit = announcements.find((item) => isRiskAnnouncement(item.title));
    return {
      checked: true,
      blocked: Boolean(hit),
      hit,
      recent: announcements.slice(0, 3),
    };
  } catch (error) {
    return {
      checked: false,
      blocked: false,
      error: error.message,
      recent: [],
    };
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

async function fetchTencentKlines(secid, limit = 260) {
  const code = secid.split(".").at(-1);
  const symbol = `${marketFromCode(code) === "1" ? "sh" : "sz"}${code}`;
  const json = await fetchJson(TENCENT_KLINE, { param: `${symbol},day,,,${limit},qfq` });
  const rows = json?.data?.[symbol]?.qfqday || json?.data?.[symbol]?.day || [];
  return rows.map((line, index) => {
    const prevClose = index > 0 ? num(rows[index - 1][2]) : null;
    const open = num(line[1]);
    const close = num(line[2]);
    return {
      date: line[0],
      open,
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

function scoreSignal(quote, klines, industryRank, announcementRisk) {
  if (klines.length < 120) return null;
  if (/ST|退/.test(quote.name)) return null;
  if (!quote.latestPrice || quote.latestPrice < 2) return null;
  if (!quote.amount || quote.amount < 100_000_000) return null;
  if (!quote.marketCap || quote.marketCap < 3_000_000_000) return null;

  const day = klines.at(-1);
  const prev = klines.slice(0, -1);
  const prev20 = prev.slice(-20);
  const prev60 = prev.slice(-60);
  const prev120 = prev.slice(-120);
  const prev250 = prev.slice(-250);
  const recent5 = klines.slice(-5);
  if (prev20.length < 20 || prev60.length < 60) return null;

  const high60 = max(prev60, "high");
  const drop = day.close / high60 - 1;
  if (drop > -0.3) return null;

  const recent5Low = min(recent5, "low");
  const prior60LowBeforeRecent = min(klines.slice(0, -5).slice(-60), "low");
  if (recent5Low > prior60LowBeforeRecent) return null;

  const previousLow = min(prev60, "low");
  const breakPct = day.low / previousLow - 1;
  if (breakPct < -0.08) return null;
  if (!(breakPct >= -0.06 && breakPct <= -0.02 && day.close >= previousLow * 0.98)) return null;

  const requiredGain = isGrowthBoard(quote.code) ? 8 : 6;
  if (!day.pctChange || day.pctChange < requiredGain) return null;

  const avgVolume20 = avg(prev20, "volume");
  const volumeRatio = avgVolume20 ? day.volume / avgVolume20 : 0;
  if (volumeRatio < 2) return null;

  const range = day.high - day.low;
  const entity = Math.abs(day.close - day.open);
  const entityStrength = range > 0 ? entity / range : 0;
  const closePosition = range > 0 ? (day.close - day.low) / range : 0;
  if (entityStrength < 0.6 || closePosition < 0.8) return null;
  if (day.high - day.close > entity * 0.8) return null;

  const turnover = day.turnover ?? quote.turnover;
  const minTurnover = isGrowthBoard(quote.code) ? 8 : 5;
  if (!turnover || turnover < minTurnover || turnover > 35) return null;

  const mainNet = quote.mainNetInflow ?? 0;
  if (mainNet <= 0) return null;
  const dayAmount = day.amount ?? quote.amount;
  const mainNetRatio = dayAmount ? mainNet / dayAmount : 0;

  if (!industryRank || industryRank.rankPercent > 0.3) return null;

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
    sector: industryRank.rankPercent <= 0.1 ? 20 : industryRank.rankPercent <= 0.2 ? 15 : 10,
  };

  const totalScore = Object.values(scores).reduce((sum, value) => sum + value, 0);
  if (totalScore < 90) return null;

  const buyPrice = (day.open + day.close) / 2;
  const latestPrice = quote.latestPrice || day.close;
  const estimatedWinRate = Math.min(78, Math.max(45, 38 + totalScore * 0.27));

  return {
    strategyName: STRATEGY_NAME,
    tradeDate: day.date,
    code: quote.code,
    name: quote.name,
    industry: quote.industry,
    industryRank: industryRank.rank,
    industryRankPercent: round(industryRank.rankPercent * 100, 1),
    signalLevel: totalScore >= 110 ? "buy" : "watch",
    totalScore,
    estimatedWinRate: round(estimatedWinRate, 1),
    latestPrice: round(latestPrice),
    dailyChange: round(day.pctChange, 2),
    scores,
    metrics: {
      dropFrom60High: round(drop * 100, 2),
      breakPct: round(breakPct * 100, 2),
      volumeRatio: round(volumeRatio, 2),
      entityStrength: round(entityStrength * 100, 1),
      closePosition: round(closePosition * 100, 1),
      turnover: round(turnover, 2),
      mainNetInflow: round(mainNet / 10000, 1),
      mainNetRatio: round(mainNetRatio * 100, 2),
      sectorFiveDayChange: round(industryRank.fiveDayChange * 100, 2),
    },
    tradePlan: {
      buyPrice: round(buyPrice),
      aggressiveBuyPrice: round(day.close),
      buyTiming: "信号次一交易日：不低开超过3%，回踩信号日实体中位线企稳后放量上攻",
      stopLoss: round(buyPrice * 0.97),
      structuralStop: round(day.low),
      takeProfit1: round(buyPrice * 1.15),
      takeProfit2: round(buyPrice * 1.3),
      trailingRule: "剩余仓位沿10日均线持有，收盘跌破10日均线或从最高点回撤10%卖出",
      sellTiming: "买入后3个交易日确认量能，1-4周内按15%/30%目标分批执行，剩余仓位跟随10日均线",
    },
    reasons: [
      `距60日高点跌幅 ${round(drop * 100, 1)}%，满足超跌`,
      `盘中跌破前低 ${round(breakPct * 100, 1)}% 后收回`,
      `当日涨幅 ${round(day.pctChange, 1)}%，量比 ${round(volumeRatio, 2)}`,
      `实体强度 ${round(entityStrength * 100, 1)}%，收盘位置 ${round(closePosition * 100, 1)}%`,
      `主力净流入 ${round(mainNet / 10000, 1)} 万元，行业5日强度排名前 ${round(industryRank.rankPercent * 100, 1)}%`,
      announcementRisk?.checked ? "近20条公告未命中重大利空、减持或业绩暴雷关键词" : "公告风控接口本次未能确认，需人工复核",
    ],
    recentAnnouncements: announcementRisk?.recent || [],
  };
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  console.log("Fetching A-share quotes...");
  const [quotes, industryRanks] = await Promise.all([fetchAllQuotes(), fetchIndustryRanks()]);
  const prefiltered = quotes.filter((quote) => {
    if (!quote.code || !quote.name) return false;
    if (/ST|退/.test(quote.name)) return false;
    if (!quote.amount || quote.amount < 100_000_000) return false;
    if (!quote.marketCap || quote.marketCap < 3_000_000_000) return false;
    if (!quote.latestPrice || quote.latestPrice < 2) return false;
    if (!quote.pctChange || quote.pctChange < (isGrowthBoard(quote.code) ? 8 : 6)) return false;
    if (!quote.turnover || quote.turnover < (isGrowthBoard(quote.code) ? 8 : 5) || quote.turnover > 35) return false;
    if (!quote.mainNetInflow || quote.mainNetInflow <= 0) return false;
    if (quote.quoteVolumeRatio && quote.quoteVolumeRatio < 1.8) return false;
    const industryRank = industryRanks.get(quote.industry);
    if (!industryRank || industryRank.rankPercent > 0.3) return false;
    return true;
  });

  console.log(`Scanning ${prefiltered.length} stocks after basic exclusions...`);
  const signals = [];
  let announcementCheckedCount = 0;
  let excludedByAnnouncement = 0;
  const announcementRiskSamples = [];
  await mapLimit(prefiltered, 10, async (quote, index) => {
    if (index > 0 && index % 200 === 0) console.log(`Scanned ${index}/${prefiltered.length}`);
    try {
      const announcementRisk = await checkAnnouncementRisk(quote.code);
      if (announcementRisk.checked) announcementCheckedCount += 1;
      if (announcementRisk.blocked) {
        excludedByAnnouncement += 1;
        if (announcementRiskSamples.length < 5) {
          announcementRiskSamples.push({
            code: quote.code,
            name: quote.name,
            title: announcementRisk.hit.title,
            date: announcementRisk.hit.date,
            url: announcementRisk.hit.url,
          });
        }
        return;
      }
      const secid = `${marketFromCode(quote.code)}.${quote.code}`;
      const klines = await fetchKlines(secid, 260);
      const signal = scoreSignal(quote, klines, industryRanks.get(quote.industry), announcementRisk);
      if (signal) signals.push(signal);
    } catch (error) {
      console.warn(`Skip ${quote.code} ${quote.name}: ${error.message}`);
    }
  });

  signals.sort((a, b) => b.estimatedWinRate - a.estimatedWinRate || b.totalScore - a.totalScore);
  const recommendations = signals.slice(0, MAX_RECOMMENDATIONS);
  const tradeDate = recommendations[0]?.tradeDate || new Date().toISOString().slice(0, 10);

  const output = {
    generatedAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    tradeDate,
    dataSources: [
      "东方财富沪深A股实时行情 clist/get",
      "东方财富行业板块近5日涨幅 f109",
      "东方财富日K线 kline/get，失败时回退腾讯证券复权日K线",
      "东方财富上市公司公告 security/ann",
    ],
    strategyName: STRATEGY_NAME,
    scannedCount: prefiltered.length,
    signalCount: signals.length,
    riskReview: {
      announcementCheckedCount,
      excludedByAnnouncement,
      announcementRiskSamples,
      riskKeywords: [
        ...SEVERE_RISK_KEYWORDS,
        "控股股东/实际控制人大额减持计划或进行期",
      ],
    },
    recommendations,
    notes: [
      "强信号：总分 >= 110；观察信号：总分 90-109；低于90自动空置。",
      "估算胜率来自策略评分映射，用于排序，不等同于历史回测胜率。",
      "近期公告命中重大利空、减持、业绩暴雷等关键词的股票会按文档淘汰条件剔除。",
      "页面仅作策略监测和交易记录，不构成投资建议。",
    ],
  };

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT} with ${recommendations.length} recommendations.`);
}

main().catch(async (error) => {
  console.error(error);
  let previous = {};
  try {
    previous = JSON.parse(await readFile(OUTPUT, "utf8"));
  } catch {
    previous = {};
  }
  const fallback = {
    ...previous,
    generatedAt: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
    tradeDate: previous.tradeDate || "",
    dataSources: [
      "东方财富沪深A股实时行情 clist/get",
      "东方财富行业板块近5日涨幅 f109",
      "东方财富日K线 kline/get，失败时回退腾讯证券复权日K线",
      "东方财富上市公司公告 security/ann",
    ],
    strategyName: STRATEGY_NAME,
    recommendations: previous.recommendations || [],
    error: error.message,
    notes: [
      "每日更新脚本运行失败，已保留空推荐，避免页面发布失败。",
      "请检查 GitHub Actions 网络访问和东方财富接口可用性。",
    ],
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
  process.exitCode = 1;
});
