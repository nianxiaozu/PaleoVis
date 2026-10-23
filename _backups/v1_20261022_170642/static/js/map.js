/**
 * 交互式世界地图（Canvas 绘制，无第三方地图依赖）。
 *
 * 功能：
 *   * 等距圆柱投影，支持滚轮缩放与拖拽平移
 *   * 叠加 NetCDF 空间场热力图（由 /api/datasets/{id}/field 提供）
 *   * 离线海岸线底图（static/data/coastline.json）
 *   * 点位模式：单击取点，回调 onSelectPoint
 *   * 区域模式：拖拽画矩形框选，回调 onSelectArea
 */
(function (global) {
  "use strict";

  const T = global.PaleoTheme;
  const COAST_URL = "/static/data/coastline.json";
  const DRAG_THRESHOLD = 3; // 像素：小于该位移视为单击

  class PaleoMap {
    constructor(containerId, options) {
      this.containerId = containerId;
      this.options = Object.assign(
        { onSelectPoint: null, onSelectArea: null, onClick: null, showField: true },
        options || {},
      );
      this.canvas = null;
      this.ctx = null;
      this.coast = null;
      this.field = null;
      this.marker = null;
      this.selectionRect = null; // 已确认的区域（地理坐标）
      this.draftPixels = null; // 正在拖拽的矩形（画布像素坐标）
      this.selectMode = "point"; // point | area
      this.center = { lon: 0, lat: 0 };
      this.zoom = 1;
      this.dragging = false;
      this.dragStart = null;
      this._dragKind = null; // pan | rect
      this.hover = null;
      this._bound = {};
      this.width = 0;
      this.height = 0;
    }

    init() {
      const container = document.getElementById(this.containerId);
      if (!container) return this;
      container.innerHTML = "";
      container.classList.add("map-host");

      const stage = document.createElement("div");
      stage.className = "map-stage";
      container.appendChild(stage);
      this.stage = stage;

      this.canvas = document.createElement("canvas");
      this.canvas.className = "map-canvas";
      stage.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.overlay = document.createElement("div");
      this.overlay.className = "map-overlay";
      this.overlay.innerHTML =
        '<div class="map-legend" id="mapLegend"></div>' +
        '<div class="map-toolbar">' +
        '<button class="map-btn" data-act="in" title="放大">+</button>' +
        '<button class="map-btn" data-act="out" title="缩小">−</button>' +
        '<button class="map-btn" data-act="reset" title="复位">⟲</button>' +
        "</div>" +
        '<div class="map-hint" id="mapHint"></div>' +
        '<div class="map-cursor" style="display:none"></div>';
      container.appendChild(this.overlay);

      this.legendEl = this.overlay.querySelector("#mapLegend");
      this.cursorEl = this.overlay.querySelector(".map-cursor");
      this.hintEl = this.overlay.querySelector("#mapHint");

      this._bindEvents(stage);
      this._updateHint();

      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(stage);

      this.loadCoastline().then(() => this.draw());
      this.resize();
      return this;
    }

    async loadCoastline() {
      try {
        const response = await fetch(COAST_URL, { cache: "force-cache" });
        if (!response.ok) throw new Error("coastline " + response.status);
        this.coast = await response.json();
      } catch (err) {
        console.warn("海岸线数据加载失败，将只显示经纬网：", err);
        this.coast = null;
      }
    }

    // ------------------------------------------------------------ 事件绑定
    _bindEvents(stage) {
      this._bound.wheel = (event) => {
        event.preventDefault();
        this.zoomAt(event, event.deltaY < 0 ? 1.15 : 1 / 1.15);
      };

      // 只有真正在画布上按下鼠标，才开启一次交互
      this._bound.down = (event) => {
        if (event.button !== 0) return;
        if (!this._hitTest(event)) return;
        event.preventDefault();

        const kind = this.selectMode === "area" && !event.shiftKey ? "rect" : "pan";
        this._dragKind = kind;
        this.dragging = true;
        this.dragStart = {
          x: event.clientX,
          y: event.clientY,
          center: { ...this.center },
          moved: false,
        };

        if (kind === "rect") {
          const local = this._localPoint(event);
          this.draftPixels = { x0: local.x, y0: local.y, x1: local.x, y1: local.y };
          stage.style.cursor = "crosshair";
        } else {
          stage.style.cursor = "grabbing";
        }
      };

      // 画布内移动：更新经纬度浮标
      this._bound.stageMove = (event) => {
        if (!this.cursorEl) return;
        if (!this._hitTest(event)) {
          this.cursorEl.style.display = "none";
          return;
        }
        const { lon, lat } = this.toGeo(event);
        this.hover = { lon, lat };
        const local = this._localPoint(event);
        this.cursorEl.style.display = "block";
        this.cursorEl.style.left = local.x + 14 + "px";
        this.cursorEl.style.top = local.y + 14 + "px";
        this.cursorEl.textContent = formatLatLon(lat, lon);
      };

      // 全窗口移动：仅在拖拽进行中生效（允许拖到画布外）
      this._bound.windowMove = (event) => {
        if (!this.dragStart) return;
        const dx = event.clientX - this.dragStart.x;
        const dy = event.clientY - this.dragStart.y;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
          this.dragStart.moved = true;
        }

        if (this._dragKind === "rect") {
          const local = this._localPoint(event, true); // 允许越界并夹取
          this.draftPixels = {
            x0: this.draftPixels.x0,
            y0: this.draftPixels.y0,
            x1: local.x,
            y1: local.y,
          };
          this.draw();
          return;
        }

        const perPxLon = 360 / (this.width * this.zoom);
        const perPxLat = 180 / (this.height * this.zoom);
        this.center.lon = wrapLon(this.dragStart.center.lon - dx * perPxLon);
        this.center.lat = clamp(this.dragStart.center.lat + dy * perPxLat, -85, 85);
        this.draw();
      };

      // 关键修复：mouseup 绑在 window 上，必须确认本次交互由地图内 mousedown 发起
      this._bound.up = (event) => {
        if (!this.dragStart) return; // 页面其他位置的点击：直接忽略
        const start = this.dragStart;
        const kind = this._dragKind;
        this.dragStart = null;
        this._dragKind = null;
        this.dragging = false;
        stage.style.cursor = "crosshair";

        if (kind === "rect") {
          const rect = this._draftToGeo();
          this.draftPixels = null;
          if (rect && start.moved) {
            this._commitArea(rect);
          } else {
            this.draw();
          }
          return;
        }

        if (start.moved) {
          this.draw();
          return; // 拖拽平移，不选点
        }
        if (!this._hitTest(event)) return;
        this._handlePoint(event);
      };

      this._bound.leave = () => {
        if (this.cursorEl) this.cursorEl.style.display = "none";
      };

      stage.addEventListener("wheel", this._bound.wheel, { passive: false });
      stage.addEventListener("mousedown", this._bound.down);
      stage.addEventListener("mousemove", this._bound.stageMove);
      stage.addEventListener("mouseleave", this._bound.leave);
      window.addEventListener("mousemove", this._bound.windowMove);
      window.addEventListener("mouseup", this._bound.up);
      stage.style.cursor = "crosshair";

      this.overlay.querySelectorAll(".map-btn").forEach((btn) => {
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          const act = btn.dataset.act;
          if (act === "in") this.zoomAtCenter(1.4);
          if (act === "out") this.zoomAtCenter(1 / 1.4);
          if (act === "reset") this.reset();
        });
      });
    }

    // ------------------------------------------------------------ 坐标换算
    /** 事件点是否落在画布内。地图隐藏（宽高为 0）时一律返回 false。 */
    _hitTest(event) {
      if (!this.canvas) return false;
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    }

    /** 事件点相对画布左上角的像素坐标；clampToCanvas 时夹取到画布范围内。 */
    _localPoint(event, clampToCanvas) {
      const rect = this.canvas.getBoundingClientRect();
      // 优先用实际渲染尺寸，避免容器隐藏时 rect 全为 0 导致坐标错乱
      const width = rect.width || this.width || 1;
      const height = rect.height || this.height || 1;
      let x = event.clientX - rect.left;
      let y = event.clientY - rect.top;
      if (clampToCanvas) {
        x = clamp(x, 0, width);
        y = clamp(y, 0, height);
      }
      return { x, y };
    }

    /** 画布像素坐标 -> 地理坐标（不做环绕，允许越界）。 */
    _pixelToGeo(x, y) {
      const view = this.viewBounds();
      return {
        lon: view.lonMin + (x / (this.width || 1)) * (view.lonMax - view.lonMin),
        lat: view.latMax - (y / (this.height || 1)) * (view.latMax - view.latMin),
      };
    }

    toGeo(event) {
      const local = this._localPoint(event, false);
      const geo = this._pixelToGeo(local.x, local.y);
      return { lon: wrapLon(geo.lon), lat: clamp(geo.lat, -90, 90) };
    }

    project(lon, lat) {
      const view = this.viewBounds();
      return {
        x: ((lon - view.lonMin) / (view.lonMax - view.lonMin)) * this.width,
        y: ((view.latMax - lat) / (view.latMax - view.latMin)) * this.height,
      };
    }

    viewBounds() {
      const spanLat = 180 / this.zoom;
      const spanLon = 360 / this.zoom;
      if (spanLon >= 359.5) {
        return { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 };
      }
      let lonMin = this.center.lon - spanLon / 2;
      if (lonMin < -180) {
        this.center.lon += -180 - lonMin;
        lonMin = -180;
      } else if (lonMin + spanLon > 180) {
        this.center.lon -= lonMin + spanLon - 180;
        lonMin = 180 - spanLon;
      }
      return {
        lonMin,
        lonMax: lonMin + spanLon,
        latMin: Math.max(-90, this.center.lat - spanLat / 2),
        latMax: Math.min(90, this.center.lat + spanLat / 2),
      };
    }

    // ------------------------------------------------------------ 模式与选区
    setMode(mode) {
      this.selectMode = mode === "area" ? "area" : "point";
      this.draftPixels = null;
      if (this.stage) {
        this.stage.style.cursor = this.selectMode === "area" ? "crosshair" : "crosshair";
      }
      this._updateHint();
      this.draw();
    }

    _updateHint() {
      if (!this.hintEl) return;
      this.hintEl.textContent =
        this.selectMode === "area"
          ? "拖拽框选平均区域 · Shift+拖拽平移 · 滚轮缩放"
          : "点击地图选择查询点位 · 拖拽平移 · 滚轮缩放";
    }

    _handlePoint(event) {
      const { lon, lat } = this.toGeo(event);
      this.setMarker(lat, lon);
      const handler = this.options.onSelectPoint || this.options.onClick;
      if (typeof handler === "function") handler({ lat, lon });
    }

    _draftToGeo() {
      if (!this.draftPixels) return null;
      const { x0, y0, x1, y1 } = this.draftPixels;
      const a = this._pixelToGeo(Math.min(x0, x1), Math.min(y0, y1));
      const b = this._pixelToGeo(Math.max(x0, x1), Math.max(y0, y1));
      const latMin = clamp(Math.min(a.lat, b.lat), -90, 90);
      const latMax = clamp(Math.max(a.lat, b.lat), -90, 90);
      const lonMin = clamp(Math.min(a.lon, b.lon), -180, 180);
      const lonMax = clamp(Math.max(a.lon, b.lon), -180, 180);
      if (latMax - latMin < 0.5 || lonMax - lonMin < 0.5) return null;
      return {
        latMin: round2(latMin),
        latMax: round2(latMax),
        lonMin: round2(lonMin),
        lonMax: round2(lonMax),
      };
    }

    _commitArea(rect) {
      this.selectionRect = rect;
      this.draw();
      if (typeof this.options.onSelectArea === "function") {
        this.options.onSelectArea(rect);
      }
    }

    setMarker(lat, lon) {
      this.marker = { lat, lon };
      this.draw();
    }

    setSelectionRect(rect) {
      this.selectionRect = rect || null;
      this.draw();
    }

    setField(field) {
      this.field = field || null;
      this.draw();
      this._renderLegend();
    }

    setExtent(latRange, lonRange) {
      if (!latRange || !lonRange) return;
      const latSpan = Math.abs(latRange[1] - latRange[0]);
      const lonSpan = Math.abs(lonRange[1] - lonRange[0]);
      this.center = { lon: (lonRange[0] + lonRange[1]) / 2, lat: (latRange[0] + latRange[1]) / 2 };
      this.zoom = clamp(Math.min(360 / Math.max(20, lonSpan), 180 / Math.max(20, latSpan)) * 0.8, 1, 12);
      this.draw();
    }

    // ------------------------------------------------------------ 缩放
    zoomAt(event, factor) {
      const rect = this.canvas.getBoundingClientRect();
      const px = (event.clientX - rect.left) / (rect.width || 1);
      const py = (event.clientY - rect.top) / (rect.height || 1);
      const anchor = this.toGeo(event);
      this.zoom = clamp(this.zoom * factor, 1, 12);
      const spanLon = 360 / this.zoom;
      const spanLat = 180 / this.zoom;
      this.center.lon = wrapLon(anchor.lon + (0.5 - px) * spanLon);
      this.center.lat = clamp(anchor.lat + (py - 0.5) * spanLat, -85, 85);
      this.draw();
    }

    zoomAtCenter(factor) {
      this.zoom = clamp(this.zoom * factor, 1, 12);
      this.draw();
    }

    reset() {
      this.zoom = 1;
      this.center = { lon: 0, lat: 0 };
      this.draw();
    }

    // ------------------------------------------------------------ 渲染
    resize() {
      if (!this.canvas) return;
      const stage = this.canvas.parentElement;
      const rect = stage.getBoundingClientRect();
      this.width = Math.max(240, Math.round(rect.width));
      this.height = Math.max(180, Math.round(rect.height));
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    draw() {
      if (!this.ctx || !this.width) return;
      const ctx = this.ctx;
      const { width, height } = this;
      ctx.clearRect(0, 0, width, height);

      const ocean = ctx.createLinearGradient(0, 0, 0, height);
      ocean.addColorStop(0, "#eef7fd");
      ocean.addColorStop(1, "#dfeefb");
      ctx.fillStyle = ocean;
      ctx.fillRect(0, 0, width, height);

      this._drawField(ctx);
      this._drawGraticule(ctx);
      this._drawCoastline(ctx);
      this._drawSelection(ctx);
      this._drawMarker(ctx);
      this._drawFrame(ctx);
    }

    _drawField(ctx) {
      if (!this.field || !this.field.lat || !this.field.lon) return;
      const lats = this.field.lat;
      const lons = this.field.lon;
      const grid = this.field.values;
      if (!grid.length || !grid[0].length) return;

      let min = this.field.vmin;
      let max = this.field.vmax;
      if (min === null || min === undefined) {
        min = Infinity;
        max = -Infinity;
        grid.forEach((row) =>
          row.forEach((v) => {
            if (!isFinite(v)) return;
            if (v < min) min = v;
            if (v > max) max = v;
          }),
        );
      }
      if (!isFinite(min) || !isFinite(max) || min === max) return;

      const view = this.viewBounds();
      const rows = grid.length;
      const cols = grid[0].length;
      const latStep = rows > 1 ? Math.abs(lats[1] - lats[0]) : 1;
      const lonStep = cols > 1 ? Math.abs(lons[1] - lons[0]) : 1;
      const pxPerLat = this.height / (view.latMax - view.latMin);
      const pxPerLon = this.width / (view.lonMax - view.lonMin);

      for (let r = 0; r < rows; r += 1) {
        const y = this.project(lons[0], lats[r] + latStep / 2).y;
        const h = latStep * pxPerLat;
        for (let c = 0; c < cols; c += 1) {
          const v = grid[r][c];
          if (!isFinite(v)) continue;
          const x = this.project(lons[c] - lonStep / 2, lats[r]).x;
          const w = lonStep * pxPerLon;
          if (x + w < 0 || x > this.width) continue;
          ctx.fillStyle = T.autoColor(v, min, max);
          ctx.fillRect(x, y, Math.ceil(w) + 0.5, Math.ceil(h) + 0.5);
        }
      }
    }

    _drawGraticule(ctx) {
      const view = this.viewBounds();
      ctx.strokeStyle = "rgba(148,163,184,0.45)";
      ctx.lineWidth = 0.6;
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillStyle = "rgba(100,116,139,0.85)";

      const lonStep = pickStep(view.lonMax - view.lonMin);
      const latStep = pickStep(view.latMax - view.latMin);

      for (let lon = Math.ceil(view.lonMin / lonStep) * lonStep; lon <= view.lonMax; lon += lonStep) {
        const { x } = this.project(lon, 0);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.height);
        ctx.stroke();
        ctx.fillText(lon.toFixed(0) + "°", x + 3, this.height - 6);
      }
      for (let lat = Math.ceil(view.latMin / latStep) * latStep; lat <= view.latMax; lat += latStep) {
        const { y } = this.project(0, lat);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(this.width, y);
        ctx.stroke();
        ctx.fillText(lat.toFixed(0) + "°", 4, y - 3);
      }

      ctx.strokeStyle = "rgba(100,116,139,0.5)";
      ctx.lineWidth = 0.9;
      const equator = this.project(0, 0);
      ctx.beginPath();
      ctx.moveTo(0, equator.y);
      ctx.lineTo(this.width, equator.y);
      ctx.stroke();
    }

    _drawCoastline(ctx) {
      if (!this.coast || !this.coast.lines) return;
      const view = this.viewBounds();
      ctx.strokeStyle = "#7c8ea3";
      ctx.lineWidth = 0.75;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (const line of this.coast.lines) {
        let started = false;
        for (let i = 0; i < line.length; i += 1) {
          const [lon, lat] = line[i];
          if (lon < view.lonMin - 5 || lon > view.lonMax + 5 || lat < view.latMin - 5 || lat > view.latMax + 5) {
            started = false;
            continue;
          }
          const p = this.project(lon, lat);
          if (!started) {
            ctx.moveTo(p.x, p.y);
            started = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        }
      }
      ctx.stroke();
    }

    _drawSelection(ctx) {
      // 已确认的区域框（仅区域模式下显示）
      if (this.selectMode === "area" && this.selectionRect) {
        const sel = this.selectionRect;
        const a = this.project(sel.lonMin, sel.latMax);
        const b = this.project(sel.lonMax, sel.latMin);
        ctx.fillStyle = "rgba(102,126,234,0.12)";
        ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.strokeStyle = T.PALETTE.primaryDark;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.4;
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.setLineDash([]);
      }

      // 拖拽中的草稿框
      if (this.draftPixels) {
        const { x0, y0, x1, y1 } = this.draftPixels;
        const x = Math.min(x0, x1);
        const y = Math.min(y0, y1);
        const w = Math.abs(x1 - x0);
        const h = Math.abs(y1 - y0);
        ctx.fillStyle = "rgba(118,75,162,0.15)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = T.PALETTE.primaryDark;
        ctx.setLineDash([5, 3]);
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        ctx.setLineDash([]);

        const geo = this._draftToGeo();
        if (geo) {
          ctx.font = "11px ui-monospace, monospace";
          ctx.fillStyle = "rgba(51,65,85,0.95)";
          const label =
            geo.latMin.toFixed(1) + "° ~ " + geo.latMax.toFixed(1) + "°N, " +
            geo.lonMin.toFixed(1) + "° ~ " + geo.lonMax.toFixed(1) + "°E";
          const tw = ctx.measureText(label).width;
          const lx = clamp(x + 4, 2, Math.max(2, this.width - tw - 8));
          const ly = y > 18 ? y - 6 : y + h + 14;
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.fillRect(lx - 3, ly - 11, tw + 6, 15);
          ctx.fillStyle = "rgba(51,65,85,0.95)";
          ctx.fillText(label, lx, ly);
        }
      }
    }

    _drawMarker(ctx) {
      if (!this.marker || this.selectMode !== "point") return;
      const { x, y } = this.project(this.marker.lon, this.marker.lat);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(102,126,234,0.25)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = T.PALETTE.primaryDark;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    _drawFrame(ctx) {
      ctx.strokeStyle = "rgba(148,163,184,0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, this.width - 1, this.height - 1);
    }

    _renderLegend() {
      if (!this.legendEl) return;
      if (!this.field || !this.field.values) {
        this.legendEl.innerHTML = "";
        return;
      }
      const min = this.field.vmin;
      const max = this.field.vmax;
      if (min === null || min === undefined || max === null || max === undefined) {
        this.legendEl.innerHTML = "";
        return;
      }
      const stops = [];
      for (let i = 0; i <= 8; i += 1) {
        stops.push(T.autoColor(min + ((max - min) * i) / 8, min, max));
      }
      this.legendEl.innerHTML =
        '<div class="legend-title">' +
        T.esc(this.field.variable) +
        (this.field.units ? " (" + T.esc(this.field.units) + ")" : "") +
        "</div>" +
        '<div class="legend-bar" style="background:linear-gradient(90deg,' +
        stops.join(",") +
        ')"></div>' +
        '<div class="legend-scale"><span>' +
        T.FORMAT.number(min) +
        "</span><span>" +
        T.FORMAT.number(max) +
        "</span></div>";
    }

    destroy() {
      if (this._resizeObserver) this._resizeObserver.disconnect();
      window.removeEventListener("mousemove", this._bound.windowMove);
      window.removeEventListener("mouseup", this._bound.up);
      this.dragStart = null;
    }
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function wrapLon(lon) {
    let value = lon;
    while (value > 180) value -= 360;
    while (value < -180) value += 360;
    return value;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function formatLatLon(lat, lon) {
    const latTag = lat >= 0 ? "°N" : "°S";
    const lonTag = lon >= 0 ? "°E" : "°W";
    return Math.abs(lat).toFixed(2) + latTag + ", " + Math.abs(lon).toFixed(2) + lonTag;
  }

  function pickStep(span) {
    const candidates = [1, 2, 5, 10, 15, 30, 45, 60, 90];
    const target = span / 8;
    for (const step of candidates) {
      if (step >= target) return step;
    }
    return 90;
  }

  global.PaleoMap = PaleoMap;
})(window);
