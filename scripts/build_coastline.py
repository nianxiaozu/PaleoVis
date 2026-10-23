"""从 cartopy 生成离线海岸线数据，供前端地图使用。

用法：
    python scripts/build_coastline.py
输出：static/data/coastline.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "static" / "data" / "coastline.json"
TOLERANCE = 0.45  # 简化容差（度）


def iter_lines(geometry):
    """把 shapely 几何拆成坐标数组序列。"""
    geom_type = geometry.geom_type
    if geom_type == "LineString":
        yield list(geometry.coords)
    elif geom_type == "MultiLineString":
        for part in geometry.geoms:
            yield list(part.coords)
    elif geom_type == "Polygon":
        yield list(geometry.exterior.coords)
        for ring in geometry.interiors:
            yield list(ring.coords)
    elif geom_type == "MultiPolygon":
        for poly in geometry.geoms:
            yield from iter_lines(poly)
    elif geom_type == "GeometryCollection":
        for part in geometry.geoms:
            yield from iter_lines(part)


def main() -> int:
    import cartopy.io.shapereader as shpreader
    from shapely.geometry import box

    print("reading natural earth 110m coastline ...")
    path = shpreader.natural_earth(resolution="110m", category="physical", name="coastline")
    reader = shpreader.Reader(path)

    # 简化时保留 -180..180 范围内的线，跨越 180 经线的部分会被裁掉
    clip = box(-179.9, -89.9, 179.9, 89.9)
    lines: list[list[list[float]]] = []
    total_points = 0

    for record in reader.records():
        geom = record.geometry
        if not geom.is_valid:
            geom = geom.buffer(0)
        geom = geom.intersection(clip)
        if geom.is_empty:
            continue
        simplified = geom.simplify(TOLERANCE, preserve_topology=False)
        for coords in iter_lines(simplified):
            if len(coords) < 3:
                continue
            arr = [[round(float(x), 2), round(float(y), 2)] for x, y in coords]
            lines.append(arr)
            total_points += len(arr)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {"source": "Natural Earth 110m coastline", "tolerance": TOLERANCE, "lines": lines}
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    size_kb = OUT.stat().st_size / 1024
    print(f"written: {OUT}  lines={len(lines)} points={total_points} size={size_kb:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
