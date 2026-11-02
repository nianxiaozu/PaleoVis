"""多序列的时间轴对齐。

跨文件分析时，两个数据集的时间范围、时间分辨率往往不一致
（例如一个 1850—2000 年逐年、另一个 1900—2020 年逐月）。
本模块负责：

1. 把序列 payload 的 time_index 还原成数值时间轴（单位：天）；
2. 找出两条（或多条）时间轴的公共时次；
3. 按公共时次裁剪序列，并给出对齐后的时间步长。

对齐采用「最近邻 + 半步步长容差」策略：只要两个时次相差不超过
较小步长的一半，就认为是同一个时次。这样同分辨率的年/月数据可以
精确对齐，不同分辨率的数据（年 vs 月）也能落在同一年/月内。
"""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np

from app.core.ncutils import time_axis_numeric


def numeric_times(dataset: Any, payload: dict) -> np.ndarray:
    """把 payload 对应的时次还原成数值时间轴（天）。

    payload["time_index"] 是相对数据集原始时间轴的索引，
    因此可以直接从 dataset.time_values 里取出真实时间。
    """
    axis = time_axis_numeric(dataset.time_values)
    values = payload.get("values") or []
    n = len(values)
    idx = payload.get("time_index") or []
    arr = np.asarray(idx, dtype=int) if idx else np.arange(n, dtype=int)
    if arr.size == n and n and int(arr.max()) < axis.size:
        return np.asarray(axis[arr], dtype="float64")
    return np.asarray(axis[:n], dtype="float64")


def _median_step(times: Sequence[float]) -> float:
    arr = np.asarray(times, dtype="float64")
    if arr.size < 2:
        return 0.0
    diffs = np.diff(arr)
    diffs = diffs[np.isfinite(diffs) & (diffs > 0)]
    return float(np.median(diffs)) if diffs.size else 0.0


def tolerance(times_list: Sequence[Sequence[float]]) -> float:
    """按最小步长的一半作为「同一时次」的判定容差。"""
    steps = [s for s in (_median_step(t) for t in times_list) if s > 0]
    step = min(steps) if steps else 1.0
    return max(step * 0.5, 1e-9)


def match(reference: Sequence[float], other: Sequence[float], tol: float) -> tuple[np.ndarray, np.ndarray]:
    """在 other 中为 reference 的每个时次找最近的时次。

    返回 (reference 的下标, other 的下标)，两数组等长且一一对应。
    """
    ref = np.asarray(reference, dtype="float64")
    oth = np.asarray(other, dtype="float64")
    if ref.size == 0 or oth.size == 0:
        return np.array([], dtype=int), np.array([], dtype=int)

    order = np.argsort(oth, kind="stable")
    sorted_vals = oth[order]
    pos = np.searchsorted(sorted_vals, ref)

    idx_ref: list[int] = []
    idx_other: list[int] = []
    for i in range(ref.size):
        best_diff: float | None = None
        best_j: int | None = None
        for cand in (int(pos[i]) - 1, int(pos[i])):
            if 0 <= cand < sorted_vals.size:
                diff = abs(float(sorted_vals[cand]) - float(ref[i]))
                if best_diff is None or diff < best_diff:
                    best_diff, best_j = diff, int(order[cand])
        if best_j is not None and best_diff is not None and best_diff <= tol:
            idx_ref.append(i)
            idx_other.append(best_j)
    return np.asarray(idx_ref, dtype=int), np.asarray(idx_other, dtype=int)


def align_two(times_a: Sequence[float], times_b: Sequence[float]) -> dict[str, Any]:
    """对齐两条时间轴，返回公共时次与两侧下标。"""
    arr_a = np.asarray(times_a, dtype="float64")
    arr_b = np.asarray(times_b, dtype="float64")
    tol = tolerance([arr_a, arr_b])
    idx_a, idx_b = match(arr_a, arr_b, tol)
    return {
        "index_a": idx_a,
        "index_b": idx_b,
        "common": arr_a[idx_a] if idx_a.size else np.array([], dtype="float64"),
        "tolerance": tol,
        "n_a": int(arr_a.size),
        "n_b": int(arr_b.size),
        "overlap": int(idx_a.size),
    }


def align_many(times_list: Sequence[Sequence[float]]) -> dict[str, Any]:
    """把多条时间轴对齐到公共时次。

    返回 mappings[k] = 公共时次第 i 个位置对应第 k 条序列的下标。
    """
    count = len(times_list)
    if count == 0:
        return {"mappings": [], "common": np.array([], dtype="float64"), "tolerance": 1.0}

    tol = tolerance(times_list)
    common = np.asarray(times_list[0], dtype="float64")
    mappings = [np.arange(common.size, dtype=int)]
    for k in range(1, count):
        idx_ref, idx_other = match(common, times_list[k], tol)
        common = common[idx_ref]
        for j in range(k):
            mappings[j] = mappings[j][idx_ref]
        mappings.append(idx_other)
    return {"mappings": mappings, "common": common, "tolerance": tol}


def step_dt(times: Sequence[float]) -> float:
    """由对齐后的时间轴推断步长；日尺度折算成年，与 estimate_dt 保持一致。"""
    step = _median_step(times)
    if step <= 0:
        return 1.0
    if 20 <= step <= 400:
        return step / 365.25
    return step
