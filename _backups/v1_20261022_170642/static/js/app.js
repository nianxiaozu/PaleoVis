/**
 * 应用主逻辑：菜单、标签页、文件管理、数据查询与分析调度。
 */
(function (global) {
  "use strict";

  const api = global.PaleoAPI;
  const state = global.PaleoState;
  const C = global.PaleoChart;
  const T = global.PaleoTheme;

  const ui = {
    tabs: {},
    containers: {},
    currentTab: "data-view",
    currentTool: null,
    map: null,
    xrView: null,
    config: null,
    seriesCache: [],
  };

  // ------------------------------------------------------------- 启动
  document.addEventListener("DOMContentLoaded", () => {
    cacheDom();
    bindMenus();
    bindTabs();
    bindSidebar();
    bindActions();
    bindDragDrop();
    initServer();
    updateSelectionSummary();
    loadFiles();
  });

  function cacheDom() {
    ["dataContainer", "mapContainer", "chartContainer", "analysisContainer"].forEach((id) => {
      ui.containers[id] = document.getElementById(id);
    });
    document.querySelectorAll(".tab").forEach((tab) => {
      ui.tabs[tab.dataset.tab] = tab;
    });
  }

  // ------------------------------------------------------------- 菜单
  function bindMenus() {
    const items = document.querySelectorAll(".menu-item");
    items.forEach((item) => {
      const trigger = item.querySelector(".menu-trigger");
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        const isOpen = item.classList.contains("open");
        items.forEach((i) => i.classList.remove("open"));
        if (!isOpen) item.classList.add("open");
      });
    });

    document.addEventListener("click", () => {
      items.forEach((i) => i.classList.remove("open"));
    });

    document.querySelectorAll(".menu-option").forEach((option) => {
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        items.forEach((i) => i.classList.remove("open"));
        const tool = option.dataset.tool;
        if (tool === "select") {
          document.getElementById("fileInput").click();
          return;
        }
        if (tool === "map") {
          switchTab("map-view");
          return;
        }
        if (tool === "compare") {
          switchTab("analysis-view");
          runCompare();
          return;
        }
        switchTab("analysis-view");
        runAnalysis(tool);
      });
    });
  }

  // ------------------------------------------------------------- 标签页
  function bindTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    });
  }

  function switchTab(name) {
    ui.currentTab = name;
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });
    const map = {
      "data-view": "dataContainer",
      "map-view": "mapContainer",
      "chart-view": "chartContainer",
      "analysis-view": "analysisContainer",
    };
    Object.entries(map).forEach(([tab, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle("is-active", tab === name);
    });
    if (name === "map-view") ensureMap();
  }

  function ensureMap() {
    if (!ui.map) {
      ui.map = new global.PaleoMap("mapContainer", {
        onSelectPoint: ({ lat, lon }) => {
          state.selection.mode = "point";
          state.selection.lat = round2(lat);
          state.selection.lon = round2(lon);
          document.getElementById("latitude").value = state.selection.lat;
          document.getElementById("longitude").value = state.selection.lon;
          setSelectionMode("point");
          updateSelectionSummary();
          toast("已选择点位 " + formatLatLon(state.selection.lat, state.selection.lon));
        },
        onSelectArea: (rect) => {
          state.selection.mode = "area";
          state.selection.latMin = rect.latMin;
          state.selection.latMax = rect.latMax;
          state.selection.lonMin = rect.lonMin;
          state.selection.lonMax = rect.lonMax;
          syncAreaInputs();
          setSelectionMode("area");
          updateSelectionSummary();
          toast(
            "已框选区域 " +
              rect.latMin.toFixed(1) + "° ~ " + rect.latMax.toFixed(1) + "°N, " +
              rect.lonMin.toFixed(1) + "° ~ " + rect.lonMax.toFixed(1) + "°E",
          );
        },
      });
      ui.map.init();
      ui.map.setMode(state.selection.mode);
    }
    requestAnimationFrame(() => ui.map.resize());
    refreshMapField();
  }

  function round2(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  function formatLatLon(lat, lon) {
    const latTag = lat >= 0 ? "°N" : "°S";
    const lonTag = lon >= 0 ? "°E" : "°W";
    return Math.abs(lat).toFixed(2) + latTag + ", " + Math.abs(lon).toFixed(2) + lonTag;
  }

  /** 把 state 中的区域范围写回侧边栏输入框。 */
  function syncAreaInputs() {
    const sel = state.selection;
    const map = { latMin: sel.latMin, latMax: sel.latMax, lonMin: sel.lonMin, lonMax: sel.lonMax };
    Object.entries(map).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el && value !== undefined && value !== null) el.value = value;
    });
  }

  /** 侧边栏底部显示当前选取摘要。 */
  function updateSelectionSummary() {
    const box = document.getElementById("selectionSummary");
    if (!box) return;
    const sel = state.selection;
    if (sel.mode === "point") {
      box.innerHTML =
        '<span class="sel-tag">点位</span>' + T.esc(formatLatLon(sel.lat, sel.lon));
    } else {
      box.innerHTML =
        '<span class="sel-tag">区域</span>' +
        T.esc(
          sel.latMin.toFixed(1) + "° ~ " + sel.latMax.toFixed(1) + "°N, " +
            sel.lonMin.toFixed(1) + "° ~ " + sel.lonMax.toFixed(1) + "°E",
        );
    }
  }

  // ------------------------------------------------------------- 侧边栏
  function bindSidebar() {
    applyTimeRange();
    document.getElementById("fetchBtn").addEventListener("click", fetchSeries);
    ["latitude", "longitude"].forEach((id) => {
      document.getElementById(id).addEventListener("keydown", (event) => {
        if (event.key === "Enter") fetchSeries();
      });
    });

    document.getElementById("variableSelect").addEventListener("change", (event) => {
      state.variable = event.target.value || null;
      refreshMapField();
      updateDataInfo();
    });

    document.querySelectorAll("[data-selection-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setSelectionMode(btn.dataset.selectionMode);
        refreshMapField();
      });
    });

    // 手动修改区域边界时，同步到地图上的框
    ["latMin", "latMax", "lonMin", "lonMax"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        if (state.selection.mode !== "area") return;
        const value = parseFloat(el.value);
        if (!isFinite(value)) return;
        state.selection[id] = value;
        if (ui.map) {
          const sel = state.selection;
          ui.map.setSelectionRect({
            latMin: sel.latMin,
            latMax: sel.latMax,
            lonMin: sel.lonMin,
            lonMax: sel.lonMax,
          });
        }
        updateSelectionSummary();
      });
    });

    ["latMin", "latMax", "lonMin", "lonMax"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", refreshMapField);
    });

    bindTimeRange();
  }

  /** 双滑块 + 两个数字输入框，统一驱动 state.timeRange。 */
  function bindTimeRange() {
    const start = document.getElementById("timeStart");
    const end = document.getElementById("timeEnd");
    const startInput = document.getElementById("timeStartInput");
    const endInput = document.getElementById("timeEndInput");
    if (!start || !end) return;

    let mapTimer = null;
    const scheduleMap = () => {
      clearTimeout(mapTimer);
      mapTimer = setTimeout(() => refreshMapField(), 220);
    };

    // 滑块拖动：两个手柄不能交叉
    const onSlide = (which) => () => {
      let a = Number(start.value);
      let b = Number(end.value);
      const max = Number(start.max) || 0;
      if (which === "start") {
        a = Math.min(a, b);
        start.value = a;
      } else {
        b = Math.max(b, a);
        end.value = b;
      }
      a = Math.max(0, Math.min(a, max));
      b = Math.max(0, Math.min(b, max));
      state.timeRange = [a, b];
      syncTimeInputs();
      updateRangeFill();
      updateTimeLabel();
      scheduleMap();
    };
    start.addEventListener("input", onSlide("start"));
    end.addEventListener("input", onSlide("end"));

    // 数字输入框：失焦或回车时提交
    const commitInput = (which) => () => {
      const max = Number(start.max) || 0;
      let a = Number(startInput.value);
      let b = Number(endInput.value);
      if (!isFinite(a)) a = 0;
      if (!isFinite(b)) b = max;
      a = Math.max(0, Math.min(Math.round(a), max));
      b = Math.max(0, Math.min(Math.round(b), max));
      if (a > b) {
        if (which === "start") b = a;
        else a = b;
      }
      start.value = a;
      end.value = b;
      state.timeRange = [a, b];
      syncTimeInputs();
      updateRangeFill();
      updateTimeLabel();
      scheduleMap();
    };
    [startInput, endInput].forEach((el, idx) => {
      if (!el) return;
      const which = idx === 0 ? "start" : "end";
      el.addEventListener("change", commitInput(which));
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          commitInput(which)();
          el.blur();
        }
      });
    });
  }

  /** 把 state.timeRange 写回两个数字输入框。 */
  function syncTimeInputs() {
    if (!state.timeRange) return;
    const startInput = document.getElementById("timeStartInput");
    const endInput = document.getElementById("timeEndInput");
    if (startInput) startInput.value = state.timeRange[0];
    if (endInput) endInput.value = state.timeRange[1];
  }

  /** 更新滑块之间的高亮条。 */
  function updateRangeFill() {
    const fill = document.getElementById("rangeFill");
    const start = document.getElementById("timeStart");
    if (!fill || !start) return;
    const max = Number(start.max) || 100;
    const a = Number(start.value);
    const b = Number(document.getElementById("timeEnd").value);
    const left = max > 0 ? (a / max) * 100 : 0;
    const right = max > 0 ? (b / max) * 100 : 100;
    fill.style.left = left + "%";
    fill.style.width = Math.max(0, right - left) + "%";
  }

  function updateTimeLabel() {
    const label = document.getElementById("timeRangeLabel");
    if (!label) return;
    const time = state.overview && state.overview.axes && state.overview.axes.time;
    if (!time || !time.size || !state.timeRange) {
      label.textContent = "全部时段";
      return;
    }
    const labels = time.labels || [];
    const start = labels[state.timeRange[0]] || String(state.timeRange[0]);
    const end = labels[state.timeRange[1]] || String(state.timeRange[1]);
    const count = state.timeRange[1] - state.timeRange[0] + 1;
    label.textContent = start + " ~ " + end + "（共 " + count + " 个时次）";
  }

  function setSelectionMode(mode) {
    state.selection.mode = mode;
    document.querySelectorAll("[data-selection-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.selectionMode === mode);
    });
    document.getElementById("pointFields").style.display = mode === "point" ? "" : "none";
    document.getElementById("areaFields").style.display = mode === "area" ? "" : "none";
    if (ui.map) {
      ui.map.setMode(mode);
      // 区域模式：把当前区域同步成地图上的框，方便直观看到范围
      if (mode === "area") {
        const sel = state.selection;
        ui.map.setSelectionRect({
          latMin: sel.latMin,
          latMax: sel.latMax,
          lonMin: sel.lonMin,
          lonMax: sel.lonMax,
        });
      }
    }
    updateSelectionSummary();
  }

  function applyTimeRange() {
    if (!state.overview) return;
    const time = state.overview.axes.time;
    if (!time || !time.size) {
      state.timeRange = null;
      return;
    }
    const size = time.size;
    state.timeRange = [0, size - 1];

    const start = document.getElementById("timeStart");
    const end = document.getElementById("timeEnd");
    if (start && end) {
      [start, end].forEach((el) => {
        el.min = 0;
        el.max = Math.max(0, size - 1);
        el.disabled = false;
      });
      start.value = state.timeRange[0];
      end.value = state.timeRange[1];
    }
    syncTimeInputs();
    updateRangeFill();
    updateTimeLabel();
  }

  // ------------------------------------------------------------- 顶部按钮
  function bindActions() {
    document.getElementById("fileInput").addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) uploadFile(file);
      event.target.value = "";
    });

    document.getElementById("refreshBtn").addEventListener("click", () => {
      loadFiles();
      if (state.currentFileId) {
        fetchSeries();
        refreshMapField(true);
      }
    });

    document.getElementById("exportBtn").addEventListener("click", exportData);

    document.getElementById("downloadBtn").addEventListener("click", () => {
      if (!state.currentFileId) return toast("请先选择数据文件", "warn");
      window.open(api.downloadUrl(state.currentFileId), "_blank");
    });

    document.getElementById("deleteBtn").addEventListener("click", deleteCurrentFile);

    document.getElementById("uploadBtn").addEventListener("click", () => {
      document.getElementById("fileInput").click();
    });

    const netcdfBtn = document.getElementById("exportNetcdfBtn");
    if (netcdfBtn) netcdfBtn.addEventListener("click", exportNetcdf);
  }

  function bindDragDrop() {
    const body = document.body;
    ["dragenter", "dragover"].forEach((evt) =>
      body.addEventListener(evt, (event) => {
        event.preventDefault();
        body.classList.add("dragging");
      }),
    );
    ["dragleave", "drop"].forEach((evt) =>
      body.addEventListener(evt, (event) => {
        event.preventDefault();
        if (evt === "drop" || event.target === body) body.classList.remove("dragging");
      }),
    );
    body.addEventListener("drop", (event) => {
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) uploadFile(file);
    });
  }

  // ------------------------------------------------------------- 服务器状态
  async function initServer() {
    const dot = document.querySelector(".status-dot");
    const text = document.getElementById("serverStatus");
    try {
      const health = await api.health();
      text.textContent = "服务器就绪 · v" + health.version;
      dot.classList.remove("offline");
      ui.config = await api.config();
    } catch (err) {
      text.textContent = "服务器离线";
      dot.classList.add("offline");
    }
  }

  // ------------------------------------------------------------- 文件
  async function loadFiles() {
    const list = document.getElementById("fileList");
    try {
      const data = await api.listFiles();
      state.files = data.files || [];
      renderFileList();
      if (state.files.length && !state.currentFileId) {
        await selectFile(state.files[0].id);
      }
    } catch (err) {
      list.innerHTML = '<div class="file-empty">' + T.esc(err.message) + "</div>";
    }
  }

  function renderFileList() {
    const list = document.getElementById("fileList");
    if (!state.files.length) {
      list.innerHTML = '<div class="file-empty">还没有数据文件<br><span>点击「上传」或拖拽 .nc 文件到窗口</span></div>';
      return;
    }
    list.innerHTML = state.files
      .map(
        (file) =>
          '<button class="file-item' +
          (file.id === state.currentFileId ? " active" : "") +
          '" data-id="' +
          file.id +
          '">' +
          '<span class="file-icon">' +
          (file.source === "sample" ? "◈" : "▤") +
          "</span>" +
          '<span class="file-meta"><span class="file-name" title="' +
          T.esc(file.name) +
          '">' +
          T.esc(file.name) +
          '</span><span class="file-sub">' +
          T.FORMAT.bytes(file.size) +
          (file.readonly ? " · 只读示例" : "") +
          "</span></span>" +
          "</button>",
      )
      .join("");
    list.querySelectorAll(".file-item").forEach((item) => {
      item.addEventListener("click", () => selectFile(item.dataset.id));
    });
  }

  async function uploadFile(file) {
    if (!/\.(nc|nc4|cdf|netcdf|grd)$/i.test(file.name)) {
      toast("仅支持 NetCDF 文件（.nc / .nc4 / .cdf）", "error");
      return;
    }
    const progress = document.getElementById("uploadProgress");
    progress.style.display = "block";
    progress.querySelector(".bar").style.width = "0%";
    progress.querySelector("span").textContent = "正在上传 " + file.name;
    try {
      const record = await api.upload(file, (percent) => {
        progress.querySelector(".bar").style.width = percent + "%";
        progress.querySelector("span").textContent = "上传中 " + percent + "%";
      });
      progress.querySelector(".bar").style.width = "100%";
      toast("上传成功：" + record.name, "success");
      await loadFiles();
      await selectFile(record.id);
    } catch (err) {
      toast("上传失败：" + err.message, "error");
    } finally {
      setTimeout(() => {
        progress.style.display = "none";
      }, 600);
    }
  }

  async function selectFile(fileId) {
    state.currentFileId = fileId;
    renderFileList();
    showLoadingAll();
    try {
      const overview = await api.overview(fileId);
      state.overview = overview;
      state.variables = Object.values(overview.variables || {});
      state.variable = state.variables.length ? state.variables[0].name : null;
      populateVariableSelect();
      applyTimeRange();
      renderOverview();
      refreshMapField(true);
      updateDataInfo();
      const current = state.files.find((f) => f.id === fileId);
      document.getElementById("currentFileLabel").textContent = current ? current.name : "";
      document.getElementById("deleteBtn").disabled = Boolean(current && current.readonly);
    } catch (err) {
      toast("读取文件失败：" + err.message, "error");
      showEmptyAll();
    }
  }

  function populateVariableSelect() {
    const select = document.getElementById("variableSelect");
    select.innerHTML = state.variables
      .map((v) => {
        const unit = v.units ? " (" + v.units + ")" : "";
        return (
          '<option value="' +
          T.esc(v.name) +
          '">' +
          T.esc(v.long_name || v.name) +
          " · " +
          T.esc(v.name) +
          unit +
          "</option>"
        );
      })
      .join("");
    if (state.variable) select.value = state.variable;

    const levelGroup = document.getElementById("levelGroup");
    const levelSelect = document.getElementById("levelSelect");
    const level = state.overview && state.overview.axes.level;
    if (level && level.name && level.size > 1) {
      levelGroup.style.display = "";
      levelSelect.innerHTML = level.values
        .map((v, i) => '<option value="' + i + '">' + T.esc(String(v)) + "</option>")
        .join("");
    } else {
      levelGroup.style.display = "none";
    }
  }

  function renderOverview() {
    const container = ui.containers.dataContainer;
    container.innerHTML = '<div class="data-view"><div class="xr-panel" id="xrPanel"></div></div>';
    ui.xrView = new global.XArrayView("#xrPanel", state.overview);
    updateDataInfo();
  }

  function showLoadingAll() {
    const container = ui.containers.dataContainer;
    container.innerHTML = '<div class="chart-loading"><div class="spinner"></div><p>正在解析 NetCDF 文件…</p></div>';
  }

  function showEmptyAll() {
    ui.containers.dataContainer.innerHTML =
      '<div class="chart-empty"><p>暂无数据文件</p><span>请上传 .nc 文件或选择示例数据</span></div>';
  }

  function updateDataInfo() {
    const box = document.getElementById("dataInfo");
    if (!state.overview) {
      box.style.display = "none";
      return;
    }
    const overview = state.overview;
    const varMeta = (overview.variables || {})[state.variable] || {};
    const axes = overview.axes || {};
    const rows = [
      ["文件", overview.file.name],
      ["维度", Object.entries(overview.dimensions).map(([k, v]) => k + "=" + v.size).join(" · ")],
      ["变量", (varMeta.long_name || state.variable || "—") + (varMeta.units ? " (" + varMeta.units + ")" : "")],
      ["时间轴", axes.time && axes.time.name ? axes.time.name + " × " + axes.time.size : "无"],
    ];
    box.innerHTML =
      '<div class="info-title">当前数据集</div>' +
      rows
        .map(
          ([k, v]) =>
            '<div class="info-row"><span>' + T.esc(k) + "</span><strong>" + T.esc(v) + "</strong></div>",
        )
        .join("");
    box.style.display = "block";
  }

  // ------------------------------------------------------------- 取数
  function currentQuery() {
    const query = state.query();
    const level = document.getElementById("levelSelect");
    if (level && document.getElementById("levelGroup").style.display !== "none") {
      query.level_index = Number(level.value);
    }
    return query;
  }

  async function fetchSeries(options) {
    const opts = options || {};
    if (!state.currentFileId) {
      toast("请先选择数据文件", "warn");
      return;
    }
    const mode = state.selection.mode;
    if (mode === "point") {
      const lat = parseFloat(document.getElementById("latitude").value);
      const lon = parseFloat(document.getElementById("longitude").value);
      if (!isFinite(lat) || !isFinite(lon)) {
        toast("请输入有效的经纬度", "warn");
        return;
      }
      state.selection.lat = lat;
      state.selection.lon = lon;
      if (ui.map) ui.map.setMarker(lat, lon);
    } else {
      state.selection.latMin = parseFloat(document.getElementById("latMin").value);
      state.selection.latMax = parseFloat(document.getElementById("latMax").value);
      state.selection.lonMin = parseFloat(document.getElementById("lonMin").value);
      state.selection.lonMax = parseFloat(document.getElementById("lonMax").value);
      if (ui.map) {
        ui.map.setSelectionRect({
          latMin: state.selection.latMin,
          latMax: state.selection.latMax,
          lonMin: state.selection.lonMin,
          lonMax: state.selection.lonMax,
        });
      }
    }

    if (!opts.silent) switchTab("chart-view");
    const container = ui.containers.chartContainer;
    if (!opts.silent) C.loading(container, "正在提取序列…");
    try {
      // 合并选取条件与预处理参数
      const query = Object.assign(currentQuery(), state.preprocessQuery());
      const data = await api.series(state.currentFileId, query);
      state.series = data;
      renderSeries(data);
      if (opts.silent) {
        toast(
          data.preprocess && data.preprocess.applied
            ? "预处理已应用：" + data.preprocess.steps.join(" · ")
            : "已恢复原始序列",
          "success",
        );
      }
    } catch (err) {
      C.error(container, err.message);
      if (opts.silent) toast("预处理失败：" + err.message, "error");
    }
  }

  function renderSeries(data) {
    const container = ui.containers.chartContainer;
    const values = data.values || [];
    const rawValues = data.raw_values || null;
    const labels = data.time || [];
    const stats = data.stats || {};
    const pre = data.preprocess || {};
    const preApplied = Boolean(pre.applied);
    const title =
      data.mode === "point"
        ? data.variable +
          " 点位序列 (" +
          T.FORMAT.number(data.grid.lat, 2) +
          "°N, " +
          T.FORMAT.number(data.grid.lon, 2) +
          "°E)"
        : data.variable + " 区域平均序列";

    // 全缺测（例如海洋数据落在陆地点）时给出明确提示，避免用户误以为功能失效
    const allMissing = !values.some((v) => v !== null && v !== undefined && isFinite(v));
    if (allMissing) {
      const reason =
        (pre && pre.reason) ||
        "该位置在当前时段内没有有效数据，请换一个经纬度或调整时间范围";
      container.innerHTML =
        '<div class="chart-view">' +
        preprocessPanelHtml(pre) +
        '<div class="chart-empty">' +
        '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="#cbd5e1" stroke-width="1.5">' +
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' +
        "</svg>" +
        "<p>该位置无有效数据</p>" +
        "<span>" +
        T.esc(reason) +
        "</span>" +
        "</div></div>";
      bindPreprocessPanel();
      return;
    }

    const unitLabel = preApplied ? "（已预处理）" : data.units || "";
    const seriesList = [];
    if (preApplied && rawValues) {
      seriesList.push({
        name: "原始",
        values: rawValues,
        color: "#cbd5e1",
        width: 1,
        opacity: 0.9,
      });
    }
    seriesList.push({
      name: preApplied ? "预处理后" : data.variable,
      values: values,
      color: T.PALETTE.primary,
      area: !preApplied || !rawValues,
    });

    container.innerHTML =
      '<div class="chart-view">' +
      preprocessPanelHtml(pre) +
      '<div class="metric-row">' +
      metric("变量", data.variable + (data.units ? " (" + data.units + ")" : "")) +
      metric("样本数", values.length) +
      metric("均值", T.FORMAT.number(stats.mean, 3)) +
      metric("标准差", T.FORMAT.number(stats.std, 3)) +
      metric("范围", T.FORMAT.number(stats.min, 2) + " ~ " + T.FORMAT.number(stats.max, 2)) +
      metric("缺测", stats.nan_count) +
      "</div>" +
      '<div class="chart-box tall" id="seriesChart"></div>' +
      '<div class="chart-box compact" id="seriesHist"></div>' +
      "</div>";

    C.line(document.getElementById("seriesChart"), {
      title: title + (preApplied ? "  " + unitLabel : ""),
      series: seriesList,
      xLabels: labels,
      yLabel: preApplied ? "处理后数值" : data.units || "",
      markers: [],
    });

    drawHistogram(document.getElementById("seriesHist"), values, preApplied ? "" : data.units);
    bindPreprocessPanel();
  }

  /** 预处理面板：去趋势 / 标准化 / 滤波。 */
  function preprocessPanelHtml(pre) {
    const p = state.preprocess;
    const applied = pre && pre.applied;
    const steps = (pre && pre.steps) || [];
    const filterOn = p.filter && p.filter !== "none";
    const needMin = p.filter === "lowpass" || p.filter === "bandpass";
    const needMax = p.filter === "highpass" || p.filter === "bandpass";

    return (
      '<section class="preprocess-panel">' +
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
      '<option value="lowpass"' + (p.filter === "lowpass" ? " selected" : "") + ">低通（保留长周期）</option>" +
      '<option value="highpass"' + (p.filter === "highpass" ? " selected" : "") + ">高通（保留短周期）</option>" +
      '<option value="bandpass"' + (p.filter === "bandpass" ? " selected" : "") + ">带通（保留指定周期段）</option>" +
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
        '<label>阶数:</label>'+
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
      // 重新渲染面板以显示对应的输入框
      const panel = document.querySelector(".preprocess-panel");
      if (panel) {
        panel.outerHTML = preprocessPanelHtml(state.series && state.series.preprocess);
        bindPreprocessPanel();
      }
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
      await fetchSeries({ silent: true });
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
      await fetchSeries({ silent: true });
      toast("已重置预处理", "success");
    });
  }

  function drawHistogram(el, values, units) {
    const finite = values.filter((v) => v !== null && isFinite(v));
    if (!finite.length) {
      C.empty(el, "无有效值", "");
      return;
    }
    const [min, max] = C.extent(finite);
    const bins = 28;
    const counts = new Array(bins).fill(0);
    finite.forEach((v) => {
      const idx = Math.min(bins - 1, Math.floor(((v - min) / (max - min || 1)) * bins));
      counts[idx] += 1;
    });
    const centers = counts.map((_, i) => min + ((i + 0.5) / bins) * (max - min || 1));
    C.line(el, {
      title: "数值分布" + (units ? " (" + units + ")" : ""),
      series: [{ name: "频数", values: counts, color: T.PALETTE.accent, area: true, width: 1 }],
      xValues: centers,
      xLabels: centers.map((v) => T.FORMAT.number(v, 2)),
      xFormat: (v) => T.FORMAT.number(v, 1),
      yLabel: "频数",
      tipTitle: (label) => "区间中心 " + label,
      tipDigits: 0,
    });
  }

  function metric(label, value) {
    return (
      '<div class="metric-chip"><span class="metric-label">' +
      T.esc(label) +
      '</span><span class="metric-value">' +
      T.esc(value) +
      "</span></div>"
    );
  }

  // ------------------------------------------------------------- 地图
  async function refreshMapField(force) {
    if (!state.currentFileId || !state.variable) return;
    if (!ui.map && ui.currentTab !== "map-view") return;
    try {
      const params = { variable: state.variable };
      if (state.timeRange) {
        params.start = state.timeRange[0];
        params.end = state.timeRange[1];
      }
      const field = await api.field(state.currentFileId, params);
      if (!ui.map) ensureMap();
      ui.map.setField(field);
    } catch (err) {
      console.warn("空间场加载失败", err);
    }
  }

  // ------------------------------------------------------------- 分析
  const ANALYSIS_CONFIG = {
    "power-spectrum": {
      title: "功率谱分析",
      run: (id, body) => api.powerSpectrum(id, Object.assign(body, { window: "hann" })),
    },
    wavelet: { title: "小波分析", run: (id, body) => api.wavelet(id, Object.assign(body, { max_scale: 64 })) },
    period: { title: "周期分析", run: (id, body) => api.period(id, body) },
    "abrupt-change": {
      title: "突变分析",
      run: (id, body) => api.abrupt(id, Object.assign(body, { method: "all", window: 10 })),
    },
    "cross-spectrum": { title: "交叉谱分析", run: (id, body) => api.crossSpectrum(id, body) },
    eemd: { title: "经验模态分解", run: (id, body) => api.eemd(id, Object.assign(body, { max_imfs: 5, trials: 40 })) },
    correlation: { title: "相关性分析", run: (id, body) => api.correlationInFile(id, body) },
  };

  async function runAnalysis(tool) {
    const config = ANALYSIS_CONFIG[tool];
    if (!config) return;
    const container = ui.containers.analysisContainer;
    if (!state.currentFileId) {
      C.empty(container, "请先选择数据文件", "从左侧文件列表选择或上传 .nc 文件");
      return;
    }
    C.loading(container, "正在计算 " + config.title + "…");
    ui.currentTool = tool;
    try {
      const body = state.body();
      const data = await config.run(state.currentFileId, body);
      state.analysis = data;
      global.PaleoAnalysis.render(tool, container, data);
    } catch (err) {
      C.error(container, err.message);
    }
  }

  async function runCompare() {
    const container = ui.containers.analysisContainer;
    if (!state.currentFileId) {
      C.empty(container, "请先选择数据文件", "对比分析需要至少一条序列");
      return;
    }
    C.loading(container, "正在准备对比数据…");
    ui.currentTool = "compare";
    try {
      // 收集多个序列：当前变量在不同点位的序列
      const sel = state.selection;
      const points =
        sel.mode === "point"
          ? [
              { lat: sel.lat, lon: sel.lon, label: "当前点位" },
              { lat: sel.lat, lon: sel.lon - 30, label: "西侧 30°" },
              { lat: sel.lat, lon: sel.lon + 30, label: "东侧 30°" },
              { lat: Math.max(-85, sel.lat - 20), lon: sel.lon, label: "南侧 20°" },
              { lat: Math.min(85, sel.lat + 20), lon: sel.lon, label: "北侧 20°" },
            ]
          : [
              { lat: (sel.latMin + sel.latMax) / 2, lon: (sel.lonMin + sel.lonMax) / 2, label: "区域中心" },
            ];

      const seriesMap = {};
      for (const point of points) {
        const params = Object.assign({}, currentQuery(), { lat: point.lat, lon: point.lon });
        delete params.lat_min;
        delete params.lat_max;
        delete params.lon_min;
        delete params.lon_max;
        try {
          const data = await api.series(state.currentFileId, params);
          seriesMap[point.label + " (" + point.lat.toFixed(0) + "," + point.lon.toFixed(0) + ")"] = data.values;
        } catch (err) {
          console.warn("跳过序列", point.label, err.message);
        }
      }
      if (Object.keys(seriesMap).length < 1) throw new Error("没有取到可用于对比的序列");

      const data = await api.compare({ series: seriesMap, normalize: true });
      global.PaleoAnalysis.render("compare", container, data);
    } catch (err) {
      C.error(container, err.message);
    }
  }

  // ------------------------------------------------------------- 导出
  async function exportData() {
    if (!state.series) {
      toast("请先获取数据序列", "warn");
      return;
    }
    const data = state.series;
    const rows = [["time", "value"]].concat(data.time.map((t, i) => [t, data.values[i]]));
    const csv = rows.map((row) => row.join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      (data.variable || "series") +
      "_" +
      (data.mode === "point"
        ? data.grid.lat.toFixed(1) + "_" + data.grid.lon.toFixed(1)
        : "area") +
      ".csv";
    a.click();
    URL.revokeObjectURL(url);
    toast("已导出 CSV", "success");
  }

  async function exportNetcdf() {
    if (!state.currentFileId) return toast("请先选择数据文件", "warn");
    try {
      const body = state.body({ format: "netcdf" });
      const response = await fetch("/api/files/" + state.currentFileId + "/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("导出失败 (" + response.status + ")");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        (state.overview ? state.overview.file.name.replace(/\.[^.]+$/, "") : "subset") + "_subset.nc";
      a.click();
      URL.revokeObjectURL(url);
      toast("已导出 NetCDF 子集", "success");
    } catch (err) {
      toast("导出失败：" + err.message, "error");
    }
  }

  async function deleteCurrentFile() {
    if (!state.currentFileId) return;
    const record = state.files.find((f) => f.id === state.currentFileId);
    if (record && record.readonly) {
      toast("示例数据为只读，不能删除", "warn");
      return;
    }
    if (!confirm("确定要删除 " + (record ? record.name : "该文件") + " 吗？")) return;
    try {
      await api.deleteFile(state.currentFileId);
      state.currentFileId = null;
      state.overview = null;
      state.series = null;
      showEmptyAll();
      await loadFiles();
      toast("已删除", "success");
    } catch (err) {
      toast("删除失败：" + err.message, "error");
    }
  }

  // ------------------------------------------------------------- 提示
  let toastTimer = null;
  function toast(message, type) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = "toast show" + (type ? " toast-" + type : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = "toast";
    }, 3200);
  }

  global.PaleoApp = { toast, switchTab, state };
})(window);
