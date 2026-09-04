const DATA_URL = "./data/history.json";
const DETROIT_TIME_ZONE = "America/Detroit";
const RANGE_MS = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const numberFormatter = new Intl.NumberFormat("en-US");
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DETROIT_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DETROIT_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const elements = {
  percentage: document.querySelector("#current-percentage"),
  sourceUpdated: document.querySelector("#source-updated"),
  affected: document.querySelector("#customers-affected"),
  total: document.querySelector("#total-customers"),
  fetchedAt: document.querySelector("#fetched-at"),
  samplingNote: document.querySelector("#sampling-note"),
  empty: document.querySelector("#chart-empty"),
  chart: document.querySelector("#outage-chart"),
  rangeButtons: [...document.querySelectorAll("[data-range]")],
};

let chart;
let observations = [];
let domain = { start: 0, end: 1 };
let visibleRange = { start: 0, end: 1 };
let zoomTimer;

function toObservation(point) {
  const timestamp = Date.parse(point.timestamp);
  const value = Number(point.value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(value)) return null;
  return { ...point, timestamp, value };
}

function deduplicateAndSort(points) {
  const byTimestamp = new Map();
  points.map(toObservation).filter(Boolean).forEach((point) => byTimestamp.set(point.timestamp, point));
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function formatInterval(milliseconds) {
  const minutes = Math.max(1, Math.round(milliseconds / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.round(hours / 24)} day`;
}

function lowerBound(timestamp) {
  let low = 0;
  let high = observations.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (observations[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(timestamp) {
  let low = 0;
  let high = observations.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (observations[middle].timestamp <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function interpolatedPoint(timestamp) {
  if (!observations.length) return null;
  const rightIndex = lowerBound(timestamp);
  if (rightIndex === 0) return observations[0];
  if (rightIndex === observations.length) return observations.at(-1);

  const left = observations[rightIndex - 1];
  const right = observations[rightIndex];
  if (right.timestamp === timestamp) return right;
  const ratio = (timestamp - left.timestamp) / (right.timestamp - left.timestamp);
  return { timestamp, value: left.value + (right.value - left.value) * ratio };
}

function selectVisibleWindow(start, end) {
  const firstInsideIndex = lowerBound(start);
  const afterEndIndex = upperBound(end);
  const inside = observations.slice(firstInsideIndex, afterEndIndex);
  const previous = firstInsideIndex > 0 ? observations[firstInsideIndex - 1] : null;
  const next = afterEndIndex < observations.length ? observations[afterEndIndex] : null;
  const yPoints = [interpolatedPoint(start), ...inside, interpolatedPoint(end)].filter(Boolean);
  return { inside, previous, next, yPoints };
}

function sampleForHover(points, start, end) {
  const chartWidth = Math.max(elements.chart.clientWidth, 320);
  const maxHoverPoints = Math.max(48, Math.min(220, Math.floor(chartWidth / 11)));
  if (points.length <= maxHoverPoints) {
    return { points, minimumInterval: 0 };
  }

  const minimumInterval = Math.max(1, (end - start) / maxHoverPoints);
  const sampled = [points[0]];
  let bucketStart = points[0].timestamp;
  let candidate = null;

  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    if (point.timestamp - bucketStart >= minimumInterval) {
      if (candidate) sampled.push(candidate);
      bucketStart = point.timestamp;
      candidate = point;
      continue;
    }

    const previous = sampled[sampled.length - 1];
    if (!candidate || Math.abs(point.value - previous.value) > Math.abs(candidate.value - previous.value)) {
      candidate = point;
    }
  }

  if (candidate && candidate.timestamp !== sampled[sampled.length - 1].timestamp) sampled.push(candidate);
  const last = points[points.length - 1];
  if (last.timestamp !== sampled[sampled.length - 1].timestamp) sampled.push(last);
  return { points: sampled, minimumInterval };
}

function yBounds(points) {
  if (!points.length) return { min: 0, max: 1 };
  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, 0.2);
  const padding = Math.max(span * 0.16, 0.08);
  return {
    min: Math.max(0, Number((low - padding).toFixed(4))),
    max: Math.min(100, Number((high + padding).toFixed(4))),
  };
}

function yAxisDecimals(bounds) {
  const approximateTickSize = Math.max((bounds.max - bounds.min) / 5, 0.0001);
  if (approximateTickSize >= 1) return 0;
  return Math.min(4, Math.max(1, Math.ceil(-Math.log10(approximateTickSize))));
}

function uniqueByTimestamp(points) {
  const unique = new Map();
  points.filter(Boolean).forEach((point) => unique.set(point.timestamp, point));
  return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function updateRangeButton() {
  const tolerance = 5 * 60 * 1000;
  const visibleSpan = visibleRange.end - visibleRange.start;
  let activeRange = "all";
  for (const [key, duration] of Object.entries(RANGE_MS)) {
    if (Math.abs(visibleSpan - duration) < tolerance && Math.abs(visibleRange.end - domain.end) < tolerance) {
      activeRange = key;
      break;
    }
  }
  elements.rangeButtons.forEach((button) => button.classList.toggle("active", button.dataset.range === activeRange));
}

function renderVisibleRange() {
  const windowData = selectVisibleWindow(visibleRange.start, visibleRange.end);
  const sampled = sampleForHover(windowData.inside, visibleRange.start, visibleRange.end);
  const renderPoints = uniqueByTimestamp([windowData.previous, ...sampled.points, windowData.next]);
  const bounds = yBounds(windowData.yPoints);
  const decimals = yAxisDecimals(bounds);
  const showSymbols = sampled.points.length <= 90;

  chart.setOption({
    yAxis: {
      min: bounds.min,
      max: bounds.max,
      axisLabel: {
        color: "#657181",
        formatter: (value) => `${Number(value).toFixed(decimals)}%`,
      },
    },
    series: [{
      data: renderPoints.map((point) => ({
        value: [point.timestamp, point.value],
        customersAffected: point.customersAffected,
        totalCustomers: point.totalCustomers,
      })),
      showSymbol: showSymbols,
    }],
  });

  if (!windowData.inside.length && renderPoints.length > 1) {
    elements.samplingNote.textContent = "No reading inside this window · line interpolated from adjacent observations";
  } else {
    elements.samplingNote.textContent = sampled.minimumInterval
      ? `${numberFormatter.format(windowData.inside.length)} observations · hover points spaced by at least ${formatInterval(sampled.minimumInterval)}`
      : `${numberFormatter.format(windowData.inside.length)} observation${windowData.inside.length === 1 ? "" : "s"} in view · every point is interactive`;
  }
  updateRangeButton();
}

function chartOptions() {
  return {
    animationDuration: 500,
    animationEasing: "cubicOut",
    grid: { left: 58, right: 24, top: 28, bottom: 88, containLabel: false },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "#13233a",
      borderWidth: 0,
      padding: [12, 14],
      textStyle: { color: "#fffdf8", fontFamily: "Inter, sans-serif", fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: "rgba(238,91,53,.75)", width: 1 } },
      formatter(params) {
        const item = params[0];
        if (!item) return "";
        const timestamp = Number(item.value[0]);
        const value = Number(item.value[1]);
        return [
          `<span style="color:#aeb6c1">${dateTimeFormatter.format(new Date(timestamp))}</span>`,
          `<strong style="display:block;margin-top:6px;font-family:Georgia,serif;font-size:22px;font-weight:400;color:#fffdf8">${value.toFixed(2)}%</strong>`,
          `<span style="color:#aeb6c1">Power Interrupted</span>`,
        ].join("");
      },
    },
    xAxis: {
      type: "time",
      min: domain.start,
      max: domain.end,
      boundaryGap: false,
      axisLine: { lineStyle: { color: "rgba(19,35,58,.2)" } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: "#657181",
        hideOverlap: true,
        margin: 14,
        formatter(value) { return shortDateFormatter.format(new Date(value)); },
      },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: "#657181", formatter: (value) => `${Number(value).toFixed(1)}%` },
      splitNumber: 5,
      splitLine: { lineStyle: { color: "rgba(19,35,58,.09)", type: "dashed" } },
    },
    dataZoom: [
      {
        type: "inside",
        xAxisIndex: 0,
        filterMode: "none",
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
        preventDefaultMouseMove: true,
      },
      {
        type: "slider",
        xAxisIndex: 0,
        filterMode: "none",
        height: 22,
        bottom: 24,
        borderColor: "transparent",
        backgroundColor: "#f4f1ea",
        fillerColor: "rgba(238,91,53,.16)",
        dataBackground: {
          lineStyle: { color: "#9aa2ad", width: 1 },
          areaStyle: { color: "rgba(154,162,173,.12)" },
        },
        selectedDataBackground: {
          lineStyle: { color: "#ee5b35", width: 1 },
          areaStyle: { color: "rgba(238,91,53,.2)" },
        },
        handleStyle: { color: "#fffdf8", borderColor: "#13233a", borderWidth: 1 },
        moveHandleStyle: { color: "#13233a" },
        textStyle: { color: "#657181", fontSize: 10 },
        brushSelect: false,
      },
    ],
    series: [
      {
        name: "Power Interrupted",
        type: "line",
        data: [],
        smooth: false,
        connectNulls: false,
        showSymbol: true,
        symbol: "circle",
        symbolSize: 7,
        lineStyle: { color: "#ee5b35", width: 3 },
        itemStyle: { color: "#fffdf8", borderColor: "#ee5b35", borderWidth: 2 },
        emphasis: { scale: 1.5, itemStyle: { color: "#ee5b35" } },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(238,91,53,.25)" },
            { offset: 1, color: "rgba(238,91,53,.015)" },
          ]),
        },
      },
    ],
  };
}

function setRange(rangeKey) {
  const desiredStart = rangeKey === "all" ? domain.start : Math.max(domain.start, domain.end - RANGE_MS[rangeKey]);
  visibleRange = { start: desiredStart, end: domain.end };
  chart.dispatchAction({ type: "dataZoom", startValue: visibleRange.start, endValue: visibleRange.end });
  renderVisibleRange();
}

function handleZoom(event) {
  const payload = event.batch?.[0] ?? event;
  const domainSpan = domain.end - domain.start;
  const start = Number.isFinite(payload.startValue)
    ? Number(payload.startValue)
    : domain.start + domainSpan * (Number(payload.start ?? 0) / 100);
  const end = Number.isFinite(payload.endValue)
    ? Number(payload.endValue)
    : domain.start + domainSpan * (Number(payload.end ?? 100) / 100);

  visibleRange = { start: Math.max(domain.start, start), end: Math.min(domain.end, end) };
  window.clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(renderVisibleRange, 70);
}

function updateSummary(data) {
  const latest = observations.at(-1);
  if (!latest) return;

  elements.percentage.innerHTML = `${latest.value.toFixed(2)}<span>%</span>`;
  elements.sourceUpdated.textContent = dateTimeFormatter.format(new Date(latest.timestamp));
  elements.affected.textContent = numberFormatter.format(latest.customersAffected);
  elements.total.textContent = numberFormatter.format(latest.totalCustomers);
  elements.fetchedAt.textContent = data.generatedAt
    ? `Last fetched ${dateTimeFormatter.format(new Date(data.generatedAt))}`
    : "Latest source timestamp shown above";
}

function showLoadError(error) {
  console.error(error);
  elements.empty.hidden = false;
  elements.empty.querySelector("strong").textContent = "History unavailable";
  elements.empty.querySelector("span").textContent = "The data file could not be loaded. Please try again shortly.";
  elements.samplingNote.textContent = "Unable to load observations";
  elements.fetchedAt.textContent = "Data fetch failed";
}

async function init() {
  try {
    const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`History request failed with ${response.status}`);
    const data = await response.json();
    observations = deduplicateAndSort(Array.isArray(data.points) ? data.points : []);
    if (!observations.length) {
      elements.empty.hidden = false;
      return;
    }

    updateSummary(data);
    const first = observations[0].timestamp;
    const last = observations.at(-1).timestamp;
    const singlePointPadding = 30 * 60 * 1000;
    domain = first === last
      ? { start: first - singlePointPadding, end: last + singlePointPadding }
      : { start: first, end: last };

    chart = echarts.init(elements.chart, null, { renderer: "canvas" });
    chart.setOption(chartOptions());
    chart.on("datazoom", handleZoom);

    const initialKey = last - first > RANGE_MS["24h"] ? "24h" : "all";
    setRange(initialKey);

    elements.rangeButtons.forEach((button) => {
      button.addEventListener("click", () => setRange(button.dataset.range));
    });

    const resizeObserver = new ResizeObserver(() => {
      chart.resize();
      renderVisibleRange();
    });
    resizeObserver.observe(elements.chart);
  } catch (error) {
    showLoadError(error);
  }
}

init();
