/**
 * 前端 API 客户端与全局状态。
 */
(function (global) {
  "use strict";

  const API = "/api";

  async function request(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const response = await fetch(API + path, opts);
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      let message = "请求失败 (" + response.status + ")";
      if (contentType.includes("application/json")) {
        const data = await response.json().catch(() => ({}));
        message = data.detail || data.message || message;
        if (data.errors) message += data.errors[0].loc.slice(1).join(".") + " " + data.errors[0].msg
      } else {
        const text = await response.text().catch(() => "");
        if (text) message = text.slice(0, 300);
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    if (contentType.includes("application/json")) return response.json();
    // 图片 / NetCDF 等二进制响应必须按 blob 处理，用 text() 会把字节解坏
    if (contentType.includes("image/") || contentType.includes("octet-stream")) {
      return response.blob();
    }
    if (contentType.includes("application/x-netcdf") || contentType.includes("application/netcdf")) {
      return response.blob();
    }
    if (!contentType || contentType.includes("text/") || contentType.includes("csv")) {
      return response.text();
    }
    return response.blob();
  }

  function qs(params) {
    const usable = Object.entries(params || {}).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    );
    if (!usable.length) return "";
    return (
      "?" +
      usable
        .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
        .join("&")
    );
  }

  /** 用户手动指定的坐标轴映射，会附加到所有数据请求上。 */
  let axisOverrides = {};

  function axisQuery() {
    const out = {};
    if (axisOverrides.time) out.axis_time = axisOverrides.time;
    if (axisOverrides.lat) out.axis_lat = axisOverrides.lat;
    if (axisOverrides.lon) out.axis_lon = axisOverrides.lon;
    return out;
  }

  const api = {
    health: () => request("/health"),
    config: () => request("/config"),

    listFiles: () => request("/files"),
    upload: (file, onProgress) => uploadWithProgress(file, onProgress),
    fileDetail: (id) => request("/files/" + id),
    deleteFile: (id) => request("/files/" + id, { method: "DELETE" }),
    downloadUrl: (id) => API + "/files/" + id + "/download",
    bundleUrl: (id) => API + "/files/" + id + "/bundle",
    previewMapUrl: (id, params) => API + "/files/" + id + "/preview/map" + qs(params),
    previewSeriesUrl: (id, params) => API + "/files/" + id + "/preview/series" + qs(params),
    exportSubset: (id, body) => request("/files/" + id + "/export", { method: "POST", body }),

    overview: (id) => request("/datasets/" + id + "/overview" + qs(axisQuery())),
    layout: (id) => request("/datasets/" + id + "/layout" + qs(axisQuery())),
    variables: (id) => request("/datasets/" + id + "/variables" + qs(axisQuery())),
    series: (id, params) =>
      request("/datasets/" + id + "/series" + qs(Object.assign({}, params, axisQuery()))),
    field: (id, params) =>
      request("/datasets/" + id + "/field" + qs(Object.assign({}, params, axisQuery()))),
    setAxisOverrides: (mapping) => {
      axisOverrides = Object.assign({}, mapping || {});
    },
    getAxisOverrides: () => Object.assign({}, axisOverrides),
    selectorSeries: (id, body) =>
      request("/datasets/" + id + "/selector-series", { method: "POST", body }),

    // 分析接口同样需要坐标轴覆盖参数（axis_time/axis_lat/axis_lon），
    // 否则服务端 open_dataset 依赖会退回到自动识别。
    powerSpectrum: (id, body) =>
      request("/analysis/" + id + "/power-spectrum" + qs(axisQuery()), { method: "POST", body }),
    wavelet: (id, body) =>
      request("/analysis/" + id + "/wavelet" + qs(axisQuery()), { method: "POST", body }),
    period: (id, body) =>
      request("/analysis/" + id + "/period" + qs(axisQuery()), { method: "POST", body }),
    abrupt: (id, body) =>
      request("/analysis/" + id + "/abrupt-change" + qs(axisQuery()), { method: "POST", body }),
    eemd: (id, body) =>
      request("/analysis/" + id + "/eemd" + qs(axisQuery()), { method: "POST", body }),
    /** 导出 EEMD 分量：component 为 null 表示全部 IMF + 残差；target=library 写入数据文件 */
    eemdExport: (id, body) =>
      request("/analysis/" + id + "/eemd/export" + qs(axisQuery()), { method: "POST", body }),
    /** 把提取+预处理后的序列写入数据文件（或下载） */
    seriesExport: (id, body) =>
      request("/analysis/" + id + "/series/export" + qs(axisQuery()), { method: "POST", body }),
    crossSpectrum: (id, body) =>
      request("/analysis/" + id + "/cross-spectrum" + qs(axisQuery()), { method: "POST", body }),
    correlationInFile: (id, body) =>
      request("/analysis/" + id + "/correlation" + qs(axisQuery()), { method: "POST", body }),
    compareInFile: (id, body) =>
      request("/analysis/" + id + "/compare" + qs(axisQuery()), { method: "POST", body }),
    /** 取指定文件的变量列表（不带坐标轴覆盖，用于跨文件分析的文件下拉联动） */
    fileVariables: (id) => request("/datasets/" + id + "/variables"),
    correlation: (body) => request("/analysis/correlation", { method: "POST", body }),
    compare: (body) => request("/analysis/compare", { method: "POST", body }),
  };

  function uploadWithProgress(file, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", API + "/files");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onload = () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || "{}");
        } catch (err) {
          payload = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload);
        } else {
          reject(new Error(payload.detail || "上传失败 (" + xhr.status + ")"));
        }
      };
      xhr.onerror = () => reject(new Error("网络错误，上传中断"));
      xhr.send(form);
    });
  }

  // ------------------------------------------------------------------ 全局状态

  /**
   * 数据集布局，对应后端 app/core/layout.py 的 classify_layout() 返回值。
   * @typedef {Object} DataLayout
   * @property {"timeseries"|"hovmoller"|"map"|"grid"|"profile"|"unknown"} kind 布局类型
   * @property {string[]} dims 变量维度名列表
   * @property {string|null} time 时间维名
   * @property {string|null} lat 纬度维名
   * @property {string|null} lon 经度维名
   * @property {boolean} has_map 是否提供地图 / 时间-空间视图
   * @property {"map"|"hovmoller"|null} map_mode 地图视图的渲染方式
   * @property {"lat"|"lon"|null} hovmoller_axis Hovmöller 图使用的空间轴
   * @property {string} label 中文描述，用于界面标题
   */
  /**
   * /api/datasets/{id}/series 的返回体。
   * @typedef {Object} SeriesPayload
   * @property {string} variable 变量名
   * @property {string} units 单位
   * @property {string} long_name 变量长名
   * @property {"timeseries"|"point"|"area_mean"} mode 取数方式
   * @property {string[]} time 时间标签
   * @property {number[]} time_index 全局时次索引
   * @property {number[]} values 当前值（启用预处理后为处理结果）
   * @property {number[]} raw_values 预处理前的原始值
   * @property {{lat?:number,lat_index?:number,lon?:number,lon_index?:number}} [grid] 实际命中的格点
   * @property {{lat?:number[],lon?:number[]}} [extent] 区域平均时实际参与计算的范围
   * @property {{n:number,min:number|null,max:number|null,mean:number|null,std:number|null,median:number|null,nan_count:number}} stats 统计量
   * @property {{applied:boolean,steps:string[],spec:Object,dt:number,reason?:string}} [preprocess] 预处理说明
   */
  const state = {
    // ---- 文件与数据集 ----
    /** 文件列表，元素形如 { id, name, size, uploaded_at, source, suffix, readonly } */
    files: [],
    /** 当前文件 id */
    currentFileId: null,
    /** 已确认加入「数据文件」列表的文件 id（有序） */
    addedFileIds: [],
    /** 弹窗内临时勾选的文件 id（点确定前不生效） */
    modalSelection: new Set(),
    /** 数据集概览，结构见 /api/datasets/{id}/overview */
    overview: null,
    /** 变量元数据数组（overview.variables 的值） */
    variables: [],
    /** 当前变量名 */
    variable: null,
    /** 当前数据集的布局，结构见 DataLayout；未选文件时为 null */
    layout: null,
    /** 文件 id -> 布局类型（kind），供文件弹窗显示类型标签 */
    fileLayouts: {},
    /** 用户手动指定的坐标轴：{ time?, lat?, lon? }，空对象表示完全自动识别 */
    axisOverrides: {},

    // ---- 时间与空间选取 ----
    /** 时间范围（闭区间时次索引），null 表示整个时段 */
    timeRange: null,
    /** 空间选取：point 模式用 lat/lon，area 模式用 latMin/latMax/lonMin/lonMax */
    selection: {
      /** "point" | "area" */
      mode: "point",
      lat: 35,
      lon: 105,
      latMin: -10,
      latMax: 50,
      lonMin: 70,
      lonMax: 140,
      /** 区域处理方式："mean"（纬度加权平均）| "sum"（求和）| "std"（标准差） */
      areaMethod: "mean",
    },
    /** 是否允许在地图上拖框选区域（仅完整经纬度场允许） */
    allowRectSelect: true,

    // ---- 地图场 ----
    /** 地图场类型：climatology（气候态） / anomaly（异常场） */
    fieldMode: "climatology",
    /** 异常场基准时段（闭区间索引），两端为 null 时由后端取默认 0 ~ max//2 */
    anomalyBaseline: { start: null, end: null },
    /** 最近一次 Hovmöller 场，结构见 /api/datasets/{id}/field 返回体 */
    hovmoller: null,

    // ---- 预处理（图表视图设置，分析视图复用） ----
    preprocess: {
      /** 去趋势方式："none" | "linear" | "mean" */
      detrend: "none",
      /** 是否做 z-score 标准化 */
      standardize: false,
      /** 滤波类型："none" | "lowpass" | "highpass" | "bandpass" */
      filter: "none",
      /** 最短周期（低通、带通用，单位与时间轴一致） */
      filter_period_min: null,
      /** 最长周期（高通、带通用，单位与时间轴一致） */
      filter_period_max: null,
      /** Butterworth 滤波器阶数 */
      order: 4,
    },

    // ---- 分析参数（各分析视图的参数面板） ----
    /** 功率谱参数，见 resetSpectrum() 的默认值 */
    spectrum: null,

    // ---- 请求结果 ----
    /** 当前序列，结构见 SeriesPayload */
    series: null,
    /** 预处理前的原始序列（与 series.raw_values 一致，便于对比） */
    seriesRaw: null,
    /** 最近一次分析结果，字段随分析类型而变 */
    analysis: null,

    // ---- 事件与请求 ----
    /** 事件监听表：{ [event]: handler[] } */
    listeners: {},
    /** 分析接口请求体构造器，下方以 state.body = function (extra) {...} 赋值 */
    body: null,
  };

  /** 判断当前是否配置了任何预处理。 */
  state.hasPreprocess = function () {
    const p = state.preprocess;
    return Boolean(
      (p.detrend && p.detrend !== "none") ||
      p.standardize ||
      (p.filter && p.filter !== "none"),
    );
  };

  /** 生成预处理查询参数（用于 /series 的 GET 请求）。 */
  state.preprocessQuery = function () {
    const p = state.preprocess;
    const out = {};
    if (p.detrend && p.detrend !== "none") out.detrend = p.detrend;
    if (p.standardize) out.standardize = true;
    if (p.filter && p.filter !== "none") {
      out.filter = p.filter;
      if (p.filter_period_min) out.filter_period_min = p.filter_period_min;
      if (p.filter_period_max) out.filter_period_max = p.filter_period_max;
      if (p.order) out.filter_order = p.order;
    }
    return out;
  };

  /** 生成预处理请求体（用于 POST 分析接口）。 */
  state.preprocessBody = function () {
    const p = state.preprocess;
    const spec = {
      detrend: p.detrend || "none",
      standardize: Boolean(p.standardize),
      filter: p.filter || "none",
      filter_period_min: p.filter_period_min || null,
      filter_period_max: p.filter_period_max || null,
      order: p.order || 4,
    };
    return spec;
  };

  /** 功率谱参数默认值（各字段含义见 app/api/schemas.py 的 SpectrumRequest）。 */
  state.spectrumDefaults = function () {
    return {
      /** 时间轴 */
      timeRange: null,
      /** 计算方法："periodogram" | "redfit" | "mtm" */
      method: "periodogram",
      /** 周期图窗函数 */
      window: "hann",
      /** 显示周期范围（null 表示自动取整段） */
      min_periods: null,
      max_periods: null,
      /** 置信水平 */
      confidence: 0.95,
      /** X 轴刻度："linear" | "log" */
      xScale: "linear",
      /** REDFIT 参数 */
      n50: 2,
      ofac: 2,
      hifac: 1,
      iwin: "rectangular",
      /** REDFIT 显著性检验：false 走 AR(1) 红噪声解析检验，true 走蒙特卡洛模拟 */
      mctest: false,
      /** 蒙特卡洛模拟次数（仅 mctest 为 true 时生效） */
      nsim: 1000,
      /** MTM 参数 */
      nw: 4,
      k: null,
    };
  };

  state.resetSpectrum = function () {
    state.spectrum = state.spectrumDefaults();
    return state.spectrum;
  };

  state.spectrum = state.spectrumDefaults();

  /** 小波参数默认值（字段含义见 app/api/schemas.py 的 WaveletRequest）。 */
  state.waveletDefaults = function () {
    return {
      /** 最大尺度（采样点数），j1_n_div_dj 留空时用它推导八度数 */
      max_scale: 64,
      /** 显著性水平 */
      confidence: 0.95,
      /** 1=补零到 2 的幂，0=不补零 */
      pad: 1,
      /** 尺度间隔 */
      dj: 0.25,
      /** 多少个 2 的幂（null=由 max_scale 推导） */
      j1_n_div_dj: null,
      /** 最小尺度（null=2·dt） */
      s0: null,
      /** AR(1) 系数（null=自动估计） */
      lag1: null,
      /** 母小波 */
      mother: "morlet",
      /** 母小波参数（null=库默认） */
      mother_param: null,
      /** 小波显著性检验方式 */
      sigtest_wavelet: "regular chi-square test",
      /** 全局谱显著性检验方式 */
      sigtest_global: "time-average test",
      /** 显示：X 轴刻度 */
      xScale: "linear",
      /** 显示：Y 轴刻度 */
      yScale: "linear",
      /** 显示：显著性等值线 */
      showContour: true,
      /** 显示：影响锥 */
      showCone: true,
    };
  };

  state.resetWavelet = function () {
    state.wavelet = state.waveletDefaults();
    return state.wavelet;
  };

  state.wavelet = state.waveletDefaults();

  /** 生成小波请求参数（只带计算相关字段，显示参数留在前端）。 */
  state.waveletBody = function () {
    const w = state.wavelet || state.waveletDefaults();
    const out = {
      max_scale: w.max_scale,
      confidence: w.confidence,
      pad: w.pad,
      dj: w.dj,
      mother: w.mother,
      sigtest_wavelet: w.sigtest_wavelet,
      sigtest_global: w.sigtest_global,
    };
    if (w.j1_n_div_dj) out.j1_n_div_dj = w.j1_n_div_dj;
    if (w.s0) out.s0 = w.s0;
    if (w.lag1 !== null && w.lag1 !== undefined && w.lag1 !== "") out.lag1 = w.lag1;
    if (w.mother_param !== null && w.mother_param !== undefined && w.mother_param !== "") {
      out.mother_param = w.mother_param;
    }
    return out;
  };

  /** EEMD 参数默认值（字段含义见 app/api/schemas.py 的 EemdRequest）。 */
  state.eemdDefaults = function () {
    return {
      /** 最多保留的 IMF 个数，其余并入残差 */
      max_imfs: 6,
      /** 噪声幅度（相对序列标准差） */
      noise_ratio: 0.2,
      /** 噪声随机种子；null 表示使用后端默认种子 */
      noise_seed: null,
      /** 集合次数 */
      trials: 100,
    };
  };

  state.eemd = state.eemdDefaults();

  state.resetEemd = function () {
    state.eemd = state.eemdDefaults();
    return state.eemd;
  };

  state.eemdBody = function (extra) {
    const e = state.eemd || state.eemdDefaults();
    const out = {
      max_imfs: e.max_imfs,
      noise_ratio: e.noise_ratio,
      trials: e.trials,
    };
    if (e.noise_seed !== null && e.noise_seed !== undefined && e.noise_seed !== "") {
      out.noise_seed = Number(e.noise_seed);
    }
    return Object.assign(out, extra || {});
  };

  /**
   * 双变量分析的「数据 - 变量」选择状态。
   * 交叉谱 / 相关性 / 对比都取两个「数据文件 + 变量」组合；文件只有一个时
   * 两个组合退化为同一文件里的两个变量（沿用旧行为）。
   * 具体选择在分析视图的参数面板里完成（见 parameter_panel.js 的 renderVariablePanel）。
   */
  state.pairDefaults = function () {
    return {
      /** 数据 A 的文件 id；null 表示用当前文件 */
      file_a: null,
      /** 数据 B 的文件 id；null 表示与 A 相同 */
      file_b: null,
      /** 第一个变量名；null 表示交给后端按顺序取 */
      variable_a: null,
      /** 第二个变量名 */
      variable_b: null,
    };
  };

  state.pair = state.pairDefaults();

  state.resetPair = function () {
    state.pair = state.pairDefaults();
    return state.pair;
  };

  /** 生成双变量分析请求参数（未选择时不带该字段，沿用后端默认顺序）。 */
  state.pairBody = function (extra) {
    const p = state.pair || state.pairDefaults();
    const out = {};
    if (p.file_a) out.file_a = p.file_a;
    if (p.file_b) out.file_b = p.file_b;
    if (p.variable_a) out.variable_a = p.variable_a;
    if (p.variable_b) out.variable_b = p.variable_b;
    return Object.assign(out, extra || {});
  };

  /** 文件 id -> 变量元数据数组，供跨文件分析的文件下拉联动（按需懒加载）。 */
  state.fileVariables = {};

  /** 周期分析参数默认值（字段含义见 app/api/schemas.py 的 PeriodRequest）。 */
  state.periodDefaults = function () {
    return {
      /** 最长显示周期（null=按序列长度自动） */
      max_period: null,
      /** 红噪声显著性水平 */
      confidence: 0.95,
      /** 自相关最大滞后（null=自动） */
      max_lag: null,
      /** 最大熵阶数（null=自动） */
      order: null,
      /** 显示：X 轴刻度 */
      xScale: "log",
    };
  };

  state.resetPeriod = function () {
    state.period = state.periodDefaults();
    return state.period;
  };

  state.period = state.periodDefaults();

  /** 生成周期分析请求参数（只带计算相关字段，显示参数留在前端）。 */
  state.periodBody = function () {
    const p = state.period || state.periodDefaults();
    const out = { confidence: p.confidence };
    if (p.max_period) out.max_period = p.max_period;
    if (p.max_lag) out.max_lag = p.max_lag;
    if (p.order) out.order = p.order;
    return out;
  };

  /** 突变分析参数默认值（字段含义见 app/api/schemas.py 的 AbruptRequest）。 */
  state.abruptDefaults = function () {
    return {
      /** 检测方法："all" 同时跑三种检验 */
      method: "all",
      /** 滑动 t 检验的窗口大小（单侧点数） */
      window: 100,
    };
  };

  state.resetAbrupt = function () {
    state.abrupt = state.abruptDefaults();
    return state.abrupt;
  };

  state.abrupt = state.abruptDefaults();

  /** 生成突变分析请求参数。 */
  state.abruptBody = function () {
    const a = state.abrupt || state.abruptDefaults();
    return { method: a.method || "all", window: a.window || 10 };
  };

  /** 生成功率谱请求参数（只带当前方法用得到的字段）。 */
  state.spectrumBody = function () {
    const s = state.spectrum || state.spectrumDefaults();
    const out = { method: s.method, confidence: s.confidence };
    if (s.method === "periodogram") out.window = s.window;
    if (s.method === "redfit") {
      out.n50 = s.n50;
      out.ofac = s.ofac;
      out.hifac = s.hifac;
      out.iwin = s.iwin;
      out.mctest = !!s.mctest;
      if (s.mctest) out.nsim = s.nsim;
    }
    if (s.method === "mtm") {
      out.nw = s.nw;
      if (s.k) out.k = s.k;
    }
    if (s.min_periods) out.min_periods = s.min_periods;
    if (s.max_periods) out.max_periods = s.max_periods;
    out.timeRange = state.timeRange;
    return out;
  };

  state.on = function (event, handler) {
    (state.listeners[event] = state.listeners[event] || []).push(handler);
  };

  state.emit = function (event, payload) {
    (state.listeners[event] || []).forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        console.error("listener error", event, err);
      }
    });
  };

  state.set = function (patch) {
    Object.assign(state, patch);
    state.emit("change", state);
  };

  /** 当前数据只支持哪个空间轴：'lat' | 'lon' | null（两者都支持）。 */
  state.spaceAxis = function () {
    const layout = state.layout || {};
    if (layout.map_mode !== "hovmoller") return null;
    return layout.hovmoller_axis === "lat" || layout.hovmoller_axis === "lon"
      ? layout.hovmoller_axis
      : null;
  };

  /** 把当前选取条件转换成后端需要的查询参数。 */
  state.query = function () {
    const params = {};
    if (state.variable) params.variable = state.variable;
    if (state.timeRange) {
      params.start = state.timeRange[0];
      params.end = state.timeRange[1];
    }
    const sel = state.selection;
    const axis = state.spaceAxis();
    const wantLat = axis !== "lon";
    const wantLon = axis !== "lat";

    if (sel.mode === "point") {
      if (wantLat) params.lat = sel.lat;
      if (wantLon) params.lon = sel.lon;
    } else {
      if (wantLat) {
        params.lat_min = sel.latMin;
        params.lat_max = sel.latMax;
      }
      if (wantLon) {
        params.lon_min = sel.lonMin;
        params.lon_max = sel.lonMax;
      }
      params.area_method = sel.areaMethod || "mean";
    }
    return params;
  };

  /** 把当前选取条件转换成分析接口的请求体（含预处理配置）。 */
  state.body = function (extra) {
    const body = { variable: state.variable };
    if (state.timeRange) {
      body.start = state.timeRange[0];
      body.end = state.timeRange[1];
    }
    const sel = state.selection;
    const axis = state.spaceAxis();
    const wantLat = axis !== "lon";
    const wantLon = axis !== "lat";
    if (sel.mode === "point") {
      if (wantLat) body.lat = sel.lat;
      if (wantLon) body.lon = sel.lon;
    } else {
      if (wantLat) body.lat_range = [sel.latMin, sel.latMax];
      if (wantLon) body.lon_range = [sel.lonMin, sel.lonMax];
      body.area_method = sel.areaMethod || "mean";
    }
    // 关键：分析视图沿用图表视图的预处理
    if (state.hasPreprocess()) {
      body.preprocess = state.preprocessBody();
    }
    return Object.assign(body, extra || {});
  };

  global.PaleoAPI = api;
  global.PaleoState = state;
})(window);
