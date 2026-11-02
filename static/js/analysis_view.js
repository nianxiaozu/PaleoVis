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
  const SPECTRUM_METHOD_LABELS = {
    periodogram: "周期图",
    redfit: "红噪声频谱",
    mtm: "多窗口谱",
  };

  function renderSpectrum(container, data) {
    const state = global.PaleoState || {};
    const params = state.spectrum || {};
    const meta = data.meta || {};
    const peaks = data.peaks || [];
    const best = peaks[0];
    const method = meta.method || params.method || "periodogram";
    const methodLabel = SPECTRUM_METHOD_LABELS[method] || method;
    const confidence = Math.round((meta.confidence || params.confidence || 0.95) * 100);
    const xScale = params.xScale === "log" ? "log" : "linear";
    const panel = global.PaleoParamPanel;

    const detail = [];
    if (meta.dof) detail.push("自由度 " + T.FORMAT.number(meta.dof, 2));
    if (meta.bandwidth) detail.push("带宽 " + T.FORMAT.number(meta.bandwidth, 4));
    if (meta.lag1 !== undefined && meta.lag1 !== null) detail.push("AR1 " + T.FORMAT.number(meta.lag1, 3));
    if (method === "redfit" && meta.segments) detail.push("分段 " + meta.segments);
    if (method === "redfit") {
      detail.push(meta.mctest ? "蒙特卡洛检验 (" + (meta.nsim || 0) + " 次)" : "红噪声解析检验");
      if (meta.threshold_fallback) detail.push("该参数下 REDFIT 阈值退化，已改用 AR(1) 解析阈值");
    }

    container.innerHTML =
      (panel ? panel.renderSpectrumPanel(data) : "") +
      card(
        "功率谱分析",
        metrics([
          chip("样本数", data.n),
          chip("采样步长", T.FORMAT.number(data.source.dt, 3)),
          chip("方法", methodLabel),
          chip("主周期", best ? T.FORMAT.number(best.period, 2) : "—"),
          chip("显著性水平", confidence + "%"),
          chip("计算引擎", meta.engine == "easyclimate" ? "easyclimate" : "内置引擎")
        ]) + chartBox("psChart") + (detail.length ? '<p class="card-note">' + detail.join(" · ") + "</p>" : ""),
      ) +
      card(
        "显著周期",
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>周期</th><th>功率</th><th>' +
        confidence +
        '% 阈值</th><th>显著性</th></tr></thead><tbody>' +
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
        '<span class="card-hint">' + T.esc(methodLabel) + " · 红噪声 (AR1) " + confidence + "% 置信水平</span>",
      );

    const x = data.period;
    C.line(document.getElementById("psChart"), {
      title: "功率谱 (" + methodLabel + " · 周期 - 功率)",
      series: [
        { name: "功率", values: data.power, color: T.PALETTE.primary, area: true },
        {
          name: confidence + "% 阈值",
          values: data.threshold,
          color: T.PALETTE.danger,
          dashed: true,
          width: 1.1,
        },
      ],
      xValues: x,
      xScale: xScale,
      xFormat: (v) => T.FORMAT.number(v, 1),
      xLabels: x.map((v) => T.FORMAT.number(v, 1)),
      yLabel: "功率谱密度",
      tipTitle: (label) => "周期 " + label,
      tipDigits: 5,
    });
    if (panel) panel.bindSpectrumPanel();
  }

  // --------------------------------------------------------------- 小波
  // 影响锥：把每个时刻的可信尺度上限映射成热力图的行索引
  function coneOverlay(coi, period) {
    if (!coi || !coi.length || !period || !period.length) return [];
    return coi.map((value, col) => {
      let row = period.length - 1;
      for (let i = 0; i < period.length; i += 1) {
        if (period[i] > value) {
          row = Math.max(0, i - 1);
          break;
        }
      }
      return [col, row];
    });
  }

  function waveletDisplay() {
    const s = (global.PaleoState && global.PaleoState.wavelet) || {};
    return {
      xScale: s.xScale === "log" ? "log" : "linear",
      yScale: s.yScale === "log" ? "log" : "linear",
      showContour: s.showContour !== false,
      showCone: s.showCone !== false,
    };
  }

  function renderWavelet(container, data) {
    const peaks = data.peaks || [];
    const best = peaks[0];
    const meta = data.meta || {};
    const range = meta.scale_range || [];
    const confidence = meta.confidence ? Math.round(meta.confidence * 100) : 95;
    const panel = global.PaleoParamPanel;
    const view = waveletDisplay();
    const motherLabel = ({ morlet: "Morlet", paul: "Paul", dog: "DOG" })[
      String(meta.mother || "morlet").toLowerCase()
    ] || String(meta.mother || "morlet");
    container.innerHTML =
      (panel ? panel.renderWaveletPanel(data) : "") +
      card(
        "小波分析 (" + motherLabel + ")",
        metrics([
          chip("样本数", data.n),
          chip("周期范围", range.length ? range.map((v) => T.FORMAT.number(v, 1)).join(" – ") : "—"),
          chip("主导周期", best ? T.FORMAT.number(best.period, 2) : "—"),
          chip("显著水平", confidence + "%"),
          chip("计算引擎", meta.engine == "easyclimate" ? "easyclimate" : "内置引擎")
        ]) +
        chartBox("wvChart", "tall") +
        '<p class="card-note">纵轴为周期，颜色表示小波功率；' +
        (view.showCone ? "黑色实线为影响锥边界，锥外受边缘效应影响；" : "") +
        (view.showContour
          ? "红色轮廓为 " + confidence + "% 显著性区域（相对 AR(1) 红噪声背景，功率/阈值 = 1 的等值线）。"
          : "") +
        "</p>",
      ) +
      card("全局小波谱", chartBox("wvGlobal"));

    const overlays = [];
    if (view.showCone) {
      const cone = coneOverlay(data.coi, data.period);
      if (cone.length) overlays.push({ pairs: cone, color: "rgba(15,23,42,0.75)", width: 1.4 });
    }
    // 显著性：在「功率 / 显著性阈值」比值场上取 level=1 的等值线，得到真正的区域边界
    const contours = [];
    if (view.showContour && data.significance && data.significance.length) {
      contours.push({
        level: 1,
        values: data.significance,
        color: "rgba(220,38,38,0.95)",
        width: 2,
        halo: "rgba(255,255,255,0.75)",
      });
    }

    C.heatmap(document.getElementById("wvChart"), {
      x: data.time_index,
      y: data.period,
      values: data.power,
      xLabels: data.time_index.map((i) => String(i)),
      xLabel: "时间索引",
      yLabel: "周期",
      title: "小波功率谱",
      valueLabel: "功率",
      overlays: overlays,
      contours: contours,
      rowScale: view.xScale === "log" ? "log" : "linear",
    });

    const series = [{
      name: "平均功率",
      values: data.global,
      color: T.PALETTE.primaryDark,
      area: true,
    }];
    if (data.global_signif && data.global_signif.length === data.global.length) {
      series.push({
        name: confidence + "% 显著性阈值",
        values: data.global_signif,
        color: T.PALETTE.warning,
        dashed: true,
      });
    }

    C.line(document.getElementById("wvGlobal"), {
      title: "全局小波谱",
      series: series,
      xValues: data.period,
      xLabels: data.period.map((v) => T.FORMAT.number(v, 1)),
      xFormat: (v) => T.FORMAT.number(v, 1),
      xScale: view.xScale,
      yScale: view.yScale,
      yLabel: "平均功率",
    });
    if (panel) panel.bindWaveletPanel();
  }

  // --------------------------------------------------------------- 周期
  function periodDisplay() {
    const p = (global.PaleoState && global.PaleoState.period) || {};
    return { xScale: p.xScale === "linear" ? "linear" : "log" };
  }

  function renderPeriod(container, data) {
    const peaks = data.peaks || [];
    const acf = data.acf || {};
    const spectrum = data.spectrum || {};
    const meta = data.meta || {};
    const panel = global.PaleoParamPanel;
    const display = periodDisplay();
    const level = acf.level || meta.confidence || 0.95;
    const levelText = T.FORMAT.number(level * 100, 0) + "%";
    const bound = acf.bound || [];
    const nAcf = (acf.value || []).length;

    container.innerHTML =
      (panel && panel.renderPeriodPanel ? panel.renderPeriodPanel(data) : "") +
      card(
        "周期分析",
        metrics([
          chip("样本数", data.n),
          chip("最大熵阶数", meta.order),
          chip("首选周期", peaks[0] ? T.FORMAT.number(peaks[0].period, 2) : "—"),
          chip("红噪声 AR(1)", T.FORMAT.number(acf.rho, 3)),
          chip("自相关阈值", T.FORMAT.number(acf.confidence, 3)),
          chip("显著性水平", levelText, "ok"),
        ]) +
        '<div class="grid-2">' +
        chartBox("pdAcf") +
        chartBox("pdSpec") +
        "</div>" +
        '<p class="card-hint">虚线为 AR(1) 红噪声在 ' +
        T.esc(levelText) +
        " 置信水平下的显著性阈值（自相关用 Bartlett 标准误，最大熵谱用卡方分位数）。</p>",
      ) +
      card(
        "识别到的周期",
        '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        "<th>周期</th><th>谱峰强度</th><th>阈值</th><th>显著性</th>" +
        "</tr></thead><tbody>" +
        (peaks.length
          ? peaks
            .map(
              (p) =>
                "<tr><td>" +
                T.FORMAT.number(p.period, 3) +
                "</td><td>" +
                T.FORMAT.number(p.power, 4) +
                '</td><td>' +
                T.FORMAT.number(p.threshold, 4) +
                "</td><td>" +
                (p.significant
                  ? '<span class="badge ok">显著</span>'
                  : '<span class="badge">—</span>') +
                "</td></tr>",
            )
            .join("")
          : '<tr><td colspan="4">未识别到明显周期</td></tr>') +
        "</tbody></table></div>",
      );

    const acfSeries = [
      { name: "ACF", values: acf.value, color: T.PALETTE.accent, area: true },
    ];
    if (bound.length === nAcf) {
      acfSeries.push({
        name: levelText + " 置信上界",
        values: bound,
        color: T.PALETTE.danger,
        dashed: true,
        width: 1.2,
      });
      acfSeries.push({
        name: levelText + " 置信下界",
        values: bound.map((v) => -v),
        color: T.PALETTE.danger,
        dashed: true,
        width: 1.2,
      });
    }
    C.line(document.getElementById("pdAcf"), {
      title: "自相关函数",
      series: acfSeries,
      xValues: acf.lag,
      xLabels: (acf.lag || []).map((v) => T.FORMAT.number(v, 0)),
      xFormat: (v) => T.FORMAT.number(v, 0),
      yLabel: "相关系数",
      yDomain: [-1, 1],
      markers: (acf.peaks || [])
        .filter((p) => p.significant)
        .slice(0, 4)
        .map((p) => ({
          index: (acf.lag || []).indexOf(p.lag),
          label: T.FORMAT.number(p.lag, 1),
          color: T.PALETTE.warning,
        })),
    });

    const specSeries = [
      { name: "功率", values: spectrum.power, color: T.PALETTE.primary, area: true },
    ];
    if ((spectrum.threshold || []).length === (spectrum.power || []).length) {
      specSeries.push({
        name: levelText + " 红噪声阈值",
        values: spectrum.threshold,
        color: T.PALETTE.danger,
        dashed: true,
        width: 1.4,
      });
    }
    C.line(document.getElementById("pdSpec"), {
      title: "最大熵谱 (Burg)",
      series: specSeries,
      xValues: spectrum.period,
      xLabels: (spectrum.period || []).map((v) => T.FORMAT.number(v, 1)),
      xFormat: (v) => T.FORMAT.number(v, 1),
      yLabel: "功率",
      // 周期轴用对数刻度：Burg 谱在长周期端分辨率高、短周期端密集，线性轴会把峰全挤到一端
      xScale: display.xScale,
    });

    if (panel && panel.bindPeriodPanel) panel.bindPeriodPanel();
  }

  // --------------------------------------------------------------- 突变
  function renderAbrupt(container, data) {
    const panel = global.PaleoParamPanel;
    let html = (panel && panel.renderAbruptPanel ? panel.renderAbruptPanel(data) : "")
    if (data.mann_kendall) {
      const mk = data.mann_kendall;
      html += card(
        "Mann-Kendall 检验",
        metrics([
          chip("统计量 Z", T.FORMAT.number(mk.final_z, 3)),
          chip("趋势", mk.trend, mk.trend === "不显著" ? "" : "accent"),
          chip("p 值", mk.p_value == null ? "—" : T.FORMAT.number(mk.p_value, 4)),
          chip("Sen 斜率", mk.slope == null ? "—" : T.FORMAT.number(mk.slope, 5)),
          chip("交叉点", mk.crossings.length),
        ]) +
        '<div class="chart-box tall" id="mkChart"></div>' +
        '<p class="card-note">UF 为顺序统计量曲线，UB 为逆序统计量曲线；二者在置信带 (±1.96) 内的交点即潜在突变点，虚线为突变点位置。趋势判定与 Sen 斜率由 easyclimate 的 Mann-Kendall 检验给出。</p>',
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

    if (data.mann_kendall) {
      const mk = data.mann_kendall;
      // 交叉点可能很多且集中，只保留最靠前的几个，标签简化为序号
      const markers = (mk.crossings || []).slice(0, 10).map((idx, i) => ({
        index: idx,
        label: "交叉" + (i + 1),
        color: T.PALETTE.danger,
      }));
      if (mk.mutation_index != null && !markers.some((m) => m.index === mk.mutation_index)) {
        markers.unshift({
          index: mk.mutation_index,
          label: "突变点",
          color: T.PALETTE.primaryDark,
        });
      }
      C.line(document.getElementById("mkChart"), {
        title: "Mann-Kendall 统计量",
        series: [
          { name: "UF", values: mk.uf, color: T.PALETTE.primary },
          { name: "UB", values: mk.ub, color: T.PALETTE.warning },
        ],
        xLabels: labels,
        yLabel: "Z 统计量",
        markers: markers,
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
          .slice(0, 10)
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
    if (panel && panel.bindAbruptPanel) panel.bindAbruptPanel();
  }

  // --------------------------------------------------------------- 交叉谱
  /** 「变量 A/B」chip 的文案：跨文件时带上文件名，同文件时只显示变量名。 */
  function pairLabel(source, side) {
    const variable = source["variable_" + side] || "—";
    const file = source["file_name_" + side];
    if (!file) return variable;
    return variable + " · " + file;
  }

  /** 两个数据的时间轴对齐信息（跨文件时才有意义）。 */
  function alignChip(source) {
    const align = source && source.align;
    if (!align || !align.overlap) return "";
    return chip(
      "公共时次",
      align.overlap + " / " + (align.n_a || "?") + " · " + (align.n_b || "?"),
    );
  }

  function renderCross(container, data) {
    const peaks = data.peaks || [];
    const panel = global.PaleoParamPanel;
    container.innerHTML =
      (panel && panel.renderVariablePanel ? panel.renderVariablePanel(data, {
        title: "交叉谱分析",
        badge: "两个数据 · 相位/相干",
      }) : "") +
      card(
        "交叉谱分析",
        metrics([
          chip("变量 A", pairLabel(data.source, "a")),
          chip("变量 B", pairLabel(data.source, "b")),
          chip("相关系数 r", T.FORMAT.number(data.correlation.r, 3)),
          chip("p 值", T.FORMAT.number(data.correlation.p, 4)),
          chip("样本数", data.n),
          alignChip(data.source),
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

    if (panel && panel.bindVariablePanel)
      panel.bindVariablePanel({
        title: "交叉谱分析",
      });
  }

  // --------------------------------------------------------------- EEMD
  /** EEMD 分量的「写入数据文件」按钮，data-component 供事件绑定识别。 */
  function eemdExportButton(component) {
    return (
      '<button class="btn-ghost eemd-export" data-component="' +
      T.esc(component) +
      '" title="把该分量写入数据文件">存入文件</button>'
    );
  }

  /** 把单个 EEMD 分量以 NetCDF 写入服务端数据文件，随后刷新文件列表。 */
  function bindEemdExport() {
    document.querySelectorAll(".eemd-export").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const component = btn.dataset.component;
        const api = global.PaleoAPI;
        const state = global.PaleoState;
        if (!api || !state || !state.currentFileId) return;
        const label = component === "residue" ? "残差" : "IMF " + component.replace(/[^0-9]/g, "");
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = "写入中…";
        try {
          const body = state.body(
            state.eemdBody({ format: "netcdf", target: "library", component: component }),
          );
          const result = await api.eemdExport(state.currentFileId, body);
          const name = (result && result.file && result.file.name) || "数据文件";
          if (global.PaleoApp && global.PaleoApp.toast) {
            global.PaleoApp.toast("已写入 " + label + "：" + name, "success");
          }
          if (global.PaleoApp && global.PaleoApp.reloadFiles) global.PaleoApp.reloadFiles();
        } catch (err) {
          if (global.PaleoApp && global.PaleoApp.toast) {
            global.PaleoApp.toast("写入失败：" + err.message, "error");
          }
        } finally {
          btn.disabled = false;
          btn.textContent = oldText;
        }
      });
    });
  }

  function downloadText(text, filename) {
    const blob = new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

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
            eemdExportButton("imf" + (i + 1)),
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
          chip("噪声宽度", T.FORMAT.number(data.meta.noise_width, 4)),
          chip("集合次数", data.meta.trials),
          chip("引擎", data.meta.engine === "easyclimate" ? "easyclimate" : "内置"),
        ]) +
        '<div class="chart-box" id="eemdOriginal"></div>',
      ) +
      '<div class="imf-grid">' +
      blocks +
      "</div>" +
      card(
        "残差趋势",
        '<div class="chart-box" id="eemdResidue"></div>',
        eemdExportButton("residue"),
      );

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
    bindEemdExport();
  }

  // --------------------------------------------------------------- 相关
  function renderCorrelation(container, data) {
    const r = data.r;
    const strength = Math.abs(r) > 0.7 ? "强" : Math.abs(r) > 0.4 ? "中等" : "弱";
    const direction = r >= 0 ? "正" : "负";
    const best = data.lag && data.lag.best;
    const panel = global.PaleoParamPanel;
    container.innerHTML =
      (panel && panel.renderVariablePanel ? panel.renderVariablePanel(data, {
        title: "相关性分析",
        badge: "两个数据 · 相关/滞后",
      }) : "") +
      card(
        "相关性分析",
        metrics([
          chip("变量 A", pairLabel(data.source, "a")),
          chip("变量 B", pairLabel(data.source, "b")),
          chip("方法", data.method.toUpperCase()),
          chip("相关系数 r", T.FORMAT.number(r, 4), r >= 0 ? "accent" : "warn"),
          chip("决定系数 R²", T.FORMAT.number(data.r2, 4)),
          chip("p 值", T.FORMAT.number(data.p, 5)),
          chip("强度", strength + direction + "相关"),
          chip("最佳滞后", best ? best[0] + " (" + T.FORMAT.number(best[1], 3) + ")" : "—"),
          alignChip(data.source),
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
      xLabel: (data.source && pairLabel(data.source, "a")) || "序列 A",
      yLabel: (data.source && pairLabel(data.source, "b")) || "序列 B",
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

    if (panel && panel.bindVariablePanel) panel.bindVariablePanel({ title: "相关性分析" });
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
    const source = data.source || {};
    const panel = global.PaleoParamPanel;
    container.innerHTML =
      (panel && panel.renderComparePanel ? panel.renderComparePanel(data) : "") +
      card(
        "多序列对比",
        metrics([
          chip("序列数", labels.length),
          chip("公共长度", data.n),
          chip("标准化", data.normalize ? "是" : "否"),
          alignChip(source),
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
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>序列</th><th>单位</th><th>均值</th><th>标准差</th><th>最小</th><th>最大</th><th>样本数</th></tr></thead><tbody>' +
        labels
          .map((name) => {
            const s = data.summary[name] || {};
            const meta = (data.series_meta && data.series_meta[name]) || {};
            return (
              "<tr><td>" +
              T.esc(name) +
              "</td><td>" +
              T.esc(meta.units || "—") +
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

    if (panel && panel.bindComparePanel) panel.bindComparePanel();
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
