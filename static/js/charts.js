/**
 * 纯 SVG / Canvas 图表渲染器（无第三方依赖）。
 * 
 * 提供：
 *   PaleoChart.line(el, cfg)     折线 / 面积图（带十字准线提示）
 *   PaleoChart.scatter(el, cfg)  散点 + 拟合线
 *   PaleoChart.heatmap(el, cfg)  热力图（Canvas，用于小波与空间场）
 *   PaleoChart.matrix(el, cfg)   相关矩阵
 *   PaleoChart.empty/loading/error 占位状态
 */
(function (global) {
  "use strict";

  const T = global.PaleoTheme;
  const NS = "http://www.w3.org/2000/svg";
  const registry = new WeakMap();

  // ------------------------------------------------------------ 基础工具
  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) {
      const pad = Math.abs(min) || 1;
      min -= pad;
      max += pad;
    }
    const span = max - min;
    const step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    step *= mag;
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 1e-6; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return ticks;
  }

  function extent(values) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (v === null || v === undefined || !isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!isFinite(min)) return [0, 1];
    if (min === max) {
      const pad = Math.abs(min) || 1;
      return [min - pad, max + pad];
    }
    return [min, max];
  }

  function ensureSvg(el, width, height) {
    el.innerHTML = "";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.display = "block";
    el.appendChild(svg);
    return svg;
  }

  function node(tag, attrs, text) {
    const el = document.createElementNS(NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v !== null && v !== undefined) el.setAttribute(k, String(v));
    });
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function fmt(value, digits) {
    return T.FORMAT.number(value, digits === undefined ? 2 : digits);
  }

  // 每次渲染都记录下来，窗口尺寸变化时重绘
  function remember(el, render) {
    registry.set(el, render);
  }

  let resizeTimer = null;
  global.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll("[data-paleo-chart]").forEach((el) => {
        const render = registry.get(el);
        if (render) render();
      });
    }, 180);
  });

  // ------------------------------------------------------------ 折线图
  function line(el, cfg) {
    if (!el) return;
    el.dataset.paleoChart = "line";
    const render = () => drawLine(el, cfg);
    remember(el, render);
    render();
  }

  function drawLine(el, cfg) {
    const series = (cfg.series || []).filter((s) => s && s.values && s.values.length);
    if (!series.length) {
      empty(el, cfg.emptyTitle || "暂无数据", cfg.emptyHint || "");
      return;
    }
    const { width, height } = T.measure(el);
    const margin = Object.assign({ top: 34, right: 20, bottom: 46, left: 64 }, cfg.margin || {});
    const plotW = Math.max(40, width - margin.left - margin.right);
    const plotH = Math.max(40, height - margin.top - margin.bottom);

    const allValues = [];
    series.forEach((s) => allValues.push(...s.values));
    let [yMin, yMax] = cfg.yDomain || extent(allValues);
    const pad = (yMax - yMin) * 0.06;
    yMin -= pad;
    yMax += pad;
    if (cfg.yDomain) {
      yMin = cfg.yDomain[0];
      yMax = cfg.yDomain[1];
    }

    const n = Math.max(...series.map((s) => s.values.length));
    const xLabels = cfg.xLabels || [];
    const xValues = cfg.xValues || null;

    const xOf = (i) => {
      if (xValues && xValues.length === n) {
        const xMin = Math.min(...xValues);
        const xMax = Math.max(...xValues);
        return margin.left + ((xValues[i] - xMin) / (xMax - xMin || 1)) * plotW;
      }
      return margin.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    };
    const yOf = (v) => margin.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    const svg = ensureSvg(el, width, height);

    // 背景
    svg.appendChild(
      node("rect", {
        x: margin.left,
        y: margin.top,
        width: plotW,
        height: plotH,
        fill: "#fbfcfe",
        stroke: "#eef2f7",
        rx: 4,
      }),
    );

    // 水平网格 + y 轴刻度
    const yTicks = niceTicks(yMin, yMax, Math.max(3, Math.min(7, Math.floor(plotH / 55))));
    yTicks.forEach((tick) => {
      const y = yOf(tick);
      if (y < margin.top - 1 || y > margin.top + plotH + 1) return;
      svg.appendChild(
        node("line", {
          x1: margin.left,
          y1: y,
          x2: margin.left + plotW,
          y2: y,
          stroke: T.PALETTE.grid,
          "stroke-width": 1,
          "stroke-dasharray": tick === 0 ? "" : "3 3",
        }),
      );
      svg.appendChild(
        node(
          "text",
          {
            x: margin.left - 8,
            y: y + 4,
            "text-anchor": "end",
            fill: T.PALETTE.muted,
            "font-size": 10,
            "font-family": "ui-monospace, Menlo, Consolas, monospace",
          },
          cfg.yFormat ? cfg.yFormat(tick) : fmt(tick),
        ),
      );
    });

    // x 轴刻度
    const tickCount = Math.max(2, Math.min(9, Math.floor(plotW / 90)));
    const step = Math.max(1, Math.floor(n / tickCount));
    for (let i = 0; i < n; i += step) {
      const x = xOf(i);
      const label = xLabels[i] !== undefined ? xLabels[i] : String(i);
      svg.appendChild(
        node("line", {
          x1: x,
          y1: margin.top + plotH,
          x2: x,
          y2: margin.top + plotH + 4,
          stroke: T.PALETTE.axis,
          "stroke-width": 1,
        }),
      );
      svg.appendChild(
        node(
          "text",
          {
            x: x,
            y: margin.top + plotH + 17,
            "text-anchor": "middle",
            fill: T.PALETTE.muted,
            "font-size": 10,
          },
          cfg.xFormat ? cfg.xFormat(label) : T.FORMAT.timeLabel(label),
        ),
      );
    }

    // 坐标轴
    svg.appendChild(
      node("line", {
        x1: margin.left,
        y1: margin.top + plotH,
        x2: margin.left + plotW,
        y2: margin.top + plotH,
        stroke: "#cbd5e1",
        "stroke-width": 1,
      }),
    );
    svg.appendChild(
      node("line", {
        x1: margin.left,
        y1: margin.top,
        x2: margin.left,
        y2: margin.top + plotH,
        stroke: "#cbd5e1",
        "stroke-width": 1,
      }),
    );

    // 标记线（如突变点、周期）
    (cfg.markers || []).forEach((marker) => {
      const x = marker.index !== undefined ? xOf(marker.index) : margin.left + (marker.ratio || 0) * plotW;
      svg.appendChild(
        node("line", {
          x1: x,
          y1: margin.top,
          x2: x,
          y2: margin.top + plotH,
          stroke: marker.color || T.PALETTE.danger,
          "stroke-width": 1.2,
          "stroke-dasharray": "5 4",
          opacity: 0.85,
        }),
      );
      if (marker.label) {
        svg.appendChild(
          node(
            "text",
            {
              x: x + 4,
              y: margin.top + 12,
              fill: marker.color || T.PALETTE.danger,
              "font-size": 10,
            },
            marker.label,
          ),
        );
      }
    });

    // 数据线
    series.forEach((s, si) => {
      const color = s.color || T.SERIES_COLORS[si % T.SERIES_COLORS.length];
      const maxPoints = 3000;
      const stride = Math.max(1, Math.ceil(s.values.length / maxPoints));
      let d = "";
      let started = false;
      for (let i = 0; i < s.values.length; i += stride) {
        const v = s.values[i];
        if (v === null || v === undefined || !isFinite(v)) {
          started = false;
          continue;
        }
        const x = xOf(i);
        const y = yOf(v);
        d += (started ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2) + " ";
        started = true;
      }

      if (s.area) {
        const gradientId = "grad-" + Math.random().toString(36).slice(2, 8);
        const defs = node("defs", {});
        const grad = node("linearGradient", { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1" });
        grad.appendChild(node("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.28 }));
        grad.appendChild(node("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0.02 }));
        defs.appendChild(grad);
        svg.appendChild(defs);
        const baseY = margin.top + plotH;
        const areaPath = d + "L" + xOf(s.values.length - 1) + " " + baseY + " L" + xOf(0) + " " + baseY + " Z";
        svg.appendChild(node("path", { d: areaPath, fill: "url(#" + gradientId + ")", stroke: "none" }));
      }

      svg.appendChild(
        node("path", {
          d: d,
          fill: "none",
          stroke: color,
          "stroke-width": s.width || 1.4,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
          "stroke-dasharray": s.dashed ? "5 4" : "",
          opacity: s.opacity === undefined ? 1 : s.opacity,
        }),
      );

      // 少量点标记
      if (s.dots) {
        for (let i = 0; i < s.values.length; i += Math.max(1, Math.floor(s.values.length / 12))) {
          const v = s.values[i];
          if (v === null || !isFinite(v)) continue;
          svg.appendChild(
            node("circle", {
              cx: xOf(i),
              cy: yOf(v),
              r: 2.6,
              fill: color,
              stroke: "#fff",
              "stroke-width": 1,
            }),
          );
        }
      }
    });

    // 图例
    if (series.length > 1) {
      let lx = margin.left + 8;
      series.forEach((s, si) => {
        const color = s.color || T.SERIES_COLORS[si % T.SERIES_COLORS.length];
        const label = s.name || "序列 " + (si + 1);
        const w = label.length * 7 + 22;
        svg.appendChild(node("line", { x1: lx, y1: 16, x2: lx + 14, y2: 16, stroke: color, "stroke-width": 2 }));
        svg.appendChild(node("text", { x: lx + 19, y: 19, fill: T.PALETTE.text, "font-size": 10 }, label));
        lx += w;
      });
    }

    // 标题与轴标题
    if (cfg.title) {
      svg.appendChild(
        node(
          "text",
          {
            x: margin.left + plotW / 2,
            y: 16,
            "text-anchor": "middle",
            fill: T.PALETTE.text,
            "font-size": 12,
            "font-weight": 600,
          },
          cfg.title,
        ),
      );
    }
    if (cfg.yLabel) {
      svg.appendChild(
        node(
          "text",
          {
            x: 12,
            y: margin.top + plotH / 2,
            "text-anchor": "middle",
            fill: T.PALETTE.muted,
            "font-size": 10,
            transform:
              "rotate(-90 12 " + (margin.top + plotH / 2) + ")",
          },
          cfg.yLabel,
        ),
      );
    }

    // 十字准线提示
    if (cfg.tooltip !== false) {
      attachTooltip(el, svg, { series, xOf, yOf, xLabels, margin, plotW, plotH, n, cfg });
    }
  }

  function attachTooltip(el, svg, ctx) {
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    const guide = node("line", {
      x1: 0,
      y1: ctx.margin.top,
      x2: 0,
      y2: ctx.margin.top + ctx.plotH,
      stroke: "#94a3b8",
      "stroke-width": 1,
      "stroke-dasharray": "4 3",
      opacity: 0,
    });
    svg.appendChild(guide);

    const tip = document.createElement("div");
    tip.className = "chart-tooltip";
    tip.style.display = "none";
    el.appendChild(tip);

    const overlay = node("rect", {
      x: ctx.margin.left,
      y: ctx.margin.top,
      width: ctx.plotW,
      height: ctx.plotH,
      fill: "transparent",
      style: "cursor:crosshair",
    });
    svg.appendChild(overlay);

    overlay.addEventListener("mousemove", (event) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = svg.viewBox.baseVal.width / (rect.width || 1);
      const px = (event.clientX - rect.left) * scaleX;
      let index = 0;
      if (ctx.n > 1) {
        // 反解最近点
        let best = Infinity;
        const stride = Math.max(1, Math.floor(ctx.n / 400));
        for (let i = 0; i < ctx.n; i += stride) {
          const d = Math.abs(ctx.xOf(i) - px);
          if (d < best) {
            best = d;
            index = i;
          }
        }
      }
      const gx = ctx.xOf(index);
      guide.setAttribute("x1", gx);
      guide.setAttribute("x2", gx);
      guide.setAttribute("opacity", 0.9);

      const rows = ctx.series
        .map((s, si) => {
          const v = s.values[index];
          if (v === null || v === undefined || !isFinite(v)) return "";
          const color = s.color || T.SERIES_COLORS[si % T.SERIES_COLORS.length];
          const name = s.name || "序列 " + (si + 1);
          return (
            '<div class="tip-row"><span class="tip-dot" style="background:' +
            color +
            '"></span><span class="tip-name">' +
            T.esc(name) +
            '</span><span class="tip-value">' +
            T.esc(fmt(v, ctx.cfg.tipDigits === undefined ? 3 : ctx.cfg.tipDigits)) +
            "</span></div>"
          );
        })
        .join("");

      const label = ctx.xLabels[index] !== undefined ? ctx.xLabels[index] : String(index);
      tip.innerHTML =
        '<div class="tip-head">' + T.esc(ctx.cfg.tipTitle ? ctx.cfg.tipTitle(label) : label) + "</div>" + rows;
      tip.style.display = "block";
      const containerRect = el.getBoundingClientRect();
      const left = (gx / svg.viewBox.baseVal.width) * containerRect.width;
      tip.style.left = Math.min(Math.max(8, left + 12), containerRect.width - 168) + "px";
      tip.style.top = "14px";
    });

    overlay.addEventListener("mouseleave", () => {
      guide.setAttribute("opacity", 0);
      tip.style.display = "none";
    });
  }

  // ------------------------------------------------------------ 散点图
  function scatter(el, cfg) {
    if (!el) return;
    el.dataset.paleoChart = "scatter";
    const render = () => drawScatter(el, cfg);
    remember(el, render);
    render();
  }

  function drawScatter(el, cfg) {
    const xs = cfg.x || [];
    const ys = cfg.y || [];
    if (!xs.length) {
      empty(el, cfg.emptyTitle || "暂无数据", "");
      return;
    }
    const { width, height } = T.measure(el);
    const margin = { top: 26, right: 18, bottom: 44, left: 60 };
    const plotW = Math.max(40, width - margin.left - margin.right);
    const plotH = Math.max(40, height - margin.top - margin.bottom);

    const [xMin, xMax] = cfg.xDomain || extent(xs);
    const [yMin, yMax] = cfg.yDomain || extent(ys);
    const padX = (xMax - xMin) * 0.06 || 1;
    const padY = (yMax - yMin) * 0.06 || 1;
    const xOf = (v) => margin.left + ((v - (xMin - padX)) / (xMax - xMin + 2 * padX)) * plotW;
    const yOf = (v) => margin.top + plotH - ((v - (yMin - padY)) / (yMax - yMin + 2 * padY)) * plotH;

    const svg = ensureSvg(el, width, height);
    svg.appendChild(
      node("rect", { x: margin.left, y: margin.top, width: plotW, height: plotH, fill: "#fbfcfe", stroke: "#eef2f7", rx: 4 }),
    );

    niceTicks(yMin - padY, yMax + padY, 5).forEach((tick) => {
      const y = yOf(tick);
      svg.appendChild(node("line", { x1: margin.left, y1: y, x2: margin.left + plotW, y2: y, stroke: T.PALETTE.grid, "stroke-dasharray": "3 3" }));
      svg.appendChild(
        node("text", { x: margin.left - 8, y: y + 4, "text-anchor": "end", fill: T.PALETTE.muted, "font-size": 10 }, fmt(tick)),
      );
    });
    niceTicks(xMin - padX, xMax + padX, 5).forEach((tick) => {
      const x = xOf(tick);
      svg.appendChild(node("line", { x1: x, y1: margin.top + plotH, x2: x, y2: margin.top + plotH + 4, stroke: T.PALETTE.axis }));
      svg.appendChild(
        node("text", { x: x, y: margin.top + plotH + 17, "text-anchor": "middle", fill: T.PALETTE.muted, "font-size": 10 }, fmt(tick)),
      );
    });

    const stride = Math.max(1, Math.ceil(xs.length / 2500));
    for (let i = 0; i < xs.length; i += stride) {
      if (!isFinite(xs[i]) || !isFinite(ys[i])) continue;
      svg.appendChild(
        node("circle", {
          cx: xOf(xs[i]),
          cy: yOf(ys[i]),
          r: 2.4,
          fill: cfg.color || T.PALETTE.primary,
          opacity: 0.55,
        }),
      );
    }

    if (cfg.fit) {
      const { slope, intercept } = cfg.fit;
      const x0 = xMin - padX;
      const x1 = xMax + padX;
      svg.appendChild(
        node("line", {
          x1: xOf(x0),
          y1: yOf(slope * x0 + intercept),
          x2: xOf(x1),
          y2: yOf(slope * x1 + intercept),
          stroke: T.PALETTE.danger,
          "stroke-width": 1.6,
          "stroke-dasharray": "6 4",
        }),
      );
    }

    if (cfg.title) {
      svg.appendChild(
        node("text", { x: margin.left + plotW / 2, y: 16, "text-anchor": "middle", fill: T.PALETTE.text, "font-size": 12, "font-weight": 600 }, cfg.title),
      );
    }
    if (cfg.xLabel) {
      svg.appendChild(
        node("text", { x: margin.left + plotW / 2, y: height - 6, "text-anchor": "middle", fill: T.PALETTE.muted, "font-size": 10 }, cfg.xLabel),
      );
    }
    if (cfg.yLabel) {
      svg.appendChild(
        node(
          "text",
          { x: 12, y: margin.top + plotH / 2, "text-anchor": "middle", fill: T.PALETTE.muted, "font-size": 10, transform: "rotate(-90 12 " + (margin.top + plotH / 2) + ")" },
          cfg.yLabel,
        ),
      );
    }
  }

  // ------------------------------------------------------------ 热力图
  function heatmap(el, cfg) {
    if (!el) return;
    el.dataset.paleoChart = "heatmap";
    const render = () => drawHeatmap(el, cfg);
    remember(el, render);
    render();
  }

  function drawHeatmap(el, cfg) {
    const x = cfg.x || [];
    const y = cfg.y || [];
    const grid = cfg.values || [];
    if (!grid.length || !grid[0] || !grid[0].length) {
      empty(el, cfg.emptyTitle || "暂无可绘制的场", "");
      return;
    }
    const { width, height } = T.measure(el);
    el.innerHTML = "";
    const canvas = document.createElement("canvas");
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    el.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const margin = { top: 30, right: 74, bottom: 42, left: 62 };
    const plotW = Math.max(40, width - margin.left - margin.right);
    const plotH = Math.max(40, height - margin.top - margin.bottom);

    const rows = grid.length;
    const cols = grid[0].length;

    let min = cfg.vmin;
    let max = cfg.vmax;
    if (min === undefined || min === null) {
      min = Infinity;
      max = -Infinity;
      for (const row of grid) {
        for (const v of row) {
          if (!isFinite(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    if (!isFinite(min) || !isFinite(max) || min === max) {
      min = isFinite(min) ? min - 1 : 0;
      max = isFinite(max) ? max + 1 : 1;
    }

    const colorAt = cfg.diverging === false ? T.sequentialColor : T.autoColor;
    const cellW = plotW / cols;
    const cellH = plotH / rows;

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const v = grid[r][c];
        if (v === null || v === undefined || !isFinite(v)) continue;
        ctx.fillStyle = colorAt(v, min, max);
        ctx.fillRect(margin.left + c * cellW, margin.top + r * cellH, Math.ceil(cellW) + 0.6, Math.ceil(cellH) + 0.6);
      }
    }

    // 网格与坐标轴
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotW, plotH);

    ctx.fillStyle = T.PALETTE.muted;
    ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    const yTicks = Math.min(6, rows);
    for (let i = 0; i <= yTicks; i += 1) {
      const idx = Math.round((i / yTicks) * (rows - 1));
      const py = margin.top + (idx + 0.5) * cellH;
      // Hovmöller 的纵轴是时间，用 yLabels（可读日期）而不是数值
      const yText = cfg.yLabels && cfg.yLabels[idx] !== undefined
        ? String(cfg.yLabels[idx]).slice(0, 10)
        : fmt(y[idx], 2);
      ctx.fillText(yText, margin.left - 6, py);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xTicks = Math.min(7, cols);
    for (let i = 0; i <= xTicks; i += 1) {
      const idx = Math.round((i / xTicks) * (cols - 1));
      const px = margin.left + (idx + 0.5) * cellW;
      const label = cfg.xLabels ? cfg.xLabels[idx] : fmt(x[idx], 1);
      ctx.fillText(String(label), px, margin.top + plotH + 7);
    }

    // 色标
    const barX = margin.left + plotW + 16;
    const barW = 12;
    const barH = plotH;
    const grad = ctx.createLinearGradient(0, margin.top + barH, 0, margin.top);
    for (let i = 0; i <= 10; i += 1) {
      grad.addColorStop(i / 10, colorAt(min + ((max - min) * i) / 10, min, max));
    }
    ctx.fillStyle = grad;
    ctx.fillRect(barX, margin.top, barW, barH);
    ctx.strokeStyle = "#cbd5e1";
    ctx.strokeRect(barX, margin.top, barW, barH);

    ctx.fillStyle = T.PALETTE.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i += 1) {
      const value = min + ((max - min) * i) / 4;
      const py = margin.top + barH - (i / 4) * barH;
      ctx.fillText(fmt(value, 2), barX + barW + 6, py);
    }

    // 标题
    if (cfg.title) {
      ctx.fillStyle = T.PALETTE.text;
      ctx.font = "600 12px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(cfg.title, margin.left + plotW / 2, 16);
    }
    if (cfg.xLabel) {
      ctx.fillStyle = T.PALETTE.muted;
      ctx.font = "10px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(cfg.xLabel, margin.left + plotW / 2, height - 8);
    }
    if (cfg.yLabel) {
      ctx.save();
      ctx.translate(14, margin.top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = T.PALETTE.muted;
      ctx.font = "10px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(cfg.yLabel, 0, 0);
      ctx.restore();
    }

    // 叠加等值线（小波影响锥等）
    if (cfg.overlay && cfg.overlay.length) {
      ctx.strokeStyle = "rgba(30,41,59,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      cfg.overlay.forEach((pair, i) => {
        if (!pair) return;
        const px = margin.left + (pair[0] + 0.5) * cellW;
        const py = margin.top + (pair[1] + 0.5) * cellH;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // 悬停提示
    const tip = document.createElement("div");
    tip.className = "chart-tooltip";
    tip.style.display = "none";
    el.appendChild(tip);
    canvas.addEventListener("mousemove", (event) => {
      const rect = canvas.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * width;
      const py = ((event.clientY - rect.top) / rect.height) * height;
      const c = Math.floor((px - margin.left) / cellW);
      const r = Math.floor((py - margin.top) / cellH);
      if (c < 0 || r < 0 || c >= cols || r >= rows) {
        tip.style.display = "none";
        return;
      }
      const v = grid[r][c];
      const xLabel = cfg.xLabels ? cfg.xLabels[c] : fmt(x[c], 2);
      tip.innerHTML =
        '<div class="tip-head">' +
        T.esc(xLabel) +
        " · " +
        T.esc(fmt(y[r], 2)) +
        '</div><div class="tip-row"><span class="tip-name">' +
        T.esc(cfg.valueLabel || "数值") +
        '</span><span class="tip-value">' +
        T.esc(fmt(v, 3)) +
        "</span></div>";
      tip.style.display = "block";
      tip.style.left = Math.min(px + 14, width - 170) + "px";
      tip.style.top = Math.max(6, py - 10) + "px";
    });
    canvas.addEventListener("mouseleave", () => {
      tip.style.display = "none";
    });
  }

  // ------------------------------------------------------------ 相关矩阵
  function matrix(el, cfg) {
    if (!el) return;
    el.dataset.paleoChart = "matrix";
    const render = () => drawMatrix(el, cfg);
    remember(el, render);
    render();
  }

  function drawMatrix(el, cfg) {
    const labels = cfg.labels || [];
    const data = cfg.matrix || [];
    if (!labels.length) {
      empty(el, "暂无相关矩阵", "");
      return;
    }
    const { width, height } = T.measure(el);
    el.innerHTML = "";
    const canvas = document.createElement("canvas");
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    el.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const margin = { top: 26, right: 20, bottom: 24, left: 92 };
    const size = Math.max(40, Math.min(width - margin.left - margin.right, height - margin.top - margin.bottom));
    const cell = size / labels.length;

    for (let r = 0; r < labels.length; r += 1) {
      for (let c = 0; c < labels.length; c += 1) {
        const v = data[r] ? data[r][c] : null;
        ctx.fillStyle = v === null || v === undefined ? "#f1f5f9" : T.divergingColor(v, -1, 1);
        ctx.fillRect(margin.left + c * cell, margin.top + r * cell, cell + 0.5, cell + 0.5);
        if (cell > 26 && v !== null && v !== undefined) {
          ctx.fillStyle = Math.abs(v) > 0.6 ? "#fff" : "#1e293b";
          ctx.font = "10px ui-monospace, monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(v.toFixed(2), margin.left + (c + 0.5) * cell, margin.top + (r + 0.5) * cell);
        }
      }
    }

    ctx.fillStyle = T.PALETTE.muted;
    ctx.font = "10px 'Segoe UI', sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    labels.forEach((label, i) => {
      ctx.fillText(String(label).slice(0, 12), margin.left - 6, margin.top + (i + 0.5) * cell);
    });
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    labels.forEach((label, i) => {
      ctx.save();
      ctx.translate(margin.left + (i + 0.5) * cell, margin.top - 6);
      ctx.rotate(-Math.PI / 4);
      ctx.fillText(String(label).slice(0, 12), 0, 0);
      ctx.restore();
    });

    if (cfg.title) {
      ctx.fillStyle = T.PALETTE.text;
      ctx.font = "600 12px 'Segoe UI', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(cfg.title, 10, 8);
    }
  }

  // ------------------------------------------------------------ 状态占位
  function empty(el, title, hint) {
    if (!el) return;
    el.innerHTML =
      '<div class="chart-empty">' +
      '<svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="#cbd5e1" stroke-width="1.5">' +
      '<path d="M3 3v18h18"/><path d="M7 16l4-8 4 4 4-10"/></svg>' +
      "<p>" +
      T.esc(title || "暂无数据") +
      "</p>" +
      (hint ? "<span>" + T.esc(hint) + "</span>" : "") +
      "</div>";
  }

  function loading(el, text) {
    if (!el) return;
    el.innerHTML =
      '<div class="chart-loading"><div class="spinner"></div><p>' +
      T.esc(text || "计算中…") +
      "</p></div>";
  }

  function error(el, message) {
    if (!el) return;
    el.innerHTML =
      '<div class="chart-error">' +
      '<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="#ef4444" stroke-width="1.6">' +
      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
      "<p>加载失败</p><span>" +
      T.esc(message || "未知错误") +
      "</span></div>";
  }

  // ------------------------------------------------------------ Hovmöller 图
  /**
   * 时间 × 空间 的热力图。
   * cfg: { x: 空间轴值, y: 时间值, yLabels: 时间标签, values: [[...]], axisLabel, ... }
   */
  function hovmoller(el, cfg) {
    if (!el) return;
    const data = Object.assign({}, cfg);
    data.xLabel = cfg.xLabel || cfg.axisLabel || "空间";
    data.yLabel = cfg.yLabel || "时间";
    heatmap(el, data);
  }

  global.PaleoChart = {
    hovmoller,
    line,
    scatter,
    heatmap,
    matrix,
    empty,
    loading,
    error,
    niceTicks,
    extent,
  };
})(window);
