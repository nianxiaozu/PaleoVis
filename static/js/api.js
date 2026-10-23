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
      } else {
        const text = await response.text().catch(() => "");
        if (text) message = text.slice(0, 300);
      }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    if (contentType.includes("application/json")) return response.json();
    if (contentType.includes("image/")) return response.blob();
    return response.text();
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

    powerSpectrum: (id, body) =>
      request("/analysis/" + id + "/power-spectrum", { method: "POST", body }),
    wavelet: (id, body) => request("/analysis/" + id + "/wavelet", { method: "POST", body }),
    period: (id, body) => request("/analysis/" + id + "/period", { method: "POST", body }),
    abrupt: (id, body) => request("/analysis/" + id + "/abrupt-change", { method: "POST", body }),
    eemd: (id, body) => request("/analysis/" + id + "/eemd", { method: "POST", body }),
    crossSpectrum: (id, body) =>
      request("/analysis/" + id + "/cross-spectrum", { method: "POST", body }),
    correlationInFile: (id, body) =>
      request("/analysis/" + id + "/correlation", { method: "POST", body }),
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
