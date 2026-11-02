/**
 * 应用主逻辑：菜单、标签页、文件管理、数据查询与分析调度。
 */
(function (global) {
  "use strict";

  const api = global.PaleoAPI;
  const state = global.PaleoState;
  const C = global.PaleoChart;
  const T = global.PaleoTheme;
  const P = global.PaleoParamPanel;

  const ui = {
    tabs: {},
    containers: {},
    currentTab: "data-view",
    currentTool: null,
    map: null,
    xrView: null,
    config: null,
    seriesCache: [],
    /** 当前分析视图只显示了参数面板、还没真正计算过 */
    panelPending: false,
  };

  // ------------------------------------------------------------- 启动
  document.addEventListener("DOMContentLoaded", () => {
    cacheDom();
    bindMenus();
    bindTabs();
    bindSidebar();
    bindActions();
    bindDragDrop();
    bindModals();
    bindAnomalyBaseline();
    P.init({
      fetchSeries: (options) => fetchSeries(options),
      toast: (message, type) => toast(message, type),
      // 重算当前正在看的分析；没有当前分析时退回功率谱
      rerunAnalysis: () => runAnalysis(ui.currentTool && ANALYSIS_CONFIG[ui.currentTool] ? ui.currentTool : "power-spectrum"),
      rerunCompare: () => runCompare(),
      rerenderAnalysis: () => {
        const container = ui.containers.analysisContainer;
        if (state.analysis && global.PaleoAnalysis.has(ui.currentTool)) {
          global.PaleoAnalysis.render(ui.currentTool, container, state.analysis);
        }
      },
    });
    initServer();
    updateSelectionSummary();
    // 启动时不加载任何数据，只拉取文件列表供弹窗展示
    showFileModal();
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

        if (option.dataset.tool === "map") {
          const sub = option.closest(".menu-submenu");
          const item = option.closest(".menu-item");
          if (item) item.classList.add("open");     // 父级下拉保持展开
          if (sub) {
            document.querySelectorAll(".menu-submenu").forEach((s) => {
              if (s !== sub) s.classList.remove("open");
            });
            sub.classList.add("open");
          }
          return;
        }
        // 地图查询的子导航项：切换场类型并打开地图视图
        const fieldMode = option.dataset.fieldMode;
        if (fieldMode) {
          items.forEach((i) => i.classList.remove("open"));
          document.querySelectorAll(".menu-submenu").forEach((s) => s.classList.remove("open"));
          setFieldMode(fieldMode);
          switchTab("map-view");
          return;
        }

        items.forEach((i) => i.classList.remove("open"));
        document.querySelectorAll(".menu-submenu").forEach((s) => s.classList.remove("open"));
        const tool = option.dataset.tool;
        if (tool === "select") {
          showFileModal();
          return;
        }

        if (tool === "compare") {
          // 先让用户勾选要对比的变量，点「应用并计算」后才取数
          switchTab("analysis-view");
          showAnalysisPanel("compare");
          return;
        }
        switchTab("analysis-view");
        // 功率谱 / 小波 / 周期 / 突变：先只显示参数面板，点「应用并重算」才发请求
        if (ANALYSIS_PANELS[tool]) showAnalysisPanel(tool);
        else runAnalysis(tool);
      });
    });

    // 地图视图内的场模式按钮
    document.querySelectorAll("#mapModeBar .map-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        setFieldMode(btn.dataset.fieldMode);
      });
    });
  }

  /**
   * 设置地图场类型：气候态 / 异常场。
   * 菜单子项与地图视图按钮共用这一个入口，保证两处状态同步。
   */
  function setFieldMode(mode) {
    const next = mode === "anomaly" ? "anomaly" : "climatology";
    if (state.fieldMode === next) return;
    state.fieldMode = next;

    // 同步两处按钮的选中态
    document.querySelectorAll("[data-field-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.fieldMode === next);
    });

    const hint = document.getElementById("mapModeHint");
    if (hint) {
      hint.textContent =
        next === "anomaly" ? "所选时段相对基准气候态的偏差" : "所选时段的时间平均";
    }

    // 基准时段输入框只在异常场模式显示
    const baseline = document.getElementById("anomalyBaseline");
    if (baseline) baseline.classList.toggle("visible", next === "anomaly");

    if (state.currentFileId) refreshMapField(true);
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
    // 场模式栏只在地图视图显示
    const modeBar = document.getElementById("mapModeBar");
    if (modeBar) modeBar.classList.toggle("show", name === "map-view");
    if (name === "map-view") ensureMap();
    updateExportLabels();
  }

  /**
   * 顶部两个导出按钮只在「图表视图」和「EEMD 分解视图」出现：
   * 图表视图导出当前提取并预处理后的序列，EEMD 视图导出全部分量 + 残差。
   * 两个视图里 NetCDF 按钮都是「写入数据文件」，CSV 按钮都是浏览器下载。
   */
  function updateExportLabels() {
    const csvBtn = document.getElementById("exportBtn");
    const ncBtn = document.getElementById("exportNetcdfBtn");
    const eemd = eemdExportActive();
    const visible = ui.currentTab === "chart-view" || eemd;

    [csvBtn, ncBtn].forEach((btn) => {
      if (!btn) return;
      btn.classList.toggle("hidden", !visible);
    });
    if (!visible) return;

    if (csvBtn) {
      const span = csvBtn.querySelector("span");
      if (span) span.textContent = eemd ? "导出全部分量 CSV" : "导出序列 CSV";
      csvBtn.title = eemd
        ? "把所有 IMF 与残差打包下载为 CSV"
        : "把当前提取并预处理后的序列下载为 CSV";
    }
    if (ncBtn) {
      const span = ncBtn.querySelector("span");
      if (span) span.textContent = eemd ? "存入全部分量" : "存入数据文件";
      ncBtn.title = eemd
        ? "把所有 IMF 与残差写入一个新的 NetCDF 数据文件"
        : "把当前提取并预处理后的序列写入一个新的 NetCDF 数据文件";
    }
  }

  /** 地图视图：根据布局决定用交互地图还是 Hovmöller 热力图。 */
  function ensureMap() {
    const mode = state.layout && state.layout.map_mode;
    if (mode === "hovmoller") {
      renderHovmollerView();
      return;
    }
    // 地图容器曾被 Hovmöller 视图覆盖时，旧 map 实例的 canvas 已脱离文档，
    // 需要销毁重建，否则后续绘制会落在一个看不见的 detached canvas 上。
    if (ui.map && ui.map.canvas && !document.contains(ui.map.canvas)) {
      try {
        ui.map.destroy();
      } catch (err) {
        /* 忽略 */
      }
      ui.map = null;
    }
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

  /** 渲染时间-纬度 / 时间-经度 图。 */
  async function renderHovmollerView() {
    const container = document.getElementById("mapContainer");
    if (!container) return;
    if (!state.currentFileId) {
      C.empty(container, "请先选择数据文件", "");
      return;
    }
    container.innerHTML = '<div class="chart-loading"><div class="spinner"></div><p>正在加载时间-空间场…</p></div>';
    try {
      const params = { variable: state.variable };
      if (state.timeRange) {
        params.start = state.timeRange[0];
        params.end = state.timeRange[1];
      }
      params.field_mode = state.fieldMode || "climatology";
      if (state.fieldMode === "anomaly") {
        const base = state.anomalyBaseline || {};
        if (isFinite(base.start)) params.anomaly_start = base.start;
        if (isFinite(base.end)) params.anomaly_end = base.end;
      }
      const field = await api.field(state.currentFileId, params);
      if (field.mode !== "hovmoller") {
        // 数据其实有完整经纬度，退回普通地图
        state.layout = Object.assign({}, state.layout, { map_mode: "map" });
        container.innerHTML = "";
        ensureMap();
        return;
      }
      state.hovmoller = field;
      container.innerHTML =
        '<div class="hovmoller-view">' +
        '<div class="hovmoller-head">' +
        "<h3>" + T.esc(field.variable) + " · " + T.esc(field.axis_label || "") + "随时间变化</h3>" +
        '<span class="card-hint">' +
        T.esc((field.labels && field.labels.start) || "") +
        " ~ " +
        T.esc((field.labels && field.labels.end) || "") +
        (field.baseline ? " · 基准 " + T.esc(field.baseline.label) : "") +
        "</span></div>" +
        '<div class="chart-box hovmoller-box" id="hovmollerChart"></div>' +
        "</div>";
      C.hovmoller(document.getElementById("hovmollerChart"), {
        x: field.x,
        y: field.y,
        yLabels: field.y_labels,
        values: field.values,
        vmin: field.vmin,
        vmax: field.vmax,
        xLabel: field.axis_label,
        yLabel: "时间",
        title: "",
        valueLabel: field.units || field.variable,
      });
    } catch (err) {
      C.error(container, err.message);
    }
  }

  function round2(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  /** 区域处理方式的中文名，与后端 nc_processor.AREA_METHOD_LABELS 保持一致。 */
  const AREA_METHOD_LABELS = {
    mean: "区域平均（纬度加权）",
    sum: "区域求和",
    std: "区域标准差",
  };

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
    // 单轴数据（Hovmöller）只显示实际使用的那个轴
    const axis = state.spaceAxis();
    const wantLat = axis !== "lon";
    const wantLon = axis !== "lat";

    if (sel.mode === "point") {
      const parts = [];
      if (wantLat) parts.push(Math.abs(sel.lat).toFixed(2) + (sel.lat >= 0 ? "°N" : "°S"));
      if (wantLon) parts.push(Math.abs(sel.lon).toFixed(2) + (sel.lon >= 0 ? "°E" : "°W"));
      box.innerHTML =
        '<span class="sel-tag">点位</span>' + T.esc(parts.join(", "));
    } else {
      const parts = [];
      if (wantLat) {
        parts.push(sel.latMin.toFixed(1) + "° ~ " + sel.latMax.toFixed(1) + "°N");
      }
      if (wantLon) {
        parts.push(sel.lonMin.toFixed(1) + "° ~ " + sel.lonMax.toFixed(1) + "°E");
      }
      const methodLabel = AREA_METHOD_LABELS[sel.areaMethod || "mean"] || "区域平均（纬度加权）";
      box.innerHTML =
        '<span class="sel-tag">区域</span>' +
        T.esc(parts.join(", ")) +
        '<span class="sel-method">' +
        T.esc(methodLabel) +
        "</span>";
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

    // 区域处理方式：平均（纬度加权）/ 求和 / 标准差
    const areaMethod = document.getElementById("areaMethod");
    if (areaMethod) {
      areaMethod.value = state.selection.areaMethod || "mean";
      areaMethod.addEventListener("change", (event) => {
        state.selection.areaMethod = event.target.value || "mean";
        updateSelectionSummary();
        if (state.series && state.selection.mode === "area") fetchSeries();
      });
    }

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
      // Hovmöller 数据不允许地图框选，始终用点位（平移）模式
      const allowRect = state.allowRectSelect !== false;
      const mapMode = mode === "area" && allowRect ? "area" : "point";
      ui.map.setMode(mapMode);
      // 区域模式 + 允许框选：把当前区域同步成地图上的框
      if (mode === "area" && allowRect) {
        const sel = state.selection;
        ui.map.setSelectionRect({
          latMin: sel.latMin,
          latMax: sel.latMax,
          lonMin: sel.lonMin,
          lonMax: sel.lonMax,
        });
      } else {
        ui.map.setSelectionRect(null);
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
      if (!state.currentFileId) return;

      if (ui.currentTab === "data-view") {
        const item = document.querySelector("#fileList .file-item.active");
        if (item) item.click();
      } else if (ui.currentTab === "map-view") {
        refreshMapField(true);
      } else if (ui.currentTab === "chart-view") {
        fetchSeries();
      } else {
        if (ui.currentTool && ANALYSIS_CONFIG[ui.currentTool]) {
          runAnalysis(ui.currentTool);
        }
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

  // ------------------------------------------------------------- 弹窗
  function bindModals() {
    const fileModal = document.getElementById("fileModal");
    const axisModal = document.getElementById("axisModal");

    const closeFile = () => closeFileModal();
    ["fileModalClose", "modalCancelBtn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", closeFile);
    });
    // 点击modal确定按钮，文件列表加入选择的文件
    const confirmBtn = document.getElementById("modalConfirmBtn");
    if (confirmBtn) confirmBtn.addEventListener("click", confirmFileSelection);

    const uploadBtn = document.getElementById("modalUploadBtn");
    if (uploadBtn) {
      uploadBtn.addEventListener("click", () => document.getElementById("fileInput").click());
    }
    if (fileModal) {
      fileModal.addEventListener("click", (event) => {
        if (event.target === fileModal) closeFile();
      });
    }

    ["axisModalClose", "axisCancelBtn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => closeAxisModal(null));
    });
    if (axisModal) {
      axisModal.addEventListener("click", (event) => {
        if (event.target === axisModal) closeAxisModal(null);
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (axisModal && axisModal.classList.contains("open")) closeAxisModal(null);
      else if (fileModal && fileModal.classList.contains("open")) closeFile();
    });
  }

  function openModal(el) {
    if (!el) return;
    el.classList.add("open");
    el.setAttribute("aria-hidden", "false");
  }

  function closeModalEl(el) {
    if (!el) return;
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
  }

  async function showFileModal() {
    state.modalSelection = new Set(state.addedFileIds || []);
    openModal(document.getElementById("fileModal"));
    await loadFiles({ autoSelect: false });
  }

  function closeFileModal() {
    closeModalEl(document.getElementById("fileModal"));
  }

  function renderModalFileList() {
    const list = document.getElementById("modalFileList");
    if (!list) return;

    if (!state.files.length) {
      list.innerHTML =
        '<div class="file-empty">还没有数据文件<br><span>点击上方「上传新文件」导入 .nc 数据</span></div>';
      syncModalConfirm();
      return;
    }

    const visibleFiles = state.files;
    list.innerHTML = visibleFiles
      .map((file) => {
        const kind = state.fileLayouts && state.fileLayouts[file.id];
        const kindLabel = kindLabelOf(kind);
        const checked = state.modalSelection.has(file.id);
        return (
          '<div class="modal-file-item' +
          (checked ? " checked" : "") +
          (file.id === state.currentFileId ? " active" : "") +
          '" data-id="' +
          file.id +
          '" role="checkbox" aria-checked="' +
          (checked ? "true" : "false") +
          '" tabindex="0">' +
          '<span class="fi-check" aria-hidden="true"></span>' +
          '<span class="fi-icon">' +
          (file.source === "sample" ? "◈" : file.source === "derived" ? "✧" : "▤") +
          "</span>" +
          '<span class="fi-main"><span class="fi-name" title="' +
          T.esc(file.name) +
          '">' +
          T.esc(file.name) +
          '</span><span class="fi-sub">' +
          T.FORMAT.bytes(file.size) +
          (file.readonly ? " · 只读示例" : file.source === "derived" ? " · 派生数据" : "") +
          "</span></span>" +
          (kindLabel ? '<span class="fi-kind ' + T.esc(kind) + '">' + T.esc(kindLabel) + "</span>" : "") +
          (file.readonly
            ? ""
            : '<button class="fi-del" data-del="' + file.id + '" title="删除">×</button>') +
          "</div>"
        );
      })
      .join("");

    // 点击 = 切换勾选，不再立即加载数据
    list.querySelectorAll(".modal-file-item").forEach((item) => {
      item.addEventListener("click", (event) => {
        if (event.target.classList.contains("fi-del")) return;
        toggleModalSelection(item.dataset.id);
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleModalSelection(item.dataset.id);
        }
      });
    });

    list.querySelectorAll(".fi-del").forEach((btn) => {
      btn.addEventListener("click", async (event) => {
        event.stopPropagation();
        await deleteFileById(btn.dataset.del);
      });
    });

    syncModalConfirm();
    loadFileLayouts();
  }

  /** 切换单个文件的勾选状态（只改内存 + 重渲染，不发请求）。 */
  function toggleModalSelection(fileId) {
    if (state.modalSelection.has(fileId)) state.modalSelection.delete(fileId);
    else state.modalSelection.add(fileId);
    renderModalFileList();
  }

  /** 同步「确定」按钮可用性与底部提示文案。 */
  function syncModalConfirm() {
    const count = state.modalSelection.size;
    const btn = document.getElementById("modalConfirmBtn");
    if (btn) {
      btn.disabled = count === 0;
      btn.textContent = count ? "确定（" + count + "）" : "确定";
    }
    const info = document.getElementById("modalFootInfo");
    if (info) {
      info.textContent = count
        ? "已选 " + count + " 个文件，点「确定」加入数据文件列表"
        : "共 " + state.files.length + " 个文件，请勾选";
    }
  }

  /** 点「确定」：把勾选结果落成侧边栏列表，并打开第一个。 */
  async function confirmFileSelection() {
    const ids = state.files.map((f) => f.id).filter((id) => state.modalSelection.has(id));
    if (!ids.length) return;
    state.addedFileIds = ids;
    if (state.currentFileId && ids.includes(state.currentFileId)) {
      // 当前文件仍在列表里，保留视图，只刷新列表
      renderFileList();
      closeFileModal();
      return;
    }
    await selectFile(ids[0]);   // selectFile 内部会刷新列表并关闭弹窗
  }


  function kindLabelOf(kind) {
    return (
      {
        timeseries: "时序",
        hovmoller: "时间-空间",
        map: "时空场",
        grid: "静态场",
        profile: "剖面",
        unknown: "待指定",
      }[kind] || ""
    );
  }

  /** 逐个查询文件布局，用于弹窗中的类型标签（只查列表里实际显示的文件）。 */
  async function loadFileLayouts() {
    state.fileLayouts = state.fileLayouts || {};
    const scope = state.currentFileId
      ? state.files.filter((f) => f.id === state.currentFileId)
      : state.files;
    const pending = scope.filter((f) => !(f.id in state.fileLayouts));
    if (!pending.length) return;
    await Promise.all(
      pending.map(async (file) => {
        try {
          const data = await api.layout(file.id);
          state.fileLayouts[file.id] = (data.layout && data.layout.kind) || "unknown";
        } catch (err) {
          state.fileLayouts[file.id] = "unknown";
        }
      }),
    );
    // 重新渲染标签
    const list = document.getElementById("modalFileList");
    if (list && list.children.length) {
      list.querySelectorAll(".modal-file-item").forEach((item) => {
        const kind = state.fileLayouts[item.dataset.id];
        const existing = item.querySelector(".fi-kind");
        const label = kindLabelOf(kind);
        if (!label) return;
        if (existing) {
          existing.className = "fi-kind " + kind;
          existing.textContent = label;
        } else {
          const badge = document.createElement("span");
          badge.className = "fi-kind " + kind;
          badge.textContent = label;
          const del = item.querySelector(".fi-del");
          item.insertBefore(badge, del || null);
        }
      });
    }
  }

  async function deleteFileById(fileId) {
    const file = state.files.find((f) => f.id === fileId);
    if (!file) return;
    if (file.readonly) {
      toast("示例数据为只读，不能删除", "warn");
      return;
    }
    if (!confirm("确定要删除 " + file.name + " 吗？")) return;
    try {
      await api.deleteFile(fileId);
      if (state.currentFileId === fileId) {
        state.currentFileId = null;
        state.overview = null;
        state.series = null;
        showEmptyAll();
      }
      delete state.fileLayouts[fileId];
      state.modalSelection.delete(fileId);
      state.addedFileIds = state.addedFileIds.filter((id) => id !== fileId);
      await loadFiles({ autoSelect: false });
      toast("已删除", "success");
    } catch (err) {
      toast("删除失败：" + err.message, "error");
    }
  }

  // ------------------------------------------------------------- 坐标轴指定
  let axisResolver = null;

  /**
   * 弹出坐标轴指定窗口。
   * @returns {Promise<boolean>} 是否成功指定
   */
  function promptAxisMapping(overview) {
    return new Promise((resolve) => {
      axisResolver = resolve;
      const grid = document.getElementById("axisGrid");
      const preview = document.getElementById("axisPreview");
      const candidates = overview.axis_candidates || [];
      const axes = overview.axes || {};

      const options = (selected) =>
        '<option value="">— 不使用 —</option>' +
        candidates
          .map(
            (c) =>
              '<option value="' +
              T.esc(c.name) +
              '"' +
              (c.name === selected ? " selected" : "") +
              ">" +
              T.esc(c.name) +
              "（" +
              c.size +
              "）</option>",
          )
          .join("");

      grid.innerHTML =
        '<div class="axis-row"><label for="axisTime">时间轴</label><select id="axisTime">' +
        options(axes.time) +
        "</select></div>" +
        '<div class="axis-row"><label for="axisLat">纬度轴</label><select id="axisLat">' +
        options(axes.lat) +
        "</select></div>" +
        '<div class="axis-row"><label for="axisLon">经度轴</label><select id="axisLon">' +
        options(axes.lon) +
        "</select></div>";

      const updatePreview = () => {
        const t = document.getElementById("axisTime").value;
        const la = document.getElementById("axisLat").value;
        const lo = document.getElementById("axisLon").value;
        const parts = [];
        if (t) parts.push("时间 = " + t);
        if (la) parts.push("纬度 = " + la);
        if (lo) parts.push("经度 = " + lo);
        if (!la && !lo) {
          preview.textContent = "尚未指定空间坐标，将按纯时间序列处理。";
        } else if (la && lo) {
          preview.textContent =
            "识别为空间场（" + parts.join("，") + "），将显示地图视图。";
        } else if (t) {
          preview.textContent =
            "识别为时间-" + (la ? "纬度" : "经度") + "图（" + parts.join("，") + "）。";
        } else {
          preview.textContent = "识别为剖面（" + parts.join("，") + "）。";
        }
      };

      ["axisTime", "axisLat", "axisLon"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("change", updatePreview);
      });
      updatePreview();

      const confirmBtn = document.getElementById("axisConfirmBtn");
      // 避免重复绑定
      const newBtn = confirmBtn.cloneNode(true);
      confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
      newBtn.addEventListener("click", () => {
        const mapping = {
          time: document.getElementById("axisTime").value || null,
          lat: document.getElementById("axisLat").value || null,
          lon: document.getElementById("axisLon").value || null,
        };
        closeAxisModal(mapping);
      });

      openModal(document.getElementById("axisModal"));
    });
  }

  function closeAxisModal(mapping) {
    closeModalEl(document.getElementById("axisModal"));
    if (!axisResolver) return;
    const resolve = axisResolver;
    axisResolver = null;
    if (mapping) {
      state.axisOverrides = mapping;
      // 把映射写进 query，后续请求自动带上
      api.setAxisOverrides(mapping);
      resolve(true);
    } else {
      resolve(false);
    }
  }

  // ------------------------------------------------------------- 文件
  /**
   * 拉取文件列表。
   * @param {object} opts
   *   opts.autoSelect  是否自动选中第一个文件（启动时传 false）
   */
  async function loadFiles(opts) {
    const options = opts || {};
    try {
      const data = await api.listFiles();
      state.files = data.files || [];

      const validIds = new Set(state.files.map((f) => f.id));
      state.addedFileIds = (state.addedFileIds || []).filter((id) => validIds.has(id));
      state.modalSelection.forEach((id) => {
        if (!validIds.has(id)) state.modalSelection.delete(id);
      });
      if (state.currentFileId && !validIds.has(state.currentFileId)) {
        state.currentFileId = null;
        state.overview = null;
        state.series = null;
        showEmptyAll();
      }

      renderFileList();
      renderModalFileList();

      // 只在「已加入」的文件里挑回退项，不擅自把未确认的文件塞进列表
      if (options.autoSelect !== false && !state.currentFileId) {
        const fallback = state.addedFileIds[0];
        if (fallback) await selectFile(fallback);
      }
    } catch (err) {
      const list = document.getElementById("fileList");
      if (list) list.innerHTML = '<div class="file-empty">' + T.esc(err.message) + "</div>";
    }
  }

  function renderFileList() {
    const list = document.getElementById("fileList");
    if (!list) return;

    const visibleFiles = (state.addedFileIds || [])
      .map((id) => state.files.find((f) => f.id === id))
      .filter(Boolean);

    if (!visibleFiles.length) {
      list.innerHTML =
        '<div class="file-empty">还没有数据文件<br><span>点击「选择文件」勾选后点确定</span></div>';
      return;
    }

    list.innerHTML = visibleFiles
      .map(
        (file) =>
          '<button class="file-item' +
          (file.id === state.currentFileId ? " active" : "") +
          '" data-id="' +
          file.id +
          '">' +
          '<span class="file-icon">' +
          (file.source === "sample" ? "◈" : file.source === "derived" ? "✧" : "▤") +
          "</span>" +
          '<span class="file-meta"><span class="file-name" title="' +
          T.esc(file.name) +
          '">' +
          T.esc(file.name) +
          '</span><span class="file-sub">' +
          T.FORMAT.bytes(file.size) +
          (file.readonly ? " · 只读示例" : file.source === "derived" ? " · 派生数据" : "") +
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
    // 弹窗内与侧边栏共用同一套进度显示
    const modalProgress = document.getElementById("modalProgress");
    const sideProgress = document.getElementById("uploadProgress");
    const showProgress = (visible) => {
      if (modalProgress) modalProgress.style.display = visible ? "block" : "none";
      if (sideProgress) sideProgress.style.display = visible ? "block" : "none";
    };
    const setProgress = (percent, text) => {
      [modalProgress, sideProgress].forEach((box) => {
        if (!box) return;
        const bar = box.querySelector(".bar");
        const label = box.querySelector("span");
        if (bar) bar.style.width = percent + "%";
        if (label) label.textContent = text;
      });
    };

    showProgress(true);
    setProgress(0, "正在上传 " + file.name);
    try {
      const record = await api.upload(file, (percent) => {
        setProgress(percent, "上传中 " + percent + "%");
      });
      setProgress(100, "上传完成");
      toast("上传成功：" + record.name, "success");
      await loadFiles({ autoSelect: false });
      // 上传后直接打开该文件（自动跳到数据视图）
      await selectFile(record.id);
      closeFileModal();
    } catch (err) {
      toast("上传失败：" + err.message, "error");
    } finally {
      setTimeout(() => showProgress(false), 600);
    }
  }

  async function selectFile(fileId, opts) {
    const options = opts || {};
    state.currentFileId = fileId;

    // 保证被打开的文件一定在modal列表中
    if (!state.addedFileIds.includes(fileId)) state.addedFileIds.push(fileId);
    state.modalSelection.add(fileId);

    renderFileList();
    renderModalFileList();
    showLoadingAll();
    try {
      const overview = await api.overview(fileId);
      state.overview = overview;
      state.variables = Object.values(overview.variables || {});
      state.variable = state.variables.length ? state.variables[0].name : null;
      // 换文件后变量集合变了，重置双变量分析的「数据 - 变量」选择
      state.resetPair();
      state.axisOverrides = overview.axis_overrides || {};

      // 自动识别失败：弹出坐标轴指定窗口
      const layout = overview.layout || {};
      if (layout.kind === "unknown" && !options.skipAxisPrompt) {
        const resolved = await promptAxisMapping(overview);
        if (!resolved) {
          // 用户取消：保持文件选中但不进入视图
          toast("已取消坐标轴指定", "warn");
          return;
        }
        return selectFile(fileId, { skipAxisPrompt: true });
      }

      applyLayout(layout);
      populateVariableSelect();
      applyTimeRange();
      renderOverview();
      refreshMapField(true);
      updateDataInfo();

      const current = state.files.find((f) => f.id === fileId);
      document.getElementById("currentFileLabel").textContent = current ? current.name : "";
      const deleteBtn = document.getElementById("deleteBtn");
      if (deleteBtn) deleteBtn.disabled = Boolean(current && current.readonly);

      // 选择文件后自动跳到数据视图
      switchTab("data-view");
      closeFileModal();
    } catch (err) {
      toast("读取文件失败：" + err.message, "error");
      showEmptyAll();
    }
  }

  /** 根据数据布局调整界面：地图标签显隐、查询面板形态。 */
  function applyLayout(layout) {
    const kind = (layout && layout.kind) || "unknown";
    state.layout = layout || { kind: "unknown", has_map: false };

    const mapTab = document.querySelector('.tab[data-tab="map-view"]');
    const mapMenu = document.querySelector('.menu-option[data-tool="map"]');
    const hasMap = Boolean(layout && layout.has_map);

    if (mapTab) mapTab.classList.toggle("hidden", !hasMap);
    if (mapMenu) mapMenu.classList.toggle("hidden", !hasMap);

    // 没有地图能力时隐藏场模式栏与菜单子项
    const modeBar = document.getElementById("mapModeBar");
    if (modeBar && !hasMap) modeBar.classList.remove("show");
    document.querySelectorAll('.menu-submenu[data-submenu="map"]').forEach((sub) => {
      sub.classList.toggle("hidden", !hasMap);
    });

    // 纯时序数据：隐藏点位/区域选择，直接用整条序列
    const querySection = document.getElementById("querySection");
    if (querySection) {
      querySection.style.display = kind === "timeseries" ? "none" : "";
    }

    // Hovmöller：查询面板改为「时间范围 + 空间位置」
    const mapTitle = document.getElementById("mapViewTitle");
    if (mapTitle) {
      mapTitle.textContent =
        layout && layout.map_mode === "hovmoller"
          ? layout.label || "时间-空间图"
          : "空间分布";
    }

    applyQueryAxes(layout);

    // 若当前在地图视图但新数据没有地图，退回数据视图
    if (!hasMap && ui.currentTab === "map-view") {
      switchTab("data-view");
    }
  }

  /**
   * 按数据布局裁剪查询面板：
   *   - time-lat（Hovmöller，空间轴=纬度）：只保留纬度输入
   *   - time-lon（Hovmöller，空间轴=经度）：只保留经度输入
   *   - 其余（时空场）两者都保留
   * 同时决定是否允许地图矩形框选（仅完整时空场允许）。
   */
  function applyQueryAxes(layout) {
    const mode = layout && layout.map_mode;
    const axis = layout && layout.hovmoller_axis;
    const isHovmoller = mode === "hovmoller";

    const onlyLat = isHovmoller && axis === "lat";
    const onlyLon = isHovmoller && axis === "lon";

    // 点位输入
    const pointLat = document.getElementById("pointLatField");
    const pointLon = document.getElementById("pointLonField");
    if (pointLat) pointLat.style.display = onlyLon ? "none" : "";
    if (pointLon) pointLon.style.display = onlyLat ? "none" : "";

    // 区域范围输入
    const areaLat = document.getElementById("areaLatRow");
    const areaLon = document.getElementById("areaLonRow");
    if (areaLat) areaLat.style.display = onlyLon ? "none" : "";
    if (areaLon) areaLon.style.display = onlyLat ? "none" : "";

    // 矩形框选只对完整经纬度场开放；Hovmöller 只能用输入框
    state.allowRectSelect = !isHovmoller;

    const note = document.getElementById("queryNote");
    if (note) {
      if (isHovmoller) {
        note.style.display = "block";
        note.textContent = onlyLat
          ? "该数据只有纬度维：按纬度查询，区域平均请输入纬度范围"
          : "该数据只有经度维：按经度查询，区域平均请输入经度范围";
      } else {
        note.style.display = "none";
        note.textContent = "";
      }
    }

    // Hovmöller 下若正处于区域模式，禁用地图框选并清掉选区
    if (isHovmoller && ui.map) {
      ui.map.setMode("point");
      ui.map.setSelectionRect(null);
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
    // 该数据只支持哪个空间轴（Hovmöller 的单轴数据）
    const axis = state.spaceAxis();
    const wantLat = axis !== "lon";
    const wantLon = axis !== "lat";

    if (mode === "point") {
      const latVal = parseFloat(document.getElementById("latitude").value);
      const lonVal = parseFloat(document.getElementById("longitude").value);
      // 只校验实际用到的轴
      if (wantLat && !isFinite(latVal)) {
        toast("请输入有效的纬度", "warn");
        return;
      }
      if (wantLon && !isFinite(lonVal)) {
        toast("请输入有效的经度", "warn");
        return;
      }
      if (wantLat) state.selection.lat = latVal;
      if (wantLon) state.selection.lon = lonVal;
      if (ui.map && !axis) ui.map.setMarker(state.selection.lat, state.selection.lon);
    } else {
      const latMinVal = parseFloat(document.getElementById("latMin").value);
      const latMaxVal = parseFloat(document.getElementById("latMax").value);
      const lonMinVal = parseFloat(document.getElementById("lonMin").value);
      const lonMaxVal = parseFloat(document.getElementById("lonMax").value);

      if (wantLat) {
        if (!isFinite(latMinVal) || !isFinite(latMaxVal)) {
          toast("请输入有效的纬度范围", "warn");
          return;
        }
        state.selection.latMin = latMinVal;
        state.selection.latMax = latMaxVal;
      }
      if (wantLon) {
        if (!isFinite(lonMinVal) || !isFinite(lonMaxVal)) {
          toast("请输入有效的经度范围", "warn");
          return;
        }
        state.selection.lonMin = lonMinVal;
        state.selection.lonMax = lonMaxVal;
      }

      // 只有完整经纬度场才在地图上画选区框
      if (ui.map && state.allowRectSelect !== false) {
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
    const title = seriesTitle(data);

    // 全缺测（例如海洋数据落在陆地点）时给出明确提示，避免用户误以为功能失效
    const allMissing = !values.some((v) => v !== null && v !== undefined && isFinite(v));
    if (allMissing) {
      const reason =
        (pre && pre.reason) ||
        "该位置在当前时段内没有有效数据，请换一个经纬度或调整时间范围";
      container.innerHTML =
        '<div class="chart-view">' +
        P.renderPreprocessPanel(pre) +
        '<div class="chart-empty">' +
        '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="#cbd5e1" stroke-width="1.5">' +
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' +
        "</svg>" +
        "<p>该位置无有效数据</p>" +
        "<span>" +
        T.esc(reason) +
        "</span>" +
        "</div></div>";
      P.bindPreprocessPanel();
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
      P.renderPreprocessPanel(pre) +
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
    P.bindPreprocessPanel();
  }

  /** 序列标题：兼容只有单条空间轴（Hovmöller）的数据。 */
  function seriesTitle(data) {
    const grid = data.grid || {};
    const hasLat = grid.lat !== undefined && grid.lat !== null;
    const hasLon = grid.lon !== undefined && grid.lon !== null;
    if (data.mode === "point") {
      let where = "";
      if (hasLat) where += T.FORMAT.number(grid.lat, 2) + "°N";
      if (hasLat && hasLon) where += ", ";
      if (hasLon) where += T.FORMAT.number(grid.lon, 2) + "°E";
      return data.variable + " 点位序列" + (where ? " (" + where + ")" : "");
    }
    const extent = data.extent || {};
    if (extent.lat && extent.lon) return data.variable + " 区域平均序列";
    if (extent.lat) return data.variable + " 纬度带平均序列";
    if (extent.lon) return data.variable + " 经度带平均序列";
    return data.variable + " 区域平均序列";
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
    // Hovmöller 模式：地图容器里放热力图，不需要交互地图实例
    if (state.layout && state.layout.map_mode === "hovmoller") {
      if (ui.currentTab === "map-view") renderHovmollerView();
      return;
    }
    if (!ui.map && ui.currentTab !== "map-view") return;
    try {
      const params = { variable: state.variable };
      if (state.timeRange) {
        params.start = state.timeRange[0];
        params.end = state.timeRange[1];
      }
      // 气候态 / 异常场
      params.field_mode = state.fieldMode || "climatology";
      if (state.fieldMode === "anomaly") {
        const base = state.anomalyBaseline || {};
        if (isFinite(base.start)) params.anomaly_start = base.start;
        if (isFinite(base.end)) params.anomaly_end = base.end;
      }
      const field = await api.field(state.currentFileId, params);
      if (!ui.map) ensureMap();
      ui.map.setField(field);
      updateMapModeHint(field);
      syncBaselineInputs(field);
    } catch (err) {
      console.warn("空间场加载失败", err);
    }
  }

  /** 地图模式栏的说明文字，显示当前场类型与时段。 */
  function updateMapModeHint(field) {
    const hint = document.getElementById("mapModeHint");
    if (!hint || !field) return;
    const labels = field.labels || {};
    const period =
      labels.start && labels.end ? " · " + labels.start + " ~ " + labels.end : "";
    hint.textContent = (field.field_label || "") + period;
  }

  // ------------------------------------------------------------- 异常场基准时段
  /** 根据后端返回同步两个输入框（含默认值回填）。 */
  function syncBaselineInputs(field) {
    const startEl = document.getElementById("anomalyStart");
    const endEl = document.getElementById("anomalyEnd");
    const wrap = document.getElementById("anomalyBaseline");
    if (!startEl || !endEl || !wrap) return;

    // 只有异常场模式才显示基准输入
    wrap.classList.toggle("visible", state.fieldMode === "anomaly");
    if (!field || !field.baseline) return;

    const base = field.baseline;
    state.anomalyBaseline = { start: base.start, end: base.end };
    const time = state.overview && state.overview.axes && state.overview.axes.time;
    const maxIndex = time && time.size ? time.size - 1 : base.end;
    [startEl, endEl].forEach((el) => {
      el.max = Math.max(0, maxIndex);
    });
    // 输入框已聚焦时不覆盖用户正在输入的内容
    if (document.activeElement !== startEl) startEl.value = base.start;
    if (document.activeElement !== endEl) endEl.value = base.end;
    startEl.placeholder = "0";
    endEl.placeholder = String(Math.floor(maxIndex / 2));
  }

  /** 读取两个输入框，做范围校验后写回 state。 */
  function readBaselineInputs() {
    const startEl = document.getElementById("anomalyStart");
    const endEl = document.getElementById("anomalyEnd");
    const time = state.overview && state.overview.axes && state.overview.axes.time;
    const maxIndex = time && time.size ? time.size - 1 : 0;

    let start = startEl && startEl.value !== "" ? parseInt(startEl.value, 10) : null;
    let end = endEl && endEl.value !== "" ? parseInt(endEl.value, 10) : null;

    if (start !== null && !isFinite(start)) start = null;
    if (end !== null && !isFinite(end)) end = null;

    // 默认 0 ~ max//2
    const defaultEnd = Math.floor(maxIndex / 2);
    if (start === null) start = 0;
    if (end === null) end = defaultEnd;

    start = Math.max(0, Math.min(start, maxIndex));
    end = Math.max(0, Math.min(end, maxIndex));
    if (end < start) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    state.anomalyBaseline = { start, end };
    return { start, end };
  }

  function bindAnomalyBaseline() {
    const startEl = document.getElementById("anomalyStart");
    const endEl = document.getElementById("anomalyEnd");
    const applyBtn = document.getElementById("anomalyApply");
    const resetBtn = document.getElementById("anomalyReset");
    if (!startEl || !endEl) return;

    const apply = () => {
      readBaselineInputs();
      if (state.fieldMode !== "anomaly") {
        setFieldMode("anomaly");
      } else {
        refreshMapField(true);
      }
    };

    [startEl, endEl].forEach((el) => {
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          apply();
        }
      });
    });
    if (applyBtn) applyBtn.addEventListener("click", apply);
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        const time = state.overview && state.overview.axes && state.overview.axes.time;
        const maxIndex = time && time.size ? time.size - 1 : 0;
        startEl.value = 0;
        endEl.value = Math.floor(maxIndex / 2);
        state.anomalyBaseline = { start: 0, end: Math.floor(maxIndex / 2) };
        if (state.fieldMode !== "anomaly") setFieldMode("anomaly");
        else refreshMapField(true);
      });
    }
  }

  // ------------------------------------------------------------- 分析
  const ANALYSIS_CONFIG = {
    "power-spectrum": {
      title: "功率谱分析",
      run: (id, body) => api.powerSpectrum(id, Object.assign(body, state.spectrumBody())),
    },
    wavelet: {
      title: "小波分析",
      run: (id, body) => api.wavelet(id, Object.assign(body, state.waveletBody())),
    },
    period: {
      title: "周期分析",
      run: (id, body) => api.period(id, Object.assign(body, state.periodBody())),
    },
    "abrupt-change": {
      title: "突变分析",
      run: (id, body) => api.abrupt(id, Object.assign(body, state.abruptBody())),
    },
    "cross-spectrum": {
      title: "交叉谱分析",
      run: (id, body) => api.crossSpectrum(id, Object.assign(body, state.crossBody())),
    },
    eemd: {
      title: "经验模态分解",
      run: (id, body) => api.eemd(id, Object.assign(body, state.eemdBody())),
    },
    correlation: {
      title: "相关性分析",
      run: (id, body) => api.correlationInFile(id, Object.assign(body, state.pairBody())),
    },
    compare: {
      title: "多序列对比",
      run: (id, body) => api.compareInFile(id, Object.assign(body, state.pairBody())),
    },
  };

  /**
   * 只渲染参数面板、不发请求的分析入口。
   * 用户先调参数、点「应用并重算」后才真正计算，避免每次点菜单都跑一遍重计算。
   */
  const ANALYSIS_PANELS = {
    "power-spectrum": {
      title: "功率谱分析",
      render: () => global.PaleoParamPanel.renderSpectrumPanel(state.analysis),
      bind: () => global.PaleoParamPanel.bindSpectrumPanel(),
    },
    wavelet: {
      title: "小波分析",
      render: () => global.PaleoParamPanel.renderWaveletPanel(state.analysis),
      bind: () => global.PaleoParamPanel.bindWaveletPanel(),
    },
    period: {
      title: "周期分析",
      render: () => global.PaleoParamPanel.renderPeriodPanel(state.analysis),
      bind: () => global.PaleoParamPanel.bindPeriodPanel(),
    },
    "abrupt-change": {
      title: "突变分析",
      render: () => global.PaleoParamPanel.renderAbruptPanel(state.analysis),
      bind: () => global.PaleoParamPanel.bindAbruptPanel(),
    },
    eemd: {
      title: "经验模态分解",
      render: () => global.PaleoParamPanel.renderEemdPanel(state.analysis),
      bind: () => global.PaleoParamPanel.bindEemdPanel(),
    },
    "cross-spectrum": {
      title: "交叉谱分析",
      hint: "选择两个「数据 + 变量」后点击「应用并计算」",
      render: () =>
        global.PaleoParamPanel.renderVariablePanel(state.analysis, {
          title: "交叉谱分析",
          badge: "两个数据 · 相位/相干",
          crossOpts: true,
        }),
      bind: () =>
        global.PaleoParamPanel.bindVariablePanel({
          title: "交叉谱分析",
          crossOpts: true,
        }),
    },
    correlation: {
      title: "相关性分析",
      hint: "选择两个「数据 + 变量」后点击「应用并计算」",
      render: () =>
        global.PaleoParamPanel.renderVariablePanel(state.analysis, {
          title: "相关性分析",
          badge: "两个数据 · 相关/滞后",
        }),
      bind: () => global.PaleoParamPanel.bindVariablePanel({ title: "相关性分析" }),
    },
    compare: {
      title: "多序列对比",
      hint: "选择「数据 + 变量」组合，可点 ＋ 继续追加后点击「应用并计算」",
      render: () => global.PaleoParamPanel.renderComparePanel(state.analysis),
      bind: () => global.PaleoParamPanel.bindComparePanel(),
    },
  };

  function showAnalysisPanel(tool) {
    const config = ANALYSIS_PANELS[tool];
    if (!config) return;
    const container = ui.containers.analysisContainer;
    if (!state.currentFileId) {
      C.empty(container, "请先选择数据文件", "从左侧文件列表选择或上传 .nc 文件");
      return;
    }
    ui.currentTool = tool;
    // 面板态：还没真正算过，顶部导出按钮不应出现
    ui.panelPending = true;
    const hint = config.hint || "设置参数后点击「应用并重算」";
    container.innerHTML =
      '<section class="analysis-card">' +
      '<header class="analysis-card-head"><h3>' +
      T.esc(config.title) +
      '</h3><span class="card-hint">' +
      T.esc(hint) +
      "</span></header>" +
      '<div class="analysis-card-body">' +
      config.render() +
      '<p class="card-note">参数确认后才会发起计算请求。</p>' +
      "</div></section>";
    config.bind();
    // 从 EEMD 视图切到「只有参数面板」的视图时，顶部导出按钮要恢复原语义
    updateExportLabels();
  }

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
    ui.panelPending = false;
    try {
      const body = state.body();
      const data = await config.run(state.currentFileId, body);
      state.analysis = data;
      global.PaleoAnalysis.render(tool, container, data);
      updateExportLabels();
    } catch (err) {
      C.error(container, err.message);
    }
  }

  /**
   * 多序列对比：两个「数据 + 变量」组合交给后端对比，
   * 后端会按时间轴交集对齐，只对公共时段计算。
   */
  function runCompare() {
    return runAnalysis("compare");
  }

  // ------------------------------------------------------------- 导出
  /** 当前分析是否为 EEMD：是则顶部导出按钮改为打包全部 IMF + 残差。 */
  function eemdExportActive() {
    return (
      !ui.panelPending &&
      ui.currentTool === "eemd" &&
      state.analysis &&
      state.analysis.type === "eemd" &&
      !!state.currentFileId
    );
  }

  /**
   * EEMD 全部分量导出：
   * - netcdf → 写入服务端数据文件（出现在左侧文件列表）
   * - csv    → 打包下载到浏览器
   */
  async function downloadEemdAll(format) {
    const count = (state.analysis.imfs || []).length;
    try {
      if (format === "netcdf") {
        const body = state.body(state.eemdBody({ format: "netcdf", target: "library" }));
        const result = await api.eemdExport(state.currentFileId, body);
        const name = (result && result.file && result.file.name) || "数据文件";
        toast("已写入数据文件：" + name + "（" + count + " 个 IMF + 残差）", "success");
        if (global.PaleoApp && global.PaleoApp.reloadFiles) global.PaleoApp.reloadFiles();
        return;
      }
      const body = state.body(state.eemdBody({ format: "csv" }));
      const payload = await api.eemdExport(state.currentFileId, body);
      const stem = (state.variable || "series") + "_eemd_all";
      downloadBlob(new Blob(["\ufeff" + payload], { type: "text/csv;charset=utf-8" }), stem + ".csv");
      toast("已导出全部 EEMD 分量 CSV（" + count + " 个 IMF + 残差）", "success");
    } catch (err) {
      toast("导出失败：" + err.message, "error");
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportData() {
    if (eemdExportActive()) {
      await downloadEemdAll("csv");
      return;
    }
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

  /**
   * 图表视图：把当前「提取 + 预处理」后的序列写入一个新的 NetCDF 数据文件，
   * 并在文件属性里带上来源、区域处理方式、预处理步骤等描述。
   * EEMD 视图走 downloadEemdAll，把全部 IMF + 残差写成一个文件。
   */
  async function exportNetcdf() {
    if (!state.currentFileId) return toast("请先选择数据文件", "warn");
    if (eemdExportActive()) {
      await downloadEemdAll("netcdf");
      return;
    }
    if (!state.series) return toast("请先获取数据序列", "warn");
    try {
      const body = state.body({ format: "netcdf", target: "library" });
      const result = await api.seriesExport(state.currentFileId, body);
      const name = (result && result.file && result.file.name) || "数据文件";
      toast("已写入数据文件：" + name, "success");
      if (global.PaleoApp && global.PaleoApp.reloadFiles) global.PaleoApp.reloadFiles();
    } catch (err) {
      toast("写入失败：" + err.message, "error");
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

  global.PaleoApp = {
    toast,
    switchTab,
    state,
    /** 派生文件写入数据目录后，刷新左侧文件列表（不自动切换当前文件）。 */
    reloadFiles: () => loadFiles({ autoSelect: false }),
  };
})(window);
