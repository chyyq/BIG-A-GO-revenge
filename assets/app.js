const DATA_URL = "data/recommendations.json";
const STORAGE_KEY = "aShareSpringReversalTrades";

const state = {
  data: null,
  trades: [],
  filter: "all",
};

const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "--";
const pct = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : "--";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function loadTrades() {
  try {
    state.trades = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    state.trades = [];
  }
}

function saveTrades() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.trades));
}

async function loadData() {
  try {
    const response = await fetch(`${DATA_URL}?v=${Date.now()}`);
    if (!response.ok) throw new Error(`数据读取失败：${response.status}`);
    state.data = await response.json();
  } catch (error) {
    if (window.__RECOMMENDATIONS_DATA__) {
      state.data = window.__RECOMMENDATIONS_DATA__;
      state.data.notes = [
        ...(state.data.notes || []),
        `JSON读取失败，已使用内嵌备用数据：${error.message}`,
      ];
      return;
    }
    throw error;
  }
}

function renderMetrics(alerts) {
  $("updatedAt").textContent = state.data?.generatedAt || "--";
  $("signalCount").textContent = String(state.data?.recommendations?.length || 0);
  $("alertCount").textContent = String(alerts.length);
}

function signalBadge(signal) {
  const kind = signal.signalLevel === "buy" ? "buy" : "watch";
  const text = signal.signalLevel === "buy" ? "买入候选" : "观察";
  return `<span class="badge ${kind}">${text}</span>`;
}

function recommendationCard(signal) {
  const reasons = signal.reasons.slice(0, 5).map((item) => `<li>${item}</li>`).join("");
  return `
    <article class="signal-card" data-level="${signal.signalLevel}">
      <div class="card-head">
        <div class="stock-title">
          <strong>${signal.name}</strong>
          <span>${signal.code} · ${signal.industry || "行业待确认"} · ${signal.setupType || "放量反转"}</span>
        </div>
        ${signalBadge(signal)}
      </div>
      <div class="score-row">
        <div><span>总分</span><strong>${signal.totalScore}</strong></div>
        <div><span>估算胜率</span><strong>${pct(signal.estimatedWinRate)}</strong></div>
        <div><span>最新价</span><strong>${fmt(signal.latestPrice)}</strong></div>
      </div>
      <div class="price-grid">
        <div class="price-box"><span>推荐买点</span><strong>${fmt(signal.tradePlan.buyPrice)}</strong><small>${signal.tradePlan.buyTiming}</small></div>
        <div class="price-box"><span>硬止损</span><strong>${fmt(signal.tradePlan.stopLoss)}</strong><small>买入价 × 0.96</small></div>
        <div class="price-box"><span>10%止盈</span><strong>${fmt(signal.tradePlan.takeProfit1)}</strong><small>卖出 30%</small></div>
        <div class="price-box"><span>20%止盈</span><strong>${fmt(signal.tradePlan.takeProfit2)}</strong><small>卖出 40%</small></div>
      </div>
      <ul class="reasons">${reasons}</ul>
      <p class="muted">卖点时间：${signal.tradePlan.sellTiming}</p>
      <div class="card-actions">
        <button type="button" data-action="prefill" data-code="${signal.code}" class="primary">加入交易记录</button>
      </div>
    </article>
  `;
}

function renderRecommendations() {
  const box = $("recommendations");
  const empty = $("emptyState");
  const rows = (state.data?.recommendations || []).filter((item) => {
    if (state.filter === "all") return true;
    return item.signalLevel === state.filter;
  });

  box.innerHTML = rows.map(recommendationCard).join("");
  empty.classList.toggle("hidden", rows.length > 0);
}

function quoteMap() {
  return new Map((state.data?.recommendations || []).map((item) => [item.code, item]));
}

function buildAlerts() {
  const quotes = quoteMap();
  const alerts = [];

  state.trades.filter((trade) => trade.status !== "closed").forEach((trade) => {
    const signal = quotes.get(trade.code);
    const latest = signal?.latestPrice;
    if (!Number.isFinite(Number(latest))) return;

    if (trade.stopLoss && latest <= trade.stopLoss) {
      alerts.push({
        type: "danger",
        title: `${trade.name || trade.code} 触发硬止损`,
        body: `最新价 ${fmt(latest)} 已低于硬止损 ${fmt(trade.stopLoss)}，按策略应立即卖出。`,
      });
    } else if (trade.target2 && latest >= trade.target2) {
      alerts.push({
        type: "good",
        title: `${trade.name || trade.code} 到达 20% 止盈`,
        body: `最新价 ${fmt(latest)} 已达到 ${fmt(trade.target2)}，策略建议再卖出 40%，余下沿 10 日均线持有。`,
      });
    } else if (trade.target1 && latest >= trade.target1) {
      alerts.push({
        type: "good",
        title: `${trade.name || trade.code} 到达 10% 止盈`,
        body: `最新价 ${fmt(latest)} 已达到 ${fmt(trade.target1)}，策略建议卖出 30%。`,
      });
    }
  });

  return alerts;
}

function renderAlerts(alerts) {
  const box = $("alerts");
  if (!alerts.length) {
    box.innerHTML = `<div class="empty">暂无触发卖点或止损提醒。</div>`;
    return;
  }
  box.innerHTML = alerts.map((alert) => `
    <div class="alert ${alert.type}">
      <strong>${alert.title}</strong>
      <p>${alert.body}</p>
    </div>
  `).join("");
}

