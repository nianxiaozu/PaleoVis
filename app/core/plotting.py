"""matplotlib 全局配置：中文字体、负号与统一配色。"""
from __future__ import annotations

import logging

logger = logging.getLogger("paleovis.plot")

_CJK_CANDIDATES = (
    "Microsoft YaHei",
    "SimHei",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "WenQuanYi Zen Hei",
    "PingFang SC",
    "Heiti SC",
    "Arial Unicode MS",
)

_configured = False


def configure_matplotlib() -> None:
    """在首次绘图前调用，确保中文标题不出现方块。"""
    global _configured
    if _configured:
        return
    try:
        import matplotlib

        matplotlib.use("Agg")
        from matplotlib import font_manager, rcParams
    except Exception as exc:  # pragma: no cover
        logger.warning("matplotlib 不可用：%s", exc)
        return

    available = {font.name for font in font_manager.fontManager.ttflist}
    chosen = [name for name in _CJK_CANDIDATES if name in available]
    if chosen:
        rcParams["font.sans-serif"] = chosen + ["DejaVu Sans"]
    else:  # pragma: no cover
        logger.warning("未找到中文字体，图表中的中文可能显示为方块")

    rcParams["axes.unicode_minus"] = False
    rcParams["font.size"] = 9
    rcParams["axes.titlesize"] = 10
    rcParams["axes.labelsize"] = 8
    rcParams["xtick.labelsize"] = 7.5
    rcParams["ytick.labelsize"] = 7.5
    rcParams["legend.fontsize"] = 7.5
    rcParams["figure.autolayout"] = False
    rcParams["savefig.dpi"] = 110
    _configured = True
