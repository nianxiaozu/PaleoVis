/**
 * 分析结果渲染：把后端返回的结构转成图表 + 指标卡。
 */
(function (global) {
  "use strict";

  const T = global.PaleoTheme;
  const C = global.PaleoChart;

  function chip(label, value, tone) {
    return (
      '<div class="metric-chip' +
      (tone ? " tone-" + tone : "") +
      '"><span class="metric-label">' +
      T.esc(label) +
      '</span><span class="metric-value">' +
      T.esc(value) +
      "</span></div>"
    );
  }

  function card(title, body, extra) {
    return (
      '<section class="analysis-card">' +
      '<header class="analysis-card-head"><h3>' +
      T.esc(title) +
      "</h3>" +
      (extra || "") +
      "</header>" +
      '<div class="analysis-card-body">' +
      body +
      "</div></section>"
    );
  }

  function chartBox(id, cls) {
    return '<div class="chart-box ' + (cls || "") + '" id="' + id + '"></div>';
  }

  function metrics(items) {
    return '<div class="metric-row">' + items.join("") + "</div>";
  }

  // --------------------------------------------------------------- 功率谱
  function renderSpectrum(container, data) {
    const peaks = data.peaks || [];
    const best = peaks[0];
    container.innerHTML =
      card(
        "功率谱分析",
        metrics([
          chip("样本数", data.n),
          chip("采样步长", T.FORMAT.number(data.source.dt, 3)),
          chip("去趋势", data.detrend === "linear" ? "线性" : data.detrend === "mean" ? "去均值" : "无"),
          chip("主周期", best ? T.FORMAT.number(best.period, 2) : "—"),
          chip("显著峰", String(peaks.filter((p) => p.significant).length), "accent"),
        ]) + chartBox("psChart"),
      ) +
      card(
        "显著周期",
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>周期</th><th>功率</th><th>95% 阈值</th><th>显著性</th></tr></thead><tbody>' +
          peaks
            .map(
              (p) =>
                "<tr><td>" +
                T.FORMAT.number(p.period, 3) +
                "</td><td>" +
                T.FORMAT.number(p.power, 4) +
                "</td><td>" +
                T.FORMAT.number(p.threshold, 4) +
                "</td><td>" +
                (p.significant
                  ? '<span class="badge ok">显著</span>'
                  : '<span class="badge">—</span>') +
                "</td></tr>",
            )
            .join("") +
          "</tbody></table></div>",
        '<span class="card-hint">红噪声 (AR1) 95% 置信水平</span>',
      );

    const x = data.period;
    C.line(document.getElementById("psChart"), {
      title: "功率谱 (周期 - 功率)",
      series: [
        { name: "功率", values: data.power, color: T.PALETTE.primary, area: true },
        { name: "95% 阈值", values: data.threshold, color: T.PALETTE.danger, dashed: true, width: 1.1 },
      ],
      xValues: x,
      xFormat: (v) => T.FORMAT.number(v, 1),
      xLabels: x.map((v) => T.FORMAT.number(v, 1)),
      yLabel: "功率谱密度",
      tipTitle: (label) => "周期 " + label,
      tipDigits: 5,
    });
  }

  // --------------------------------------------------------------- 小波
  function renderWavelet(container, data) {
    const peaks = data.peaks || [];
    const best = peaks[0];
    container.innerHTML =
      card(
        "小波分析 (Morlet)",
        metrics([
          chip("样本数", data.n),
          chip("尺度范围", (data.meta.scale_range || []).join(" – ")),
          chip("主导周期", best ? T.FORMAT.number(best.period, 2) : "—"),
          chip("去趋势", data.detrend === "linear" ? "线性" : "无"),
        ]) +
          chartBox("wvChart", "tall") +
          '<p class="card-note">纵轴为周期（尺度 × 采样步长），颜色表示小波功率；黑线为影响锥边界，边界外结果受边缘效应影响。</p>',
      ) +
      card("全局小波谱", chartBox("wvGlobal"));

    C.heatmap(document.getElementById("wvChart"), {
      x: data.time_index,
      y: data.period,
      values: data.power,
      xLabels: data.time_index.map((i) => String(i)),
      xLabel: "时间索引",
      yLabel: "周期",
      title: "小波功率谱",
      valueLabel: "功率",
    });

    C.line(document.getElementById("wvGlobal"), {
      title: "全局小波谱",
      series: [{ name: "平均功率", values: data.global, color: T.PALETTE.primaryDark, area: true }],
      xValues: data.period,
      xLabels: data.period.map((v) => T.FORMAT.number(v, 1)),
      xFormat: (v) => T.FORMAT.number(v, 1),
      yLabel: "平均功率",
    });
  }

  // --------------------------------------------------------------- 周期
  function renderPeriod(container, data) {
    const peaks = data.peaks || [];
    container.innerHTML =
      card(
        "周期分析",
        metrics([
          chip("样本数", data.n),
          chip("最大熵阶数", data.meta.order),
          chip("首选周期", peaks[0] ? T.FORMAT.number(peaks[0].period, 2) : "—"),
          chip("自相关阈值", T.FORMAT.number(data.acf.confidence, 3)),
        ]) +
          '<div class="grid-2">' +
          chartBox("pdAcf") +
          chartBox("pdSpec") +
          "</div>",
      ) +
      card(
        "识别到的周期",
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>周期</th><th>谱峰强度</th></tr></thead><tbody>' +
          peaks
            .map(
              (p) =>
                "<tr><td>" + T.FORMAT.number(p.period, 3) + "</td><td>" + T.FORMAT.number(p.power, 4) + "</td></tr>",
            )
            .join("") +
          "</tbody></table></div>",
      );

    C.line(document.getElementById("pdAcf"), {
      title: "自相关函数",
      series: [{ name: "ACF", values: data.acf.value, color: T.PALETTE.accent, area: true }],
      xValues: data.acf.lag,
      xLabels: data.acf.lag.map((v) => T.FORMAT.number(v, 0)),
      xFormat: (v) => T.FORMAT.number(v, 0),
      yLabel: "相关系数",
      markers: (data.acf.peaks || []).map((p) => ({
        index: data.acf.lag.indexOf(p.lag),
        label: T.FORMAT.number(p.lag, 1),
        color: T.PALETTE.warning,
      })),
    });

    C.line(document.getElementById("pdSpec"), {
      title: "最大熵谱 (Burg)",
      series: [{ name: "功率", values: data.spectrum.power, color: T.PALETTE.primary, area: true }],
      xValues: data.spectrum.period,
      xLabels: data.spectrum.period.map((v) => T.FORMAT.number(v, 1)),
      xFormat: (v) => T.FORMAT.number(v, 1),
      yLabel: "功率",
    });
  }

  // --------------------------------------------------------------- 突变
  function renderAbrupt(container, data) {
    let html = card(
      "突变分析",
      metrics([
        chip("方法", data.method),
        chip("样本数", data.n),
      ]) + '<div class="chart-box tall" id="abMain"></div>',
    );

    if (data.mann_kendall) {
      const mk = data.mann_kendall;
      html += card(
        "Mann-Kendall 检验",
        metrics([
          chip("最终统计量 Z", T.FORMAT.number(mk.final_z, 3)),
          chip("趋势", mk.trend, mk.trend === "不显著" ? "" : "accent"),
          chip("交叉点", mk.crossings.length),
        ]) +
          '<div class="chart-box tall" id="mkChart"></div>' +
          '<p class="card-note">UF 为顺序统计量，UB 为逆序统计量；二者在置信带 (±1.96) 内的交点即潜在突变年份。</p>',
      );
    }
    if (data.sliding_t) {
      const st = data.sliding_t;
      html += card(
        "滑动 t 检验",
        metrics([
          chip("窗口", st.window),
          chip("临界值", T.FORMAT.number(st.critical, 3)),
          chip("显著点", st.extremes.filter((e) => e.significant).length, "accent"),
        ]) + '<div class="chart-box" id="stChart"></div>',
      );
    }
    if (data.pettitt) {
      const pt = data.pettitt;
      html += card(
        "Pettitt 检验",
        metrics([
          chip("突变点索引", pt.index),
          chip("统计量 U", T.FORMAT.number(pt.statistic, 2)),
          chip("p 值", T.FORMAT.number(pt.p_value, 4)),
          chip("显著性", pt.significant ? "显著" : "不显著", pt.significant ? "accent" : ""),
        ]) + '<div class="chart-box" id="ptChart"></div>',
      );
    }
    container.innerHTML = html;

    const labels = (data.source && data.source.time) || [];
    C.line(document.getElementById("abMain"), {
      title: "原始序列",
      series: [{ name: data.source.variable, values: data.values, color: T.PALETTE.primary, area: true }],
      xLabels: labels,
      yLabel: data.source.units || "",
      markers: data.pettitt
        ? [{ index: data.pettitt.index, label: "Pettitt 突变点", color: T.PALETTE.danger }]
        : [],
    });

    if (data.mann_kendall) {
      const mk = data.mann_kendall;
      C.line(document.getElementById("mkChart"), {
        title: "Mann-Kendall 统计量",
        series: [
          { name: "UF", values: mk.uf, color: T.PALETTE.primary },
          { name: "UB", values: mk.ub, color: T.PALETTE.warning },
        ],
        xLabels: labels,
        yLabel: "Z 统计量",
        markers: (mk.crossings || []).slice(0, 4).map((idx) => ({
          index: idx,
          label: labels[idx] ? T.FORMAT.timeLabel(labels[idx]) : "",
          color: T.PALETTE.danger,
        })),
      });
    }

    if (data.sliding_t) {
      const st = data.sliding_t;
      const offset = st.window;
      C.line(document.getElementById("stChart"), {
        title: "滑动 t 统计量",
        series: [{ name: "t", values: st.t, color: T.PALETTE.accent, area: true }],
        xValues: st.t.map((_, i) => i + offset),
        xLabels: st.t.map((_, i) => labels[i + offset] || String(i + offset)),
        yLabel: "t 值",
        markers: (st.extremes || [])
          .filter((item) => item.significant)
          .slice(0, 3)
          .map((item) => ({
            index: Math.max(0, item.index - offset),
            label: "t=" + T.FORMAT.number(item.t, 2),
            color: T.PALETTE.danger,
          })),
      });
    }

    if (data.pettitt) {
      C.line(document.getElementById("ptChart"), {
        title: "Pettitt 统计量 U(t)",
        series: [{ name: "U", values: data.pettitt.u, color: T.PALETTE.primaryDark, area: true }],
        xLabels: labels,
        yLabel: "U(t)",
        markers: [{ index: data.pettitt.index, label: "最大值点", color: T.PALETTE.danger }],
      });
    }
  }

  // --------------------------------------------------------------- 交叉谱
  function renderCross(container, data) {
    const peaks = data.peaks || [];
    container.innerHTML =
      card(
        "交叉谱分析",
        metrics([
          chip("变量 A", data.source.variable_a),
          chip("变量 B", data.source.variable_b),
          chip("相关系数 r", T.FORMAT.number(data.correlation.r, 3)),
          chip("p 值", T.FORMAT.number(data.correlation.p, 4)),
          chip("样本数", data.n),
        ]) +
          chartBox("csChart") +
          chartBox("csPhase"),
      ) +
      card(
        "高相干周期",
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>周期</th><th>相干值</th></tr></thead><tbody>' +
          peaks
            .map(
              (p) =>
                "<tr><td>" + T.FORMAT.number(p.period, 3) + "</td><td>" + T.FORMAT.number(p.power, 4) + "</td></tr>",
            )
            .join("") +
          "</tbody></table></div>",
      );

    C.line(document.getElementById("csChart"), {
      title: "相干谱",
      series: [{ name: "相干值", values: data.coherence, color: T.PALETTE.primary, area: true }],
      xValues: data.period,
      xLabels: data.period.map((v) => T.FORMAT.number(v, 1)),
      xFormat: (v) => T.FORMAT.number(v, 1),
      yLabel: "Coherence",
    });
    C.line(document.getElementById("csPhase"), {
      title: "相位谱",
      series: [{ name: "相位", values: data.phase, color: T.PALETTE.warning }],
      xValues: data.period,
      xLabels: data.period.map((v) => T.FORMAT.number(v, 1)),
      xFormat: (v) => T.FORMAT.number(v, 1),
      yLabel: "相位 (°)",
    });
  }

  // --------------------------------------------------------------- EEMD
  function renderEemd(container, data) {
    const blocks = (data.imfs || [])
      .map(
        (imf, i) =>
          card(
            "IMF " + (i + 1),
            '<div class="chart-box compact" id="imf-' +
              i +
              '"></div>' +
              '<span class="card-hint">方差贡献 ' +
              T.FORMAT.number((data.variance_ratio[i] || 0) * 100, 1) +
              "%</span>",
          ),
      )
      .join("");

    container.innerHTML =
      card(
        "经验模态分解 (EEMD)",
        metrics([
          chip("样本数", data.n),
          chip("IMF 个数", data.imf_count),
          chip("噪声比", data.meta.noise),
          chip("集合次数", data.meta.trials),
        ]) +
          '<div class="chart-box" id="eemdOriginal"></div>',
      ) +
      '<div class="imf-grid">' +
      blocks +
      "</div>" +
      card("残差趋势", '<div class="chart-box" id="eemdResidue"></div>');

    const labels = (data.source && data.source.time) || [];
    C.line(document.getElementById("eemdOriginal"), {
      title: "原始序列",
      series: [{ name: "原始", values: data.values, color: T.PALETTE.primary, area: true }],
      xLabels: labels,
      yLabel: data.source.units || "",
    });
    (data.imfs || []).forEach((imf, i) => {
      C.line(document.getElementById("imf-" + i), {
        series: [{ name: "IMF" + (i + 1), values: imf, color: T.SERIES_COLORS[(i + 1) % T.SERIES_COLORS.length] }],
        xLabels: labels,
        margin: { top: 12, right: 12, bottom: 24, left: 46 },
        tooltip: false,
      });
    });
    C.line(document.getElementById("eemdResidue"), {
      title: "残差",
      series: [{ name: "残差", values: data.residue, color: T.PALETTE.muted, area: true }],
      xLabels: labels,
    });
  }

  // --------------------------------------------------------------- 相关
  function renderCorrelation(container, data) {
    const r = data.r;
    const strength = Math.abs(r) > 0.7 ? "强" : Math.abs(r) > 0.4 ? "中等" : "弱";
    const direction = r >= 0 ? "正" : "负";
    const best = data.lag && data.lag.best;
    container.innerHTML =
      card(
        "相关性分析",
        metrics([
          chip("方法", data.method.toUpperCase()),
          chip("相关系数 r", T.FORMAT.number(r, 4), r >= 0 ? "accent" : "warn"),
          chip("决定系数 R²", T.FORMAT.number(data.r2, 4)),
          chip("p 值", T.FORMAT.number(data.p, 5)),
          chip("强度", strength + direction + "相关"),
          chip("最佳滞后", best ? best[0] + " (" + T.FORMAT.number(best[1], 3) + ")" : "—"),
        ]) +
          '<div class="grid-2">' +
          chartBox("corrScatter") +
          chartBox("corrLag") +
          "</div>",
      );

    C.scatter(document.getElementById("corrScatter"), {
      x: data.scatter.x,
      y: data.scatter.y,
      fit: data.fit,
      title: "散点与线性拟合",
      xLabel: (data.source && data.source.variable_a) || "序列 A",
      yLabel: (data.source && data.source.variable_b) || "序列 B",
      color: T.PALETTE.primary,
    });

    C.line(document.getElementById("corrLag"), {
      title: "滞后相关",
      series: [{ name: "r(lag)", values: data.lag.values, color: T.PALETTE.accent, dots: true }],
      xValues: data.lag.lags,
      xLabels: data.lag.lags.map((v) => String(v)),
      xFormat: (v) => String(v),
      yLabel: "相关系数",
      markers: best ? [{ ratio: (best[0] - data.lag.lags[0]) / Math.max(1, data.lag.lags.length - 1), label: "最佳滞后", color: T.PALETTE.warning }] : [],
    });
  }

  // --------------------------------------------------------------- 对比
  function renderCompare(container, data) {
    const labels = data.labels || [];
    const series = labels.map((name, i) => ({
      name: name,
      values: data.curves[name],
      color: T.SERIES_COLORS[i % T.SERIES_COLORS.length],
      width: 1.2,
    }));
    container.innerHTML =
      card(
        "多序列对比",
        metrics([
          chip("序列数", labels.length),
          chip("公共长度", data.n),
          chip("标准化", data.normalize ? "是" : "否"),
        ]) +
          '<div class="chart-box tall" id="cmpChart"></div>' +
          '<div class="legend-row" id="cmpLegend"></div>',
      ) +
      card(
        "相关矩阵",
        '<div class="chart-box tall" id="cmpMatrix"></div>',
      ) +
      card(
        "统计摘要",
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>序列</th><th>均值</th><th>标准差</th><th>最小</th><th>最大</th><th>样本数</th></tr></thead><tbody>' +
          labels
            .map((name) => {
              const s = data.summary[name] || {};
              return (
                "<tr><td>" +
                T.esc(name) +
                "</td><td>" +
                T.FORMAT.number(s.mean, 3) +
                "</td><td>" +
                T.FORMAT.number(s.std, 3) +
                "</td><td>" +
                T.FORMAT.number(s.min, 3) +
                "</td><td>" +
                T.FORMAT.number(s.max, 3) +
                "</td><td>" +
                s.n +
                "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table></div>",
      );

    C.line(document.getElementById("cmpChart"), {
      title: data.normalize ? "标准化序列对比" : "序列对比",
      series: series,
      yLabel: data.normalize ? "z-score" : "",
      tooltip: true,
    });
    C.matrix(document.getElementById("cmpMatrix"), {
      labels: labels,
      matrix: data.matrix,
      title: "Pearson 相关矩阵",
    });
  }

  // --------------------------------------------------------------- 分发
  const RENDERERS = {
    "power-spectrum": renderSpectrum,
    wavelet: renderWavelet,
    period: renderPeriod,
    "abrupt-change": renderAbrupt,
    "cross-spectrum": renderCross,
    eemd: renderEemd,
    correlation: renderCorrelation,
    compare: renderCompare,
  };

  global.PaleoAnalysis = {
    render(tool, container, data) {
      const fn = RENDERERS[tool];
      if (!fn) {
        container.innerHTML = '<div class="chart-empty"><p>未知的分析类型</p></div>';
        return;
      }
      container.innerHTML = "";
      fn(container, data);
    },
    has: (tool) => Boolean(RENDERERS[tool]),
  };
})(window);