function renderRiskReview() {
  const risk = state.data?.riskReview || {};
  const sources = state.data?.dataSources || [];
  $("riskReview").innerHTML = `
    <div><strong>公告风控</strong><br>检查 ${risk.announcementCheckedCount ?? 0} 只，淘汰 ${risk.excludedByAnnouncement ?? 0} 只。</div>
    <div><strong>数据源</strong>
      <ul>${sources.map((source) => `<li>${source}</li>`).join("")}</ul>
    </div>
  `;
}

function renderTrades() {
  const box = $("trades");
  if (!state.trades.length) {
    box.innerHTML = `<div class="empty">还没有交易记录。只有你保存买入后，系统才会持续监控卖点。</div>`;
    return;
  }

  box.innerHTML = state.trades.map((trade) => `
    <article class="trade-item">
      <header>
        <strong>${trade.name || trade.code} <span class="muted">${trade.code}</span></strong>
        <span class="badge ${trade.status === "closed" ? "watch" : "buy"}">${trade.status === "closed" ? "已卖出" : "持仓中"}</span>
      </header>
      <div class="trade-meta">
        <span>买入：${fmt(trade.buyPrice)}</span>
        <span>数量：${trade.quantity || "--"}</span>
        <span>止损：${fmt(trade.stopLoss)}</span>
        <span>日期：${trade.buyDate || "--"}</span>
      </div>
      ${trade.notes ? `<p class="muted">${trade.notes}</p>` : ""}
      <div class="trade-actions">
        <button type="button" data-action="edit" data-id="${trade.id}">编辑</button>
        <button type="button" data-action="close" data-id="${trade.id}">标记卖出</button>
        <button type="button" data-action="delete" data-id="${trade.id}">删除</button>
      </div>
    </article>
  `).join("");
}

function rerender() {
  renderRecommendations();
  renderTrades();
  const alerts = buildAlerts();
  renderAlerts(alerts);
  renderMetrics(alerts);
  renderRiskReview();
}

function resetForm() {
  $("tradeForm").reset();
  $("tradeBuyDate").value = todayISO();
  delete $("tradeForm").dataset.editing;
}

function fillTradeForm(trade) {
  $("tradeCode").value = trade.code || "";
  $("tradeName").value = trade.name || "";
  $("tradeBuyPrice").value = trade.buyPrice || "";
  $("tradeQuantity").value = trade.quantity || "";
  $("tradeBuyDate").value = trade.buyDate || todayISO();
  $("tradeStopLoss").value = trade.stopLoss || "";
  $("tradeTarget1").value = trade.target1 || "";
  $("tradeTarget2").value = trade.target2 || "";
  $("tradeNotes").value = trade.notes || "";
  $("tradeForm").dataset.editing = trade.id || "";
}

function prefillFromSignal(code) {
  const signal = quoteMap().get(code);
  if (!signal) return;
  fillTradeForm({
    code: signal.code,
    name: signal.name,
    buyPrice: signal.tradePlan.buyPrice,
    buyDate: todayISO(),
    stopLoss: signal.tradePlan.stopLoss,
    target1: signal.tradePlan.takeProfit1,
    target2: signal.tradePlan.takeProfit2,
    notes: `来源：${signal.tradeDate} ${signal.strategyName}，${signal.signalLevel === "buy" ? "买入候选" : "观察信号"}`,
  });
  $("tradeCode").scrollIntoView({ behavior: "smooth", block: "center" });
  $("tradeBuyPrice").focus();
}

function upsertTrade(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const editing = event.currentTarget.dataset.editing;
  const trade = {
    id: editing || crypto.randomUUID(),
    code: String(form.get("code") || "").trim(),
    name: String(form.get("name") || "").trim(),
    buyPrice: Number(form.get("buyPrice")),
    quantity: Number(form.get("quantity")) || "",
    buyDate: String(form.get("buyDate") || todayISO()),
    stopLoss: Number(form.get("stopLoss")) || Number(form.get("buyPrice")) * 0.96,
    target1: Number(form.get("target1")) || Number(form.get("buyPrice")) * 1.1,
    target2: Number(form.get("target2")) || Number(form.get("buyPrice")) * 1.2,
    notes: String(form.get("notes") || "").trim(),
    status: "open",
  };

  if (!trade.code || !Number.isFinite(trade.buyPrice) || trade.buyPrice <= 0) return;

  const index = state.trades.findIndex((item) => item.id === trade.id);
  if (index >= 0) state.trades[index] = { ...state.trades[index], ...trade };
  else state.trades.unshift(trade);

  saveTrades();
  resetForm();
  rerender();
}

function handleDocumentClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;

  if (action === "prefill") {
    prefillFromSignal(button.dataset.code);
    return;
  }

  const trade = state.trades.find((item) => item.id === id);
  if (!trade) return;

  if (action === "edit") {
    fillTradeForm(trade);
  } else if (action === "close") {
    trade.status = "closed";
    saveTrades();
    rerender();
  } else if (action === "delete") {
    state.trades = state.trades.filter((item) => item.id !== id);
    saveTrades();
    rerender();
  }
}

function bindEvents() {
  document.addEventListener("click", handleDocumentClick);
  $("tradeForm").addEventListener("submit", upsertTrade);
  $("resetForm").addEventListener("click", resetForm);
  $("refreshView").addEventListener("click", () => init());
  $("clearClosed").addEventListener("click", () => {
    state.trades = state.trades.filter((trade) => trade.status !== "closed");
    saveTrades();
    rerender();
  });
  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.filter = button.dataset.filter;
      renderRecommendations();
    });
  });
}

async function init() {
  loadTrades();
  resetForm();
  try {
    await loadData();
  } catch (error) {
    state.data = { generatedAt: "数据未生成", recommendations: [] };
    $("emptyState").textContent = error.message;
  }
  rerender();
}

bindEvents();
init();
