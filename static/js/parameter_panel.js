/**
 * 参数面板：图表视图的序列预处理面板 + 各分析视图的参数面板。
 *
 * 面板只负责「渲染 DOM + 收集输入」，真正的取数/重算通过 init() 注入的回调完成，
 * 这样面板不依赖 app.js 的私有函数，后续新增分析只需在此追加 renderXxxPanel。
 */
(function (global) {
  "use strict";

  const T = global.PaleoTheme;
  const state = global.PaleoState;

  /** app.js 注入的私有回调 */
  const hooks = {
    fetchSeries: null,
    toast: null,
    rerunAnalysis: null,
    rerenderAnalysis: null,
    rerunCompare: null,
  };

  function init(options) {
    Object.assign(hooks, options || {});
  }

  function toast(message, type) {
    if (hooks.toast) hooks.toast(message, type);
  }

  // =========================================================== 通用小工具
  function option(value, label, current) {
    return (
      '<option value="' + value + '"' + (value === current ? " selected" : "") + ">" + label + "</option>"
    );
  }

  function select(id, items, current) {
    return (
      '<select id="' + id + '">' +
      items.map((it) => option(it.value, it.label, current)).join("") +
      "</select>"
    );
  }

  function numInput(id, value, opts) {
    const o = opts || {};
    let html = '<input type="number" id="' + id + '"';
    if (o.min !== undefined) html += ' min="' + o.min + '"';
    if (o.max !== undefined) html += ' max="' + o.max + '"';
    html += ' step="' + (o.step === undefined ? 1 : o.step) + '"';
    if (o.title) html += ' title="' + T.esc(o.title) + '"';
    if (o.placeholder) html += ' placeholder="' + T.esc(o.placeholder) + '"';
    html += ' value="' + (value === null || value === undefined || value === "" ? "" : value) + '" />';
    return html;
  }

  function field(label, control, hint, cls) {
    return (
      '<div class="pre-field' + (cls ? " " + cls : "") + '">' +
      "<label>" + T.esc(label) + "</label>" +
      control +
      (hint ? '<span class="pre-hint">' + T.esc(hint) + "</span>" : "") +
      "</div>"
    );
  }

  function readNumber(id, fallback) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    const raw = String(el.value || "").trim();
    if (!raw) return fallback;
    const v = Number(raw);
    return isFinite(v) ? v : fallback;
  }

  // =========================================================== 序列预处理面板
  function renderPreprocessPanel(pre) {
    const p = state.preprocess;
    const applied = pre && pre.applied;
    const steps = (pre && pre.steps) || [];
    const filterOn = p.filter && p.filter !== "none";
    const needMin = p.filter === "lowpass" || p.filter === "bandpass";
    const needMax = p.filter === "highpass" || p.filter === "bandpass";
    return (
      '<section class="preprocess-panel" id="preprocessPanel">' +
      '<header class="preprocess-head">' +
      "<h3>序列预处理</h3>" +
      (applied
        ? '<span class="pre-badge on">已应用：' + T.esc(steps.join(" · ")) + "</span>"
        : '<span class="pre-badge">未启用</span>') +
      "</header>" +
      '<div class="preprocess-body">' +
      // 去趋势
      '<div class="pre-field">' +
      '<label for="preDetrend">去趋势</label>' +
      '<select id="preDetrend">' +
      '<option value="none"' + (p.detrend === "none" ? " selected" : "") + ">不处理</option>" +
      '<option value="linear"' + (p.detrend === "linear" ? " selected" : "") + ">线性去趋势</option>" +
      '<option value="mean"' + (p.detrend === "mean" ? " selected" : "") + ">去均值</option>" +
      "</select>" +
      "</div>" +
      // 标准化
      '<div class="pre-field">' +
      '<label for="preStandardize">标准化</label>' +
      '<label class="pre-switch">' +
      '<input type="checkbox" id="preStandardize"' + (p.standardize ? " checked" : "") + " />" +
      "<span>z-score（均值 0，标准差 1）</span>" +
      "</label>" +
      "</div>" +
      // 滤波
      '<div class="pre-field">' +
      '<label for="preFilter">滤波</label>' +
      '<select id="preFilter">' +
      '<option value="none"' + (!filterOn ? " selected" : "") + ">不滤波</option>" +
      '<option value="lowpass"' + (p.filter === "lowpass" ? " selected" : "") + ">低通滤波</option>" +
      '<option value="highpass"' + (p.filter === "highpass" ? " selected" : "") + ">高通滤波</option>" +
      '<option value="bandpass"' + (p.filter === "bandpass" ? " selected" : "") + ">带通滤波</option>" +
      "</select>" +
      "</div>" +
      // 滤波时段
      '<div class="pre-field pre-periods"' + (filterOn ? "" : ' style="display:none"') + ">" +
      '<label>滤波时段（周期，与时间轴同单位）</label>' +
      '<div class="pre-period-row">' +
      (needMin
        ? '<input type="number" id="prePeriodMin" min="0" step="0.5" placeholder="最短周期" value="' +
        (p.filter_period_min || "") + '" />'
        : "") +
      (needMax
        ? '<input type="number" id="prePeriodMax" min="0" step="0.5" placeholder="最长周期" value="' +
        (p.filter_period_max || "") + '" />'
        : "") +
      '<label>阶数:</label>' +
      '<input type="number" id="preOrder" min="1" max="8" step="1" title="Butterworth 阶数" value="' +
      (p.order || 4) +
      '" />' +
      "</div>" +
      "</div>" +
      // 操作
      '<div class="pre-actions">' +
      '<button class="btn-primary pre-apply" id="preApplyBtn">应用预处理</button>' +
      '<button class="pre-reset" id="preResetBtn">重置</button>' +
      "</div>" +
      "</div>" +
      "</section>"
    );
  }

  function bindPreprocessPanel() {
    const detrendEl = document.getElementById("preDetrend");
    const stdEl = document.getElementById("preStandardize");
    const filterEl = document.getElementById("preFilter");
    const applyBtn = document.getElementById("preApplyBtn");
    const resetBtn = document.getElementById("preResetBtn");
    if (!applyBtn) return;

    // 切换滤波类型时动态显示需要的时段输入框
    filterEl.addEventListener("change", () => {
      state.preprocess.filter = filterEl.value;
      const panel = document.getElementById("preprocessPanel");
      if (panel) {
        panel.outerHTML = renderPreprocessPanel(state.series && state.series.preprocess);
        bindPreprocessPanel();
      }
    });

    detrendEl.addEventListener("change", () => {
      state.preprocess.detrend = detrendEl.value;
    });
    stdEl.addEventListener("click", () => {
      state.preprocess.standardize = stdEl.checked;
    });
    applyBtn.addEventListener("click", async () => {
      state.preprocess.detrend = detrendEl.value;
      state.preprocess.standardize = stdEl.checked;
      state.preprocess.filter = filterEl.value;
      const minEl = document.getElementById("prePeriodMin");
      const maxEl = document.getElementById("prePeriodMax");
      const orderEl = document.getElementById("preOrder");
      state.preprocess.filter_period_min = minEl && minEl.value ? Number(minEl.value) : null;
      state.preprocess.filter_period_max = maxEl && maxEl.value ? Number(maxEl.value) : null;
      state.preprocess.order = orderEl && orderEl.value ? Number(orderEl.value) : 4;

      // 参数校验
      const p = state.preprocess;
      if (p.filter === "bandpass") {
        if (!p.filter_period_min || !p.filter_period_max) {
          toast("带通滤波需要同时填写最短与最长周期", "warn");
          return;
        }
        if (p.filter_period_min >= p.filter_period_max) {
          toast("最短周期必须小于最长周期", "warn");
          return;
        }
      }
      if (p.filter === "lowpass" && !p.filter_period_min) {
        toast("低通滤波需要填写截止周期", "warn");
        return;
      }
      if (p.filter === "highpass" && !p.filter_period_max) {
        toast("高通滤波需要填写截止周期", "warn");
        return;
      }
      if (hooks.fetchSeries) await hooks.fetchSeries({ silent: true });
    });

    resetBtn.addEventListener("click", async () => {
      state.preprocess = {
        detrend: "none",
        standardize: false,
        filter: "none",
        filter_period_min: null,
        filter_period_max: null,
        order: 4,
      };
      if (hooks.fetchSeries) await hooks.fetchSeries({ silent: true });
      toast("已重置预处理", "success");
    });
  }

  // =========================================================== 功率谱参数面板
  const SPECTRUM_METHODS = [
    { value: "periodogram", label: "Periodogram" },
    { value: "redfit", label: "REDFIT" },
    { value: "mtm", label: "MTM" },
  ];

  const SPECTRUM_WINDOWS = [
    { value: "hann", label: "Hann" },
    { value: "hamming", label: "Hamming" },
    { value: "blackman", label: "Blackman" },
    { value: "bartlett", label: "Bartlett" },
    { value: "none", label: "None" },
  ];

  const REDFIT_WINDOWS = [
    { value: "rectangular", label: "rectangular" },
    { value: "welch", label: "Welch" },
    { value: "hanning", label: "Hanning" },
    { value: "triangular", label: "triangular" },
    { value: "blackmanharris", label: "Blackman-Harris" },
  ];

  const METHOD_HINTS = {
    periodogram: "窗周期图",
    redfit: "红噪声频谱",
    mtm: "多锥形窗谱",
  };

  const METHOD_LABELS = { periodogram: "周期图", redfit: "REDFIT", mtm: "MTM" };

  function spectrumRange(data) {
    const periods = (data && data.period) || [];
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < periods.length; i += 1) {
      const v = periods[i];
      if (!isFinite(v) || v <= 0) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo) || !isFinite(hi)) return { lo: null, hi: null };
    return { lo, hi };
  }

  function renderSpectrumPanel(data) {
    const s = state.spectrum || {};
    const method = s.method || "periodogram";
    const range = spectrumRange(data);
    const hintLo = range.lo === null ? "自动" : "自动 (" + T.FORMAT.number(range.lo, 1) + ")";
    const hintHi = range.hi === null ? "自动" : "自动 (" + T.FORMAT.number(range.hi, 1) + ")";

    let body = "";
    body += field(
      "计算方法",
      select("specMethod", SPECTRUM_METHODS, method),
      METHOD_HINTS[method],
      "pre-wide",
    );

    if (method === "periodogram") {
      body += field("窗函数", select("specWindow", SPECTRUM_WINDOWS, s.window || "hann"), "用于抑制旁瓣干扰");
    }

    if (method === "redfit") {
      body += field(
        "分段数 n50",
        numInput("specN50", s.n50, { min: 1, max: 32, step: 1 }),
        "段数越多方差越小、分辨率越低",
      );
      body += field("过采样 ofac", numInput("specOfac", s.ofac, { min: 1, max: 8, step: 0.5 }), "典型值：2.0-4.0");
      body += field("最高频率 hifac", numInput("specHifac", s.hifac, { min: 0.1, max: 1, step: 0.1 }), "最大分析频率");
      body += field("窗函数", select("specIwin", REDFIT_WINDOWS, s.iwin || "rectangular"), "用于抑制旁瓣干扰");
      body += field(
        "检验方式",
        select(
          "specMctest",
          [
            { value: "false", label: "红噪声检验" },
            { value: "true", label: "蒙特卡洛检验" },
          ],
          s.mctest ? "true" : "false",
        ),
        s.mctest ? "对红噪声谱做随机模拟取阈值" : "AR(1) 红噪声谱 + 卡方分布",
      );
      if (s.mctest) {
        body += field(
          "模拟次数",
          numInput("specNsim", s.nsim, { min: 10, max: 10000, step: 50 }),
          "次数越多阈值越稳、耗时越长",
        );
      }
    }

    if (method === "mtm") {
      body += field(
        "时间带宽积 NW",
        numInput("specNw", s.nw, { min: 1, max: 20, step: 0.5 }),
        "越大分辨率越高、方差越大",
      );
      body += field("窗数 K", numInput("specK", s.k, { min: 1, max: 20, step: 1, placeholder: "自动" }), "窗数越大，谱越平滑");
    }

    body += field(
      "最短周期",
      numInput("specMinPeriod", s.min_periods, { min: 0, step: 1, placeholder: hintLo }),
      "留空为自动",
    );
    body += field(
      "最长周期",
      numInput("specMaxPeriod", s.max_periods, { min: 0, step: 1, placeholder: hintHi }),
      "留空为自动",
    );
    body += field(
      "置信水平",
      select(
        "specConfidence",
        [
          { value: "0.9", label: "90%" },
          { value: "0.95", label: "95%" },
          { value: "0.99", label: "99%" },
        ],
        String(s.confidence || 0.95),
      ),
      "显著性阈值"
    );
    body += field(
      "X 轴刻度",
      select(
        "specXScale",
        [
          { value: "linear", label: "线性" },
          { value: "log", label: "对数" },
        ],
        s.xScale || "linear",
      ),
      "对数刻度便于观察宽周期段",
    );
    body +=
      '<div class="pre-actions">' +
      '<button class="btn-primary pre-apply" id="specApplyBtn">应用并重算</button>' +
      '<button class="pre-reset" id="specResetBtn">重置</button>' +
      "</div>";

    return (
      '<section class="preprocess-panel spectrum-panel" id="spectrumParamPanel">' +
      '<header class="preprocess-head">' +
      "<h3>功率谱参数</h3>" +
      '<span class="pre-badge on">' + T.esc(METHOD_LABELS[method] || method) + "</span>" +
      "</header>" +
      '<div class="preprocess-body">' +
      body +
      "</div>" +
      "</section>"
    );
  }

  function bindSpectrumPanel() {
    const applyBtn = document.getElementById("specApplyBtn");
    if (!applyBtn) return;

    // 切换方法时重建面板，只显示该方法用得到的参数
    const methodEl = document.getElementById("specMethod");
    if (methodEl) {
      methodEl.addEventListener("change", () => {
        state.spectrum.method = methodEl.value;
        const panel = document.getElementById("spectrumParamPanel");
        if (panel) {
          panel.outerHTML = renderSpectrumPanel(state.analysis);
          bindSpectrumPanel();
        }
      });
    }

    // 切换检验方式时重建面板，蒙特卡洛才需要填模拟次数
    const mctestEl = document.getElementById("specMctest");
    if (mctestEl) {
      mctestEl.addEventListener("change", () => {
        state.spectrum.mctest = mctestEl.value === "true";
        const panel = document.getElementById("spectrumParamPanel");
        if (panel) {
          panel.outerHTML = renderSpectrumPanel(state.analysis);
          bindSpectrumPanel();
        }
      });
    }

    // X 轴刻度只影响绘图，不必重新请求
    const xScaleEl = document.getElementById("specXScale");
    if (xScaleEl) {
      xScaleEl.addEventListener("change", () => {
        state.spectrum.xScale = xScaleEl.value;
        if (hooks.rerenderAnalysis) hooks.rerenderAnalysis();
      });
    }

    const resetBtn = document.getElementById("specResetBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.resetSpectrum();
        if (hooks.rerunAnalysis) hooks.rerunAnalysis();
      });
    }

    applyBtn.addEventListener("click", () => {
      const s = state.spectrum;
      s.method = methodEl ? methodEl.value : s.method;
      const windowEl = document.getElementById("specWindow");
      if (windowEl) s.window = windowEl.value;
      const iwinEl = document.getElementById("specIwin");
      if (iwinEl) s.iwin = iwinEl.value;
      const confEl = document.getElementById("specConfidence");
      if (confEl) s.confidence = Number(confEl.value);
      const scaleEl = document.getElementById("specXScale");
      if (scaleEl) s.xScale = scaleEl.value;

      if (s.method === "redfit") {
        s.n50 = readNumber("specN50", 2);
        s.ofac = readNumber("specOfac", 2);
        s.hifac = readNumber("specHifac", 1);
        const mctestApply = document.getElementById("specMctest");
        if (mctestApply) s.mctest = mctestApply.value === "true";
        if (s.mctest) s.nsim = readNumber("specNsim", 1000);
      }
      if (s.method === "mtm") {
        s.nw = readNumber("specNw", 4);
        s.k = readNumber("specK", null);
      }
      s.min_periods = readNumber("specMinPeriod", null);
      s.max_periods = readNumber("specMaxPeriod", null);

      if (s.min_periods && s.max_periods && s.min_periods >= s.max_periods) {
        toast("最短周期必须小于最长周期", "warn");
        return;
      }
      if (hooks.rerunAnalysis) hooks.rerunAnalysis();
    });
  }

  // =========================================================== 周期参数面板
  function renderPeriodPanel(data) {
    const p = state.period || {};
    const meta = (data && data.meta) || {};
    const hintMax = meta.display_max_period
      ? "自动 (" + T.FORMAT.number(meta.display_max_period, 1) + ")"
      : "自动";
    const hintLag = meta.acf_max_lag ? "自动 (" + meta.acf_max_lag + ")" : "自动";
    const hintOrder = meta.order ? "自动 (" + meta.order + ")" : "自动";

    let body = "";
    body += field(
      "最长显示周期",
      numInput("pdMaxPeriod", p.max_period, { min: 2, step: 1, placeholder: hintMax }),
      "超出序列长度的周期会被截掉",
    );
    body += field(
      "显著性水平",
      select(
        "pdConfidence",
        [
          { value: "0.9", label: "90%" },
          { value: "0.95", label: "95%" },
          { value: "0.99", label: "99%" },
        ],
        String(p.confidence || 0.95),
      ),
      "自相关置信带与最大熵谱阈值的红噪声检验水平",
    );
    body += field(
      "自相关最大滞后",
      numInput("pdMaxLag", p.max_lag, { min: 2, max: 5000, step: 1, placeholder: hintLag }),
      "留空按序列长度的 1/3 自动选取",
    );
    body += field(
      "最大熵阶数",
      numInput("pdOrder", p.order, { min: 1, max: 60, step: 1, placeholder: hintOrder }),
      "阶数越高谱峰越尖锐、越易出现虚假峰",
    );
    body += field(
      "X 轴刻度",
      select(
        "pdXScale",
        [
          { value: "linear", label: "线性" },
          { value: "log", label: "对数" },
        ],
        p.xScale || "log",
      ),
      "对数刻度便于观察宽周期段",
    );
    body +=
      '<div class="pre-actions">' +
      '<button class="btn-primary pre-apply" id="pdApplyBtn">应用并重算</button>' +
      '<button class="pre-reset" id="pdResetBtn">重置</button>' +
      "</div>";

    const engineHint =
      meta.order || meta.lag1 !== undefined
        ? "计算引擎 easyclimate · 最大熵阶数 " +
          (meta.order === undefined ? "—" : meta.order) +
          " · AR(1) " +
          (meta.lag1 === undefined ? "—" : T.FORMAT.number(meta.lag1, 3)) +
          " · 显示周期上限 " +
          (meta.display_max_period === undefined ? "—" : T.FORMAT.number(meta.display_max_period, 1))
        : "";

    return (
      '<section class="preprocess-panel spectrum-panel" id="periodParamPanel">' +
      '<header class="preprocess-head">' +
      "<h3>周期分析参数</h3>" +
      '<span class="pre-badge on">自相关 + Burg</span>' +
      "</header>" +
      '<div class="preprocess-body">' +
      body +
      (engineHint ? '<p class="pre-static">' + T.esc(engineHint) + "</p>" : "") +
      "</div>" +
      "</section>"
    );
  }

  function bindPeriodPanel() {
    const applyBtn = document.getElementById("pdApplyBtn");
    if (!applyBtn) return;

    // X 轴刻度只影响绘图，不必重新请求
    const xScaleEl = document.getElementById("pdXScale");
    if (xScaleEl) {
      xScaleEl.addEventListener("change", () => {
        state.period.xScale = xScaleEl.value;
        if (hooks.rerenderAnalysis) hooks.rerenderAnalysis();
      });
    }

    const resetBtn = document.getElementById("pdResetBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.resetPeriod();
        if (hooks.rerunAnalysis) hooks.rerunAnalysis();
      });
    }

    applyBtn.addEventListener("click", () => {
      const p = state.period;
      const confEl = document.getElementById("pdConfidence");
      if (confEl) p.confidence = Number(confEl.value);
      const scaleEl = document.getElementById("pdXScale");
      if (scaleEl) p.xScale = scaleEl.value;
      p.max_period = readNumber("pdMaxPeriod", null);
      p.max_lag = readNumber("pdMaxLag", null);
      p.order = readNumber("pdOrder", null);

      if (p.max_period !== null && p.max_period < 2) {
        toast("最长显示周期不能小于 2", "warn");
        return;
      }
      if (hooks.rerunAnalysis) hooks.rerunAnalysis();
    });
  }

  // =========================================================== 突变参数面板
  function renderAbruptPanel(data) {
    const a = state.abrupt || state.abruptDefaults();
    const st = (data && data.sliding_t) || {};
    const mk = (data && data.mann_kendall) || {};
    const pt = (data && data.pettitt) || {};
    const windowValue = st.window || a.window || 100;

    let body = "";
    body += field(
      "滑动 t 窗口大小",
      numInput("abWindow", windowValue, { min: 3, step: 1 }),
      "单侧样本数，窗口越大越平滑",
    );

    const hints = [];
    if (st.window) hints.push("当前窗口 " + st.window + "（临界值 " + T.FORMAT.number(st.critical, 3) + "）");
    if (mk.trend) hints.push("MK 趋势：" + mk.trend);
    if (pt.index !== undefined) hints.push("Pettitt 突变点索引 " + pt.index);
    if (hints.length) {
      body += '<p class="pre-static">' + T.esc(hints.join(" · ")) + "</p>";
    }

    body +=
      '<div class="pre-actions">' +
      '<button class="btn-primary pre-apply" id="abApplyBtn">应用并重算</button>' +
      '<button class="pre-reset" id="abResetBtn">重置</button>' +
      "</div>";

    return (
      '<section class="preprocess-panel spectrum-panel" id="abruptParamPanel">' +
      '<header class="preprocess-head">' +
      "<h3>突变分析参数</h3>" +
      '<span class="pre-badge on">Mann-Kendall · 滑动 t · Pettitt</span>' +
      "</header>" +
      '<div class="preprocess-body">' +
      body +
      "</div>" +
      "</section>"
    );
  }

  function bindAbruptPanel() {
    const applyBtn = document.getElementById("abApplyBtn");
    if (!applyBtn) return;

    const resetBtn = document.getElementById("abResetBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.resetAbrupt();
        if (hooks.rerunAnalysis) hooks.rerunAnalysis();
      });
    }

    applyBtn.addEventListener("click", () => {
      const value = readNumber("abWindow", null);
      if (value === null) {
        toast("请填写滑动 t 窗口大小", "warn");
        return;
      }
      const window = Math.round(value);
      if (window < 3) {
        toast("窗口需大于等于3", "warn");
        return;
      }
      state.abrupt = state.abrupt || state.abruptDefaults();
      state.abrupt.window = window;
      if (hooks.rerunAnalysis) hooks.rerunAnalysis();
    });
  }

  // =========================================================== 小波参数面板
  const WAVELET_MOTHERS = [
    { value: "morlet", label: "Morlet" },
    { value: "paul", label: "Paul" },
    { value: "dog", label: "DOG" },
  ];

  // easyclimate 的 wave_signif 在 time-average / scale-average 模式下需要额外自由度参数，
  // 二维功率场的逐点检验只能走卡方检验，因此这里的可选项与后端约束保持一致。
  const WAVELET_SIGTESTS_FIELD = [
    { value: "regular chi-square test", label: "卡方检验（逐点）" },
  ];

  const WAVELET_SIGTESTS_GLOBAL = [
    { value: "regular chi-square test", label: "卡方检验（逐点）" },
    { value: "time-average test", label: "时间平均检验" },
  ];

  function renderWaveletPanel(data) {
    const w = state.wavelet || state.waveletDefaults();
    const meta = (data && data.meta) || {};
    const period = (data && data.period) || [];
    const fmt = (v) => (typeof v === "number" ? v.toFixed(2) : "—");
    const range = period.length ? fmt(period[0]) + " – " + fmt(period[period.length - 1]) : "自动";
    const nullNum = (v) => (v === null || v === undefined || v === "" ? "" : v);

    let body = "";

    // ---- 母小波 ----
    body += field(
      "母小波",
      select("wvMother", WAVELET_MOTHERS, w.mother || "morlet"),
      "easyclimate 支持 Morlet / Paul / DOG",
    );
    body += field(
      "母小波参数",
      numInput("wvMotherParam", nullNum(w.mother_param), {
        min: 1,
        max: 20,
        step: 0.5,
        placeholder: "默认",
        title: "Morlet 为 k0（默认 6），Paul 为阶数 m（默认 4），DOG 为导数阶 m（默认 2）",
      }),
      "留空使用库默认值",
    );

    // ---- 尺度设置 ----
    body += field(
      "最大尺度",
      numInput("wvMaxScale", w.max_scale, { min: 4, max: 512, step: 1 }),
      "采样点数为单位；八度数留空时由它推导",
    );
    body += field(
      "最小尺度 s0",
      numInput("wvS0", nullNum(w.s0), { min: 0.5, step: 0.5, placeholder: "2·dt" }),
      "留空为 2·dt",
    );
    body += field(
      "尺度间隔 dj",
      numInput("wvDj", w.dj, { min: 0.05, max: 1, step: 0.05 }),
      "越小尺度越密（默认 0.25）",
    );
    body += field(
      "八度数 j1/dj",
      numInput("wvJ1", nullNum(w.j1_n_div_dj), { min: 1, max: 64, step: 1, placeholder: "自动" }),
      "多少个 2 的幂，内部取 j1 = 该值 / dj",
    );
    body += field(
      "补零",
      select(
        "wvPad",
        [
          { value: "1", label: "补零到 2 的幂（推荐）" },
          { value: "0", label: "不补零" },
        ],
        String(w.pad === 0 ? 0 : 1),
      ),
      "抑制首尾环绕，并加速 FFT",
    );

    // ---- 显著性 ----
    body += field(
      "AR(1) 系数",
      numInput("wvLag1", nullNum(w.lag1), {
        min: -0.999,
        max: 0.999,
        step: 0.01,
        placeholder: "自动估计",
      }),
      "红噪声背景的滞后 1 自相关",
    );
    body += field(
      "小波显著性检验",
      select("wvSigtestWavelet", WAVELET_SIGTESTS_FIELD, "regular chi-square test"),
      "逐尺度 × 逐时刻的显著性判据（时间平均检验需额外自由度，暂不支持）",
    );
    body += field(
      "全局谱显著性检验",
      select("wvSigtestGlobal", WAVELET_SIGTESTS_GLOBAL, w.sigtest_global || "time-average test"),
      "全局小波谱阈值所用检验",
    );
    body += field(
      "置信水平",
      select(
        "wvConfidence",
        [
          { value: "0.9", label: "90%" },
          { value: "0.95", label: "95%" },
          { value: "0.99", label: "99%" },
        ],
        String(w.confidence || 0.95),
      ),
      "相对 AR(1) 红噪声的显著性",
    );

    // ---- 显示（不需要重算）----
    body += field(
      "周期轴刻度",
      select(
        "wvXScale",
        [
          { value: "linear", label: "线性" },
          { value: "log", label: "指数（log₁₀）" },
        ],
        w.xScale === "log" ? "log" : "linear",
      ),
      "同时作用于小波谱纵轴与全局谱横轴；取对数后短周期端更清晰",
    );
    body += field(
      "功率轴刻度",
      select(
        "wvYScale",
        [
          { value: "linear", label: "线性" },
          { value: "log", label: "指数（log₁₀）" },
        ],
        w.yScale === "log" ? "log" : "linear",
      ),
      "仅作用于全局小波谱的功率轴",
    );
    body += field(
      "显著性轮廓",
      '<label class="pre-switch">' +
        '<input type="checkbox" id="wvShowContour"' + (w.showContour !== false ? " checked" : "") + " />" +
        "<span>画出功率 / 阈值的等值线</span></label>",
      "",
    );
    body += field(
      "影响锥",
      '<label class="pre-switch">' +
        '<input type="checkbox" id="wvShowCone"' + (w.showCone !== false ? " checked" : "") + " />" +
        "<span>显示锥边界（锥外受边缘效应影响）</span></label>",
      "",
    );

    body +=
      '<div class="pre-actions">' +
      '<button class="btn-primary pre-apply" id="wvApplyBtn">应用并重算</button>' +
      '<button class="pre-reset" id="wvResetBtn">重置</button>' +
      "</div>";

    const badge =
      ({ morlet: "Morlet", paul: "Paul", dog: "DOG" })[String(w.mother || "morlet").toLowerCase()] ||
      String(w.mother || "morlet");
    return (
      '<section class="preprocess-panel spectrum-panel" id="waveletParamPanel">' +
      '<header class="preprocess-head">' +
      "<h3>小波参数</h3>" +
      '<span class="pre-badge on">' + T.esc(badge) + "</span>" +
      "</header>" +
      '<div class="preprocess-body">' +
      body +
      "</div>" +
      "</section>"
    );
  }

  /** 读取面板上的显示参数（纯前端，不触发重算）。 */
  function readWaveletDisplay() {
    const w = state.wavelet || state.waveletDefaults();
    const xs = document.getElementById("wvXScale");
    const ys = document.getElementById("wvYScale");
    const sc = document.getElementById("wvShowContour");
    const cn = document.getElementById("wvShowCone");
    if (xs) w.xScale = xs.value === "log" ? "log" : "linear";
    if (ys) w.yScale = ys.value === "log" ? "log" : "linear";
    if (sc) w.showContour = sc.checked;
    if (cn) w.showCone = cn.checked;
    state.wavelet = w;
  }

  function bindWaveletPanel() {
    const applyBtn = document.getElementById("wvApplyBtn");
    if (!applyBtn) return;

    // 母小波切换：badge 与参数提示需要重建面板
    const motherEl = document.getElementById("wvMother");
    if (motherEl) {
      motherEl.addEventListener("change", () => {
        const w = state.wavelet || state.waveletDefaults();
        w.mother = motherEl.value;
        state.wavelet = w;
        const panel = document.getElementById("waveletParamPanel");
        if (panel) {
          panel.outerHTML = renderWaveletPanel(state.analysis);
          bindWaveletPanel();
        }
      });
    }

    // 纯显示参数：改了立刻重绘，不必重算
    ["wvXScale", "wvYScale", "wvShowContour", "wvShowCone"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", () => {
        readWaveletDisplay();
        if (hooks.rerenderAnalysis) hooks.rerenderAnalysis();
      });
    });

    const resetBtn = document.getElementById("wvResetBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.resetWavelet();
        if (hooks.rerunAnalysis) hooks.rerunAnalysis();
      });
    }

    applyBtn.addEventListener("click", () => {
      const w = state.wavelet || state.waveletDefaults();
      w.max_scale = Math.max(4, Math.min(512, Math.round(readNumber("wvMaxScale", 64))));
      w.confidence = readNumber("wvConfidence", 0.95);
      w.dj = Math.max(0.05, Math.min(1, readNumber("wvDj", 0.25)));
      w.pad = readNumber("wvPad", 1) ? 1 : 0;
      const motherEl = document.getElementById("wvMother");
      if (motherEl) w.mother = motherEl.value;
      const swEl = document.getElementById("wvSigtestWavelet");
      if (swEl) w.sigtest_wavelet = swEl.value;
      const sgEl = document.getElementById("wvSigtestGlobal");
      if (sgEl) w.sigtest_global = sgEl.value;

      w.j1_n_div_dj = readNumber("wvJ1", null);
      w.s0 = readNumber("wvS0", null);
      w.lag1 = readNumber("wvLag1", null);
      w.mother_param = readNumber("wvMotherParam", null);
      if (w.lag1 !== null && (w.lag1 <= -0.999 || w.lag1 >= 0.999)) {
        toast("AR(1) 系数需在 -0.999 与 0.999 之间", "warn");
        return;
      }
      readWaveletDisplay();
      state.wavelet = w;
      if (hooks.rerunAnalysis) hooks.rerunAnalysis();
    });
  }

  // ======================================================= 双变量面板（数据 + 变量）
  /**
   * 交叉谱 / 相关性 / 多序列对比都用两个「数据文件 + 变量」组合。
   * 文件列表里有两个以上文件时给出两组「文件 + 变量」；只有一个文件时
   * 只给出一组（文件固定）下的两个变量，等价于旧版的同文件双变量分析。
   */
  /** 面板外壳：与分析视图里的其他参数面板保持同一套 class。 */
  function panelShell(id, title, badge, body) {
    return (
      '<section class="preprocess-panel spectrum-panel" id="' + id + '">' +
      '<header class="preprocess-head"><h3>' + T.esc(title) + "</h3>" +
      '<span class="pre-badge on">' + T.esc(badge) + "</span></header>" +
      '<div class="preprocess-body">' + body + "</div></section>"
    );
  }

  /** 面板底部的「应用 / 重置」按钮行。 */
  function applyRow(applyId, applyText, resetId) {
    return (
      '<div class="pre-actions">' +
      '<button class="btn-primary pre-apply" id="' + applyId + '">' +
      T.esc(applyText) +
      "</button>" +
      '<button class="pre-reset" id="' + resetId + '">重置</button>' +
      "</div>"
    );
  }

  function fileLabel(f) {
    const suffix =
      f.source === "sample" ? " · 示例" : f.source === "derived" ? " · 派生" : "";
    return f.name + suffix;
  }

  /**
   * 可参与分析的「数据文件列表」= 左侧栏里用户已加入的文件。
   * 侧栏只有一个文件时，双变量面板就退化成同文件的两个变量。
   */
  function visibleFiles() {
    const ids = state.addedFileIds || [];
    const byId = {};
    (state.files || []).forEach((f) => {
      byId[f.id] = f;
    });
    const picked = ids.map((id) => byId[id]).filter(Boolean);
    return picked.length ? picked : state.files || [];
  }

  function fileSelect(id, current) {
    const files = visibleFiles();
    return (
      '<select id="' + id + '">' +
      files
        .map(
          (f) =>
            '<option value="' + T.esc(f.id) + '"' +
            (f.id === current ? " selected" : "") +
            ">" + T.esc(fileLabel(f)) + "</option>",
        )
        .join("") +
      "</select>"
    );
  }

  /** 取某个文件的变量列表：当前文件复用 state.variables，其余走缓存。 */
  function varsOf(fileId) {
    if (!fileId) return null;
    if (fileId === state.currentFileId && (state.variables || []).length) {
      return state.variables;
    }
    const cached = (state.fileVariables || {})[fileId];
    return cached && cached.length ? cached : null;
  }

  function rememberVars(fileId, vars) {
    if (!fileId || !vars || !vars.length) return;
    state.fileVariables = state.fileVariables || {};
    state.fileVariables[fileId] = vars;
  }

  /** 变量下拉的文案：优先长名，再补变量名与单位。 */
  function variableLabel(v) {
    if (!v) return "";
    const base = v.long_name || v.name;
    const unit = v.units ? " (" + v.units + ")" : "";
    return base + " · " + v.name + unit;
  }

  function variableOptions(vars, current) {
    return vars
      .map(
        (v) =>
          '<option value="' + T.esc(v.name) + '"' +
          (v.name === current ? " selected" : "") +
          ">" + T.esc(variableLabel(v)) + "</option>",
      )
      .join("");
  }

  function variableSelectOf(id, fileId, current) {
    const vars = varsOf(fileId);
    if (!vars) return '<select id="' + id + '"><option value="">加载中…</option></select>';
    return '<select id="' + id + '">' + variableOptions(vars, current) + "</select>";
  }

  /** 异步补齐某个文件的变量列表，返回 Promise<变量数组>。 */
  function ensureVariables(fileId) {
    const cached = varsOf(fileId);
    if (cached) return Promise.resolve(cached);
    const api = global.PaleoAPI;
    if (!fileId || !api) return Promise.resolve([]);
    return api
      .fileVariables(fileId)
      .then((data) => {
        const vars = (data && data.variables) || [];
        rememberVars(fileId, vars);
        return vars;
      })
      .catch(() => []);
  }

  /**
   * 把变量下拉的选项补齐（优先保留 preferred，其次保留用户已选值，
   * 再挑一个不在 avoid 里的变量，最后取第一项）。
   */
  function fillVarSelect(varId, fileId, preferred, avoid) {
    const el = document.getElementById(varId);
    if (!el) return Promise.resolve();
    return ensureVariables(fileId).then((vars) => {
      const target = document.getElementById(varId);
      if (!target || !vars.length) return;
      const keep = target.value;
      const candidates = [preferred, keep].filter(Boolean);
      const blocked = avoid || [];
      let next = "";
      for (let i = 0; i < candidates.length && !next; i += 1) {
        if (vars.some((v) => v.name === candidates[i])) next = candidates[i];
      }
      if (!next) {
        const free = vars.find((v) => blocked.indexOf(v.name) < 0);
        next = (free && free.name) || vars[0].name;
      }
      target.innerHTML = variableOptions(vars, next);
    });
  }

  /**
   * 多序列对比里「再加一个组合」的按钮（放在最后一个盒子的右侧）。
   * standalone=true 表示这个盒子里没有「✕」，按钮自己负责靠右。
   */
  function addButtonHtml(standalone) {
    return (
      '<button type="button" class="pre-add' +
      (standalone ? " pre-add-tail" : "") +
      '" id="pairAddBtn" title="再加一个「数据 - 变量」组合">' +
      '<span class="pre-add-icon">＋</span></button>'
    );
  }

  /** 一个「数据 - 变量」盒子的 HTML；多序列对比时可带删除按钮。 */
  function pairGroup(prefix, label, fileId, varId, file, variable, opts) {
    const o = opts || {};
    const files = visibleFiles();
    const controls = [];
    if (files.length >= 2) {
      controls.push(field(label + " · 文件", fileSelect(fileId, file)));
      controls.push(field(label + " · 变量", variableSelectOf(varId, file, variable)));
    } else {
      controls.push(field(label + " · 变量", variableSelectOf(varId, file, variable)));
    }
    const remove = o.removable
      ? '<button type="button" class="pre-remove" data-remove="' +
        T.esc(String(o.index)) +
        '" title="删除这个组合">✕</button>'
      : "";
    return (
      '<div class="pre-group" data-group="' + T.esc(prefix) + '">' +
      controls.join("") +
      remove +
      (o.trailing || "") +
      "</div>"
    );
  }

  function renderPairPanel(data, opts) {
    const cfg = opts || {};
    const files = visibleFiles();
    const pair = state.pair || state.pairDefaults();
    const multi = Boolean(cfg.multi);
    const fallbackFile = state.currentFileId || (files[0] && files[0].id) || "";
    const fileA = pair.file_a || fallbackFile;
    const fileB = pair.file_b || fileA;
    const varsA = varsOf(fileA) || [];
    const varsB = varsOf(fileB) || varsA;
    const varA = pair.variable_a || (varsA[0] && varsA[0].name) || "";
    const varB =
      pair.variable_b ||
      (varsB[1] && varsB[1].name) ||
      (varsB[0] && varsB[0].name) ||
      "";

    let body = "";
    if (files.length < 2) {
      const only = files[0];
      body += field(
        "数据文件",
        '<span class="pre-fixed">' +
          T.esc(only ? fileLabel(only) : "尚未选择文件") +
          "</span>",
      );
    }

    body += pairGroup("A", "数据 A", "pairFileA", "pairVarA", fileA, varA);

    // 数据 B 之后是用户追加的组合；「＋」永远贴在最后一个盒子的右侧
    const groups = [
      pairGroup("B", "数据 B", "pairFileB", "pairVarB", fileB, varB),
    ];
    if (multi) {
      const extras = pair.extras || [];
      // 已占用的「文件 + 变量」组合，追加的盒子默认挑一个还没用过的变量
      const usedKeys = [fileA + "\u0000" + varA, fileB + "\u0000" + varB];
      extras.forEach((extra, index) => {
        const label = "数据 " + String.fromCharCode(67 + index);
        const file = extra.file || fileA;
        const vars = varsOf(file) || varsA;
        let variable = extra.variable || "";
        if (!variable) {
          const free = vars.find(
            (v) => usedKeys.indexOf(file + "\u0000" + v.name) < 0,
          );
          variable = (free && free.name) || (vars[0] && vars[0].name) || "";
        }
        usedKeys.push(file + "\u0000" + variable);
        groups.push(
          pairGroup(
            "E" + index,
            label,
            "pairFileE" + index,
            "pairVarE" + index,
            file,
            variable,
            { removable: true, index: index },
          ),
        );
      });
    }
    body += groups
      .map((html, index) => {
        if (!multi || index !== groups.length - 1) return html;
        // 最后一个盒子里有「✕」时，按钮跟在「✕」后面；否则自己靠右
        const standalone = index === 0;
        return html.replace(/<\/div>$/, addButtonHtml(standalone) + "</div>");
      })
      .join("");
    if (multi) {
      body +=
        '<div class="pre-add-row">' +
        '<span class="pre-hint">点「＋」可继续追加组合，最多 8 个，时间轴自动取公共时段</span>' +
        "</div>";
    }

    if (files.length >= 2) {
      body +=
        '<p class="pre-static">' +
        (multi
          ? "每个盒子是一个「数据文件 + 变量」组合，可继续追加；所有序列的时间轴会自动对齐，只对公共时段做" +
            T.esc(cfg.title || "对比") +
            "。"
          : "分别选择两个「数据文件 + 变量」组合，两侧时间轴会自动对齐，只对公共时段做" +
            T.esc(cfg.title || "双变量分析") +
            "。") +
        "</p>";
    } else {
      body +=
        '<p class="pre-static">当前只有一个数据文件，请选择其中两个变量做' +
        T.esc(cfg.title || "对比") +
        (multi ? "（可点「＋」继续追加变量组合）" : "") +
        "，二者不能相同。</p>";
    }

    if (cfg.crossOpts) {
      body += field(
        "最大周期",
        numInput("pairMaxPeriod", pair.max_period, {
          min: 0,
          step: 1,
          placeholder: "自动",
        }),
        "超过该周期的频段不显示，留空为全部频段",
        "pre-narrow",
      );
      body += field(
        "X 轴刻度",
        select(
          "pairXScale",
          [
            { value: "linear", label: "线性" },
            { value: "log", label: "对数" },
          ],
          pair.xScale || "linear",
        ),
        "对数刻度便于观察宽周期段",
      );
    }

    body += applyRow("pairApplyBtn", "应用并计算", "pairResetBtn");
    return panelShell(
      "pairParamPanel",
      (cfg.title || "双变量分析") + "参数",
      cfg.badge || "两个数据 · 两个变量",
      body,
    );
  }

  function bindPairPanel(opts) {
    const cfg = opts || {};
    const applyBtn = document.getElementById("pairApplyBtn");
    if (!applyBtn) return;

    const rerun = cfg.rerun === "compare" ? hooks.rerunCompare : hooks.rerunAnalysis;
    const pair = state.pair || state.pairDefaults();
    const extras = pair.extras || [];

    /** 文件下拉变化时刷新同名变量下拉；avoid 是同一文件里已被占用的变量名。 */
    const wireGroup = (fileId, varId, preferred, fallbackFile, avoidOf) => {
      const sel = document.getElementById(fileId);
      const avoid = avoidOf ? avoidOf() : null;
      if (!sel) {
        // 只有一个文件时没有文件下拉，直接用当前文件补齐变量
        fillVarSelect(varId, fallbackFile, preferred, avoid);
        return;
      }
      fillVarSelect(varId, sel.value, preferred, avoid);
      sel.addEventListener("change", () => {
        const target = document.getElementById(varId);
        if (target) target.innerHTML = '<option value="">加载中…</option>';
        const nextAvoid = avoidOf ? avoidOf() : null;
        fillVarSelect(varId, sel.value, null, nextAvoid);
      });
    };

    /** 某个变量下拉当前选中的值（面板还没渲染出来时返回空串）。 */
    const currentVar = (id) => {
      const el = document.getElementById(id);
      return (el && el.value) || "";
    };
    /** 某文件下已经用掉的变量名，用来给新增的盒子挑一个没被占用的变量。 */
    const usedIn = (fileId, exceptVarId) => {
      const names = [];
      const collect = (fId, vId) => {
        if (vId === exceptVarId) return;
        const f = document.getElementById(fId);
        const fValue = f ? f.value : fileId;
        if (fValue === fileId) {
          const name = currentVar(vId);
          if (name) names.push(name);
        }
      };
      collect("pairFileA", "pairVarA");
      collect("pairFileB", "pairVarB");
      extras.forEach((_, i) => collect("pairFileE" + i, "pairVarE" + i));
      return names;
    };

    wireGroup("pairFileA", "pairVarA", pair.variable_a, pair.file_a || state.currentFileId);
    wireGroup("pairFileB", "pairVarB", pair.variable_b, pair.file_b || pair.file_a || state.currentFileId);
    extras.forEach((extra, index) => {
      const varId = "pairVarE" + index;
      const fileEl = document.getElementById("pairFileE" + index);
      const targetFile = (fileEl && fileEl.value) || extra.file || pair.file_a || state.currentFileId;
      wireGroup(
        "pairFileE" + index,
        varId,
        extra.variable,
        targetFile,
        () => usedIn(targetFile, varId),
      );
    });

    /** 读出面板上所有「数据 - 变量」组合。 */
    const readGroups = () => {
      const fallbackFile = state.currentFileId || "";
      const readOne = (fileId, varId) => {
        const fileEl = document.getElementById(fileId);
        const varEl = document.getElementById(varId);
        return {
          file: (fileEl && fileEl.value) || fallbackFile,
          variable: varEl ? varEl.value : "",
        };
      };
      return {
        a: readOne("pairFileA", "pairVarA"),
        b: readOne("pairFileB", "pairVarB"),
        extras: extras.map((_, index) =>
          readOne("pairFileE" + index, "pairVarE" + index),
        ),
      };
    };

    const rerender = () => {
      const panel = document.getElementById("pairParamPanel");
      if (!panel) return;
      panel.outerHTML = renderPairPanel(null, cfg);
      bindPairPanel(cfg);
    };

    // 多序列对比：➕ 追加一个组合
    const addBtn = document.getElementById("pairAddBtn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const current = readGroups();
        const nextExtras = current.extras.slice();
        // A + B + extras 最多 8 个组合
        if (nextExtras.length >= 6) return toast("最多 8 个组合", "warn");
        // 默认沿用数据 A 的文件，变量交给后端按顺序取
        nextExtras.push({ file: current.a.file, variable: null });
        state.pair = Object.assign({}, state.pair || state.pairDefaults(), {
          file_a: current.a.file,
          file_b: current.b.file,
          variable_a: current.a.variable,
          variable_b: current.b.variable,
          extras: nextExtras,
        });
        rerender();
      });
    }

    // 删除某个附加组合
    Array.prototype.forEach.call(
      document.querySelectorAll("#pairParamPanel .pre-remove"),
      (btn) => {
        btn.addEventListener("click", () => {
          const index = Number(btn.getAttribute("data-remove"));
          const current = readGroups();
          const nextExtras = current.extras.slice();
          nextExtras.splice(index, 1);
          state.pair = Object.assign({}, state.pair || state.pairDefaults(), {
            file_a: current.a.file,
            file_b: current.b.file,
            variable_a: current.a.variable,
            variable_b: current.b.variable,
            extras: nextExtras,
          });
          rerender();
        });
      },
    );

    // 交叉谱：X 轴刻度只影响绘图，不必重新请求
    const xScaleEl = document.getElementById("pairXScale");
    if (xScaleEl) {
      xScaleEl.addEventListener("change", () => {
        state.pair = Object.assign({}, state.pair || state.pairDefaults(), {
          xScale: xScaleEl.value,
        });
        if (hooks.rerenderAnalysis) hooks.rerenderAnalysis();
      });
    }

    const resetBtn = document.getElementById("pairResetBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.resetPair();
        rerender();
      });
    }

    applyBtn.addEventListener("click", () => {
      const current = readGroups();
      const { a, b } = current;
      if (!a.variable || !b.variable) return toast("请选择两个变量", "warn");
      if (a.file === b.file && a.variable === b.variable) {
        return toast("请选择两个不同的变量或数据文件", "warn");
      }
      const keys = [a.file + "\u0000" + a.variable, b.file + "\u0000" + b.variable];
      const keptExtras = [];
      for (let i = 0; i < current.extras.length; i += 1) {
        const extra = current.extras[i];
        if (!extra.variable) continue;
        const key = extra.file + "\u0000" + extra.variable;
        if (keys.indexOf(key) >= 0) {
          return toast("请选择不同的变量或数据文件进行分析", "warn");
        }
        keys.push(key);
        keptExtras.push({ file: extra.file, variable: extra.variable });
      }
      state.pair = Object.assign({}, state.pair || state.pairDefaults(), {
        file_a: a.file,
        file_b: b.file,
        variable_a: a.variable,
        variable_b: b.variable,
        extras: keptExtras,
      });
      if (cfg.crossOpts) {
        state.pair.max_period = readNumber("pairMaxPeriod", null);
        const scaleEl = document.getElementById("pairXScale");
        if (scaleEl) state.pair.xScale = scaleEl.value;
      }
      if (rerun) rerun();
    });
  }

  /** 交叉谱 / 相关性的面板（与对比面板同构，仅重算回调不同）。 */
  function renderVariablePanel(data, opts) {
    const cfg = Object.assign({ rerun: "analysis" }, opts || {});
    // 交叉谱多给「最大周期」「X 轴刻度」两个参数
    if (cfg.crossOpts === undefined) {
      cfg.crossOpts = cfg.title === "交叉谱分析";
    }
    return renderPairPanel(data, cfg);
  }

  function bindVariablePanel(opts) {
    const cfg = Object.assign({ rerun: "analysis" }, opts || {});
    if (cfg.crossOpts === undefined) {
      cfg.crossOpts = cfg.title === "交叉谱分析";
    }
    return bindPairPanel(cfg);
  }

  function renderComparePanel(data) {
    return renderPairPanel(data, {
      title: "多序列对比",
      badge: "两个以上数据 · 对比",
      rerun: "compare",
      multi: true,
    });
  }

  function bindComparePanel() {
    return bindPairPanel({
      title: "多序列对比",
      badge: "两个以上数据 · 对比",
      rerun: "compare",
      multi: true,
    });
  }


  // =========================================================== EEMD 参数面板
  function renderEemdPanel(data) {
    const e = state.eemd || state.eemdDefaults();
    const meta = (data && data.meta) || {};

    let body = "";
    body += field(
      "集合次数 trials",
      numInput("eemdTrials", e.trials, { min: 5, max: 300, step: 1 }),
      "加入白噪声的重复次数，越大越稳定也越慢",
      "pre-narrow",
    );
    body += field(
      "噪声比 noise_ratio",
      numInput("eemdNoise", e.noise_ratio, { min: 0.05, max: 1, step: 0.05 }),
      "白噪声幅值相对序列标准差的比值",
      "pre-narrow",
    );
    body += field(
      "最大 IMF 个数",
      numInput("eemdMaxImfs", e.max_imfs, { min: 2, max: 10, step: 1 }),
      "分解得到的分量个数上限",
      "pre-narrow",
    );
    body += field(
      "随机种子 noise_seed",
      numInput("eemdSeed", e.noise_seed, { step: 1, placeholder: "留空=默认" }),
      "留空用默认种子；填整数可复现同一分解",
      "pre-narrow",
    );

    const hints = [];
    if (meta.trials) hints.push("上次 trials " + meta.trials);
    if (meta.noise !== undefined) hints.push("噪声比 " + meta.noise);
    if (meta.seed !== undefined) {
      hints.push("种子 " + meta.seed + (meta.seed_default ? "（默认）" : ""));
    }
    if (meta.engine) hints.push("引擎 " + meta.engine);
    if (hints.length) body += '<p class="pre-static">' + T.esc(hints.join(" · ")) + "</p>";

    body += applyRow("eemdApplyBtn", "运行分解", "eemdResetBtn");
    return panelShell("eemdParamPanel", "EEMD 参数", "Ensemble EMD", body);
  }

  function bindEemdPanel() {
    const applyBtn = document.getElementById("eemdApplyBtn");
    if (!applyBtn) return;

    const resetBtn = document.getElementById("eemdResetBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.resetEemd();
        const e = state.eemd;
        const trials = document.getElementById("eemdTrials");
        const noise = document.getElementById("eemdNoise");
        const imfs = document.getElementById("eemdMaxImfs");
        const seed = document.getElementById("eemdSeed");
        if (trials) trials.value = e.trials;
        if (noise) noise.value = e.noise_ratio;
        if (imfs) imfs.value = e.max_imfs;
        if (seed) seed.value = "";
      });
    }

    applyBtn.addEventListener("click", () => {
      const trials = readNumber("eemdTrials", null);
      const noise = readNumber("eemdNoise", null);
      const maxImfs = readNumber("eemdMaxImfs", null);
      const seed = readNumber("eemdSeed", null);

      if (trials === null) return toast("请填写集合次数 trials", "warn");
      if (noise === null) return toast("请填写噪声比 noise_ratio", "warn");
      if (maxImfs === null) return toast("请填写最大 IMF 个数", "warn");

      const t = Math.round(trials);
      if (t < 5 || t > 300) return toast("集合次数需在 5 ~ 300 之间", "warn");
      if (!(noise > 0 && noise <= 1)) return toast("噪声比需在 0 ~ 1 之间", "warn");
      const m = Math.round(maxImfs);
      if (m < 2 || m > 10) return toast("最大 IMF 个数需在 2 ~ 10 之间", "warn");
      if (seed !== null && !Number.isInteger(seed)) return toast("随机种子必须是整数", "warn");

      state.eemd = {
        max_imfs: m,
        noise_ratio: noise,
        noise_seed: seed === null ? null : Math.round(seed),
        trials: t,
      };
      if (hooks.rerunAnalysis) hooks.rerunAnalysis();
    });
  }

  global.PaleoParamPanel = {
    init,
    renderPreprocessPanel,
    bindPreprocessPanel,
    renderSpectrumPanel,
    bindSpectrumPanel,
    renderPeriodPanel,
    bindPeriodPanel,
    renderWaveletPanel,
    bindWaveletPanel,
    renderAbruptPanel,
    bindAbruptPanel,
    renderEemdPanel,
    bindEemdPanel,
    renderVariablePanel,
    bindVariablePanel,
    renderComparePanel,
    bindComparePanel,
  };
})(window);
