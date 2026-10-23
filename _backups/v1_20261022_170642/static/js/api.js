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

    overview: (id) => request("/datasets/" + id + "/overview"),
    variables: (id) => request("/datasets/" + id + "/variables"),
    series: (id, params) => request("/datasets/" + id + "/series" + qs(params)),
    field: (id, params) => request("/datasets/" + id + "/field" + qs(params)),
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

  /** 全局状态：当前文件、变量、时间范围与选取方式。 */
  const state = {
    files: [],
    currentFileId: null,
    overview: null,
    variables: [],
    variable: null,
    timeRange: null,
    selection: { mode: "point", lat: 35, lon: 105, latMin: -10, latMax: 50, lonMin: 70, lonMax: 140 },
    // 预处理配置：图表视图设置，分析视图复用
    preprocess: {
      detrend: "none",
      standardize: false,
      filter: "none",
      filter_period_min: null,
      filter_period_max: null,
      order: 4,
    },
    series: null,
    seriesRaw: null,
    analysis: null,
    listeners: {},
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

  /** 把当前选取条件转换成后端需要的查询参数。 */
  state.query = function () {
    const params = {};
    if (state.variable) params.variable = state.variable;
    if (state.timeRange) {
      params.start = state.timeRange[0];
      params.end = state.timeRange[1];
    }
    const sel = state.selection;
    if (sel.mode === "point") {
      params.lat = sel.lat;
      params.lon = sel.lon;
    } else {
      params.lat_min = sel.latMin;
      params.lat_max = sel.latMax;
      params.lon_min = sel.lonMin;
      params.lon_max = sel.lonMax;
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
    if (sel.mode === "point") {
      body.lat = sel.lat;
      body.lon = sel.lon;
    } else {
      body.lat_range = [sel.latMin, sel.latMax];
      body.lon_range = [sel.lonMin, sel.lonMax];
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
