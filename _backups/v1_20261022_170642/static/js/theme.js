/**
 * 统一视觉风格：配色、图表样式与格式化工具。
 * 
 * 前端所有图表（时序、功率谱、小波、热力图）都通过这里取色，
 * 保证与 style.css 中的紫蓝渐变主色调一致。
 */
(function (global) {
  "use strict";

  const PALETTE = {
    primary: "#667eea",
    primaryDark: "#764ba2",
    accent: "#0ea5e9",
    warning: "#f59e0b",
    danger: "#ef4444",
    success: "#10b981",
    grid: "#e8edf5",
    axis: "#94a3b8",
    text: "#334155",
    muted: "#64748b",
    surface: "#ffffff",
  };

  const SERIES_COLORS = [
    "#667eea",
    "#0ea5e9",
    "#f59e0b",
    "#10b981",
    "#ef4444",
    "#8b5cf6",
    "#ec4899",
    "#14b8a6",
  ];

  const SEQUENTIAL = ["#f7fbff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"];
  const DIVERGING = ["#313695", "#74add1", "#e0f3f8", "#fee090", "#f46d43", "#a50026"];

  /** 数值 -> 颜色（线性插值）。 */
  function ramp(value, min, max, stops) {
    if (!isFinite(value)) return "#f1f5f9";
    if (max === min) return stops[Math.floor(stops.length / 2)];
    let t = (value - min) / (max - min);
    t = Math.max(0, Math.min(1, t));
    const pos = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const f = pos - i;
    return mix(stops[i], stops[i + 1], f);
  }

  function hexToRgb(hex) {
    const clean = hex.replace("#", "");
    const value = parseInt(
      clean.length === 3
        ? clean.split("").map((c) => c + c).join("")
        : clean,
      16,
    );
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  function rgbToHex(rgb) {
    return (
      "#" +
      rgb
        .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
        .join("")
    );
  }

  function mix(a, b, t) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    return rgbToHex(ca.map((v, i) => v + (cb[i] - v) * t));
  }

  function sequentialColor(value, min, max) {
    return ramp(value, min, max, SEQUENTIAL);
  }

  function divergingColor(value, min, max) {
    return ramp(value, min, max, DIVERGING);
  }

  /** 自动选择发散/顺序色带。 */
  function autoColor(value, min, max) {
    return min < 0 && max > 0 ? divergingColor(value, min, max) : sequentialColor(value, min, max);
  }

  const FORMAT = {
    number(value, digits) {
      if (value === null || value === undefined || Number.isNaN(value)) return "—";
      const abs = Math.abs(value);
      if (abs !== 0 && (abs < 0.01 || abs >= 100000)) {
        return Number(value).toExponential(2);
      }
      return Number(value).toFixed(digits === undefined ? 2 : digits);
    },
    integer(value) {
      if (value === null || value === undefined) return "—";
      return Number(value).toLocaleString("zh-CN");
    },
    bytes(size) {
      if (!size && size !== 0) return "—";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let value = Number(size);
      let i = 0;
      while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i += 1;
      }
      return value.toFixed(i === 0 ? 0 : 1) + " " + units[i];
    },
    /** 把 long 时间标签压缩成短标签，避免坐标轴拥挤。 */
    timeLabel(label) {
      if (label === null || label === undefined) return "";
      const text = String(label);
      const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (match) return match[1] + "-" + match[2];
      return text.length > 10 ? text.slice(0, 10) : text;
    },
  };

  /** 读取容器尺寸（带兜底）。 */
  function measure(el) {
    const rect = el.getBoundingClientRect();
    return {
      width: Math.max(240, Math.round(rect.width || el.offsetWidth || 720)),
      height: Math.max(200, Math.round(rect.height || el.offsetHeight || 380)),
    };
  }

  /** 生成 SVG 元素字符串的便捷函数。 */
  function esc(text) {
    return String(text === null || text === undefined ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  global.PaleoTheme = {
    PALETTE,
    SERIES_COLORS,
    SEQUENTIAL,
    DIVERGING,
    sequentialColor,
    divergingColor,
    autoColor,
    FORMAT,
    measure,
    esc,
    mix,
  };
})(window);
