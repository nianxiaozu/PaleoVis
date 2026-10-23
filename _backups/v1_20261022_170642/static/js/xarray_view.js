/**
 * xarray 风格的数据集摘要视图（纯 DOM 渲染）。
 */
(function (global) {
  "use strict";

  const T = global.PaleoTheme;

  function esc(text) {
    return T.esc(text);
  }

  function fmtNum(value) {
    return T.FORMAT.number(value, 3);
  }

  class XArrayView {
    /**
     * @param {HTMLElement|string} target 容器元素或选择器
     * @param {object} overview 后端 /datasets/{id}/overview 返回的结构
     */
    constructor(target, overview) {
      if (typeof target === "string") {
        this.el =
          target.charAt(0) === "#"
            ? document.getElementById(target.slice(1))
            : document.querySelector(target);
      } else {
        this.el = target;
      }
      this.data = overview || {};
      this.render();
    }

    render() {
      if (!this.el) return;
      const data = this.data;
      const dims = data.dimensions || {};
      const coords = data.coords || {};
      const variables = data.variables || {};
      const attrs = data.attributes || {};
      const summary = data.summary || {};
      const file = data.file || {};

      const dimItems = Object.entries(dims)
        .map(
          ([name, info]) =>
            '<li><span class="xr-has-index">' +
            esc(name) +
            "</span>: " +
            esc(T.FORMAT.integer(info.size)) +
            "</li>",
        )
        .join("");

      this.el.innerHTML =
        '<div class="xr-wrap">' +
        '<div class="xr-header">' +
        '<div class="xr-obj-type">xarray.Dataset</div>' +
        '<div class="xr-obj-meta">' +
        esc(file.name || "") +
        (file.size ? " · " + esc(T.FORMAT.bytes(file.size)) : "") +
        "</div>" +
        "</div>" +
        '<ul class="xr-sections">' +
        this._section(
          "Dimensions",
          '<ul class="xr-dim-list">' + dimItems + "</ul>",
          Object.keys(dims).length,
          { inline: true },
        ) +
        this._coordsSection(coords) +
        this._varsSection(variables) +
        this._attrsSection("Attributes", attrs) +
        "</ul>" +
        '<div class="xr-footer">' +
        esc(
          summary.n_dimensions +
            " 个维度 · " +
            summary.n_coords +
            " 个坐标 · " +
            summary.n_variables +
            " 个变量 · 共 " +
            T.FORMAT.integer(summary.total_cells) +
            " 个数据格点",
        ) +
        "</div>" +
        "</div>";

      this._bindToggles();
    }

    _section(title, body, count, opts) {
      const id = "sec-" + Math.random().toString(36).slice(2, 9);
      const inline = opts && opts.inline;
      return (
        '<li class="xr-section-item' +
        (inline ? " xr-inline" : "") +
        '">' +
        (inline
          ? '<div class="xr-section-summary">' + esc(title) + ": </div>"
          : '<input id="' + id + '" class="xr-section-summary-in" type="checkbox" checked>' +
            '<label for="' + id + '" class="xr-section-summary">' +
            esc(title) +
            ": <span>(" +
            count +
            ")</span></label>") +
        (inline ? body : '<div class="xr-section-details">' + body + "</div>") +
        "</li>"
      );
    }

    _coordsSection(coords) {
      const entries = Object.entries(coords);
      if (!entries.length) return "";
      const items = entries
        .map(([name, info]) => {
          const preview = Array.isArray(info.preview) ? info.preview.join(" ") : "…";
          const range = info.range
            ? '<span class="xr-range">' + fmtNum(info.range.min) + " ~ " + fmtNum(info.range.max) + "</span>"
            : "";
          const dataId = "data-" + Math.random().toString(36).slice(2, 9);
          const values = Array.isArray(info.preview) ? info.preview : [];
          return (
            '<li class="xr-var-item">' +
            '<div class="xr-var-name"><span class="xr-has-index">' +
            esc(name) +
            "</span></div>" +
            '<div class="xr-var-dims">(' +
            esc((info.dimensions || []).join(", ")) +
            ")</div>" +
            '<div class="xr-var-dtype">' +
            esc(info.dtype || "") +
            "</div>" +
            '<div class="xr-var-preview xr-preview">' +
            esc(preview) +
            "</div>" +
            range +
            '<input id="' +
            dataId +
            '" class="xr-var-data-in" type="checkbox">' +
            '<label for="' +
            dataId +
            '" title="展开数据预览">⌄</label>' +
            '<div class="xr-var-data"><pre>' +
            esc(JSON.stringify(values)) +
            "</pre></div>" +
            "</li>"
          );
        })
        .join("");
      return this._section("Coordinates", '<ul class="xr-var-list">' + items + "</ul>", entries.length);
    }

    _varsSection(variables) {
      const entries = Object.entries(variables);
      if (!entries.length) return "";
      const items = entries
        .map(([name, info]) => {
          const attrs = info.attributes || {};
          const hasAttrs = Object.keys(attrs).length > 0;
          const attrsId = "attrs-" + Math.random().toString(36).slice(2, 9);
          const dataId = "data-" + Math.random().toString(36).slice(2, 9);
          const stats = info.stats || {};
          const statLine =
            stats.min !== null && stats.min !== undefined
              ? '<span class="xr-stat">min ' +
                fmtNum(stats.min) +
                " · max " +
                fmtNum(stats.max) +
                " · mean " +
                fmtNum(stats.mean) +
                "</span>"
              : "";
          const attrsHtml = hasAttrs
            ? '<div class="xr-var-attrs"><dl class="xr-attrs">' +
              Object.entries(attrs)
                .map(([k, v]) => "<dt>" + esc(k) + " :</dt><dd>" + esc(String(v)) + "</dd>")
                .join("") +
              "</dl></div>"
            : "";
          return (
            '<li class="xr-var-item">' +
            '<div class="xr-var-name"><span>' +
            esc(name) +
            "</span></div>" +
            '<div class="xr-var-dims">(' +
            esc((info.dimensions || []).join(", ")) +
            ")</div>" +
            '<div class="xr-var-dtype">' +
            esc(info.dtype || "") +
            "</div>" +
            '<div class="xr-var-preview xr-preview">' +
            esc(info.long_name || "") +
            (info.units ? " [" + esc(info.units) + "]" : "") +
            "</div>" +
            statLine +
            (hasAttrs
              ? '<input id="' +
                attrsId +
                '" class="xr-var-attrs-in" type="checkbox">' +
                '<label for="' +
                attrsId +
                '" title="展开属性">≡</label>'
              : "") +
            '<input id="' +
            dataId +
            '" class="xr-var-data-in" type="checkbox">' +
            '<label for="' +
            dataId +
            '" title="展开形状信息">⌄</label>' +
            attrsHtml +
            '<div class="xr-var-data"><pre>' +
            esc("shape=" + JSON.stringify(info.shape) + "\ndtype=" + info.dtype) +
            "</pre></div>" +
            "</li>"
          );
        })
        .join("");
      return this._section("Data variables", '<ul class="xr-var-list">' + items + "</ul>", entries.length);
    }

    _attrsSection(title, attrs) {
      const entries = Object.entries(attrs || {});
      if (!entries.length) return "";
      const dl = entries
        .map(([k, v]) => "<dt>" + esc(k) + " :</dt><dd>" + esc(String(v)) + "</dd>")
        .join("");
      return this._section(title, '<dl class="xr-attrs">' + dl + "</dl>", entries.length);
    }

    _bindToggles() {
      // CSS 已用 :checked ~ 实现展开，这里仅做键盘可达性补充
      this.el.querySelectorAll("label[for]").forEach((label) => {
        label.setAttribute("tabindex", "0");
      });
    }
  }

  global.XArrayView = XArrayView;
})(window);
