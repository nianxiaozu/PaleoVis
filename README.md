# 古气候数据分析可视化系统 (PaleoVis)

基于 **FastAPI + xarray** 的古气候 NetCDF 数据分析与可视化平台。
后端提供文件管理、数据查询与时序分析接口；前端沿用项目雏形的紫蓝渐变风格，
用原生 JS 实现 xarray 风格的数据集视图、交互式世界地图与各类分析图表，**不依赖任何 CDN**。

---

## 1. 功能一览

### 文件操作
| 接口 | 说明 |
| --- | --- |
| `POST /api/files` | 上传 .nc / .nc4 / .cdf 文件（流式写入，上传后立即校验能否解析） |
| `GET /api/files` | 文件列表（含示例数据） |
| `GET /api/files/{id}` | 文件元信息（xarray 风格） |
| `DELETE /api/files/{id}` | 删除文件（示例数据只读） |
| `GET /api/files/{id}/download` | 下载原始文件 |
| `GET /api/files/{id}/bundle` | 打包下载文件 + 预览图 |
| `POST /api/files/{id}/export` | 导出选取范围子集（CSV / NetCDF） |
| `GET /api/files/{id}/preview/map` | 服务端渲染空间分布图（PNG） |
| `GET /api/files/{id}/preview/series` | 服务端渲染时序曲线图（PNG） |

### NetCDF 分析
| 接口 | 说明 |
| --- | --- |
| `GET /api/datasets/{id}/overview` | 维度、坐标、变量、属性、统计摘要 |
| `GET /api/datasets/{id}/variables` | 变量列表与坐标轴识别结果 |
| `GET /api/datasets/{id}/series` | 点位序列 / 区域序列（`area_method` = `mean` 纬度加权平均 / `sum` 求和 / `std` 标准差） |
| `GET /api/datasets/{id}/field` | 时间平均空间场（前端热力图） |
| `POST /api/datasets/{id}/selector-series` | 请求体形式的取数（便于脚本调用） |

### 时序分析
| 接口 | 方法 |
| --- | --- |
| `POST /api/analysis/{id}/power-spectrum` | 功率谱（周期图 / REDFIT / MTM，AR(1) 红噪声或蒙特卡洛阈值） |
| `POST /api/analysis/{id}/wavelet` | 连续小波变换（Morlet / Paul / DOG）+ 全局小波谱，显著性等值线与影响锥 |
| `POST /api/analysis/{id}/period` | 自相关（AR(1) 红噪声置信带）+ Burg 最大熵谱周期识别，阈值可选 90/95/99% |
| `POST /api/analysis/{id}/abrupt-change` | Mann-Kendall / 滑动 t / Pettitt 突变检测 |
| `POST /api/analysis/{id}/cross-spectrum` | 相干谱 + 相位谱（两个「数据文件 + 变量」，跨文件时按时间轴交集对齐） |
| `POST /api/analysis/{id}/eemd` | 集合经验模态分解（easyclimate `filter_eemd`） |
| `POST /api/analysis/{id}/eemd/export` | EEMD 分量导出（单个 IMF/残差，或全部打包为 CSV / NetCDF；`target=library` 时写入数据文件） |
| `POST /api/analysis/{id}/series/export` | 把当前提取并预处理后的序列写入数据文件（NetCDF），或下载 CSV |
| `POST /api/analysis/{id}/correlation` | 两个「数据文件 + 变量」相关 + 滞后相关 |
| `POST /api/analysis/{id}/compare` | 两个「数据文件 + 变量」标准化对比 + 相关矩阵 |
| `POST /api/analysis/correlation` | 任意两条序列相关（脚本调用） |
| `POST /api/analysis/compare` | 任意多条序列对比（脚本调用） |

跨文件分析用请求体的 `file_a` / `file_b` 指定两个数据文件（缺省为路径里的 `{id}` 与数据 A 自身），
`variable_a` / `variable_b` 指定各自的变量；后端会用两条序列的时间坐标求交集，
只对公共时次计算，响应里的 `source.align` 给出 `n_a` / `n_b` / `overlap` / `tolerance` 等信息。
两个文件完全没有重叠时段时返回 422 并说明重叠不足。

### 序列预处理
`GET /api/datasets/{id}/series` 支持 query 参数直接预处理，分析接口通过请求体的 `preprocess` 字段沿用同一配置：

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `detrend` | `none` / `linear` / `mean` | 线性去趋势或去均值 |
| `standardize` | `true` / `false` | z-score 标准化 |
| `filter` | `none` / `lowpass` / `highpass` / `bandpass` | Butterworth 零相位滤波 |
| `filter_period_min` / `filter_period_max` | 周期值 | 滤波时段 |
| `filter_order` | 1~8 | 滤波器阶数（默认 4） |
| `area_method` | `mean` / `sum` / `std` | 区域序列的空间聚合方式：纬度加权平均 / 区域求和 / 区域标准差 |

处理顺序固定为 **去趋势 → 滤波 → 标准化**；返回体含 `raw_values` 与 `preprocess.steps` 便于核对。

### 前端
- **文件选择弹窗**：启动时自动弹出，列出已上传文件（带布局类型标签）并提供上传入口
- **数据视图**：xarray 风格的 Dataset 摘要（维度 / 坐标 / 变量 / 属性可折叠）
- **地图视图**：按数据布局自动切换形态
  - 时空场（time×lat×lon）：Canvas 等距圆柱投影地图，支持缩放、拖拽、点击取点、拖拽框选区域
  - 顶部提供 **气候态 / 异常场** 切换（菜单「文件 → 地图查询」悬浮子导航同款入口）
  - 异常场模式下可自定义**基准时段**（两个输入框），默认 `0 ~ max//2`
  - 时间-空间（time×lat 或 time×lon）：Hovmöller 热力图
  - 纯时序数据：自动隐藏地图标签
- **图表视图**：时序折线图（十字准线提示）+ 数值分布直方图，内置**序列预处理**面板
  （去趋势 / 标准化 / 低通·带通·高通滤波，可叠加，原始曲线与处理后曲线叠加对比）
- **分析视图**：8 类分析的图表与指标卡渲染，自动沿用图表视图的预处理结果
- **参数面板**：功率谱 / 小波 / 周期 / 突变 / EEMD 以及交叉谱、相关性、多序列对比
  都先展示参数面板（噪声种子、集合次数等），点「应用并计算」才发起请求
- **跨文件双变量分析**：交叉谱 / 相关性 / 多序列对比的面板里，每个「数据」是一组
  「数据文件 + 变量」下拉；侧栏有两个以上文件时各选各的文件与变量，只有一个文件时
  自动退化为同文件里的两个变量。各序列时间轴自动对齐，只对公共时段分析
- **多序列对比可追加**：对比面板最后一个「数据 - 变量」盒子右侧有「＋」按钮，可继续追加
  「数据 C / D / …」盒子（最多 8 个），每个追加盒子右上角「✕」删除；所有组合一次性提交，
  后端取全部序列的公共时次做标准化对比与相关矩阵
- **交叉谱显示控制**：面板可选「最大周期」（超过该周期的频段不显示）与
  「X 轴刻度」（线性 / 对数，切换只重绘、不重算）
- **写入数据文件**：图表视图的「存入数据文件」把提取并预处理后的序列写成 NetCDF 并注册进文件列表；
  EEMD 视图的「存入文件 / 存入全部分量」把单个分量或全部分量打包写入数据文件
- **数据描述属性**：写入的 NetCDF 自动带来源、区域处理方式、预处理步骤、
  EEMD 分量序号与解释方差等键值对属性（键为 ASCII，值为中文，可用 ncdump 直接查看）
- 支持拖拽上传、变量切换、双滑块时间范围、层次选择、CSV / NetCDF 导出

---

## 2. 快速开始

### 2.1 安装依赖

```bash
pip install -r requirements.txt
```

> 需要 Python 3.10+。`netCDF4` 用于读取 NetCDF4/HDF5 格式；
> 若安装失败可改用 `pip install h5netcdf`，xarray 会自动选择可用后端。
>
> 功率谱（周期图 / REDFIT）、小波、EEMD、Mann-Kendall 检验由 **easyclimate** 提供；
> 未安装时这些分析会返回「未安装 easyclimate」的提示，其余功能不受影响。

### 2.2 启动

```bash
uvicorn app.main:app --reload --port 8000
```

打开：

- 页面：<http://127.0.0.1:8000/>
- 接口文档：<http://127.0.0.1:8000/docs>
- 健康检查：<http://127.0.0.1:8000/api/health>

Windows 下也可以直接运行 `run.ps1`，Linux/macOS 运行 `./run.sh`。

### 2.3 示例数据

`data/samples/` 已内置两份合成数据（240 年、2.5°×2.5° 全球格点）：

| 文件 | 内容 |
| --- | --- |
| `sample_climate.nc` | 全球 PR（降水）与 TEM（气温） |
| `sample_asia_subset.nc` | 亚洲区域子集（-30~60°N, 60~180°E） |

重新生成：

```bash
python scripts/make_sample_data.py
python scripts/build_coastline.py   # 重新生成前端离线海岸线
```

启动后示例数据会自动出现在左侧文件列表中（标记为「只读示例」）。

---

## 3. 项目结构

> 逐文件的接口说明、目录职责与演进规划，见 **[docs/项目结构说明.md](docs/项目结构说明.md)**。

```
paleoclimate_study/
├── app/
│   ├── main.py                 # FastAPI 入口、异常处理、静态资源挂载
│   ├── core/
│   │   ├── config.py           # 路径与上传限制配置
│   │   ├── errors.py           # 业务异常 -> HTTP 状态码
│   │   ├── ncutils.py          # 坐标识别、时间解码、JSON 安全转换
│   │   └── plotting.py         # matplotlib 中文字体与样式
│   ├── api/
│   │   ├── deps.py             # 打开数据集、抽取序列、推断采样步长
│   │   ├── schemas.py          # 请求体模型
│   │   └── endpoints/
│   │       ├── files.py        # 文件管理
│   │       ├── datasets.py     # 数据查询
│   │       └── analysis.py     # 时序分析
│   └── services/
│       ├── storage.py          # 文件仓库（上传目录 / 示例目录）
│       ├── nc_processor.py     # NCDataset：取数、统计、出图、导出
│       ├── easyclimate_bridge.py # easyclimate 调用封装（谱/小波/EEMD/MK）
│       ├── series_export.py    # 序列写入 NetCDF + 数据描述属性生成
│       └── analysis.py         # 全部时序分析算法
├── static/
│   ├── index.html
│   ├── css/style.css
│   ├── data/coastline.json     # 离线海岸线（由脚本生成）
│   └── js/
│       ├── theme.js            # 配色与格式化
│       ├── api.js              # 接口封装 + 全局状态
│       ├── charts.js           # SVG / Canvas 图表渲染
│       ├── map.js              # 交互式地图
│       ├── xarray_view.js      # xarray 风格视图
│       ├── analysis_view.js    # 分析结果渲染
│       ├── parameter_panel.js  # 各分析的参数面板（预处理/谱/小波/突变/EEMD/变量选择）
│       └── app.js              # 主逻辑
├── data/
│   ├── samples/                # 只读示例数据
│   └── uploads/                # 上传文件（自动创建）
├── scripts/
│   ├── make_sample_data.py
│   └── build_coastline.py
├── docs/
│   └── 项目结构说明.md          # 目录职责 / 文件接口 / 演进方向
├── tests/test_api.py
└── requirements.txt
```

---

## 4. 使用说明

1. **选择或上传数据**：启动时会自动弹出文件选择窗口，里面列出已上传的文件（右侧标签显示识别出的数据类型），
   点「上传新文件」导入新的 `.nc`，也可直接把文件拖进窗口。
   选中文件后自动跳到数据视图。
2. **选择变量与时段**：左侧「数据选择」切换变量；时间范围用**单条双滑块**拖拽调节，
   也可直接在下方两个输入框里键入起止时次。
3. **取数**：左侧「数据查询」选「点位」输入经纬度，或选「区域」输入范围并在
   「区域处理」下拉里选择**区域平均（纬度加权）/ 区域求和 / 区域标准差**，点击「获取数据」。
4. **看空间分布**：切到「地图视图」，滚轮缩放、拖拽平移。
   - **选点位**：侧边栏选「点位」，直接单击地图，经纬度自动回填；
   - **框选区域**：侧边栏选「区域平均」，在地图上按住拖出矩形，松手即自动填入南北/东西边界并生成区域平均（区域模式下按住 Shift 拖拽可平移）。
5. **预处理序列**（可选）：「图表视图」顶部的预处理面板可叠加去趋势、标准化与滤波，
   滤波支持输入周期范围（低通填最短周期、高通填最长周期、带通填两者）。
   应用后分析视图会**自动沿用同一套预处理**，保证图表与计算结果一致。
6. **做分析**：从顶部菜单选择分析方法，结果在「分析视图」中展示。
7. **导出**：两个导出按钮只在「图表视图」和「EEMD 分解视图」出现。
   - 图表视图：「下载 CSV」把当前曲线导出为 CSV；「存入数据文件」把**提取并预处理后的序列**写成 NetCDF 并出现在左侧文件列表；
   - EEMD 视图：「导出全部分量 CSV」下载全部分量；「存入全部分量」把 IMF 与残差打包写入数据文件；
     每个分量卡片右上角的「存入文件」把该分量单独写入数据文件。
   写入的文件属性里记录了来源变量、区域处理方式与范围、预处理步骤，EEMD 分量还带
   分量序号、解释方差、集合次数与噪声种子，方便溯源。

> 坐标轴识别支持常见命名（lat/latitude/y、lon/longitude/x、time/date），
> 0~360 经度会自动换算，非标准日历（noleap/360_day）依赖 `cftime` 解码。

> **单轴数据**（time-lat / time-lon）：查询面板只保留对应的那一个空间轴，
> 区域平均只能通过输入框填写范围，地图视图不支持矩形框选。

### 数据布局自动识别

系统根据变量的维度组合自动判断数据类型，并调整界面：

| 维度组合 | 识别结果 | 地图视图 | 数据查询 |
| --- | --- | --- | --- |
| `time` | 时序数据 | 隐藏 | 隐藏（直接取整条序列） |
| `time × lat` 或 `time × lon` | 时间-空间 | Hovmöller 热力图 | 只保留对应单轴输入，禁用地图框选 |
| `time × lat × lon` | 时空场 | 交互地图 | 点位 / 区域平均 |
| `lat × lon` | 静态场 | 交互地图 | 保留 |
| 无法识别 | 待指定 | — | 弹出坐标轴指定窗口 |

**坐标轴自动识别失败时**（例如坐标名是 `dim0/dim1/dim2` 且没有 `units` 属性），
系统会弹出「指定坐标轴」窗口，让你手动选择哪个维度是时间、纬度、经度。
指定结果会附加到后续所有请求（`?axis_time=&axis_lat=&axis_lon=`）。

---

## 5. 测试

```bash
python -m pytest tests/ -q      # 若已安装 pytest
python tests/test_api.py        # 也可直接运行（内置 unittest）
```

当前共 **68 个用例**，覆盖文件操作、数据集读取、8 类分析（含功率谱三种方法与两种 REDFIT 检验、
小波全参数、周期分析的阈值与置信水平、EEMD 分量导出）以及 CSV / NetCDF 导出。

其中 5 个用例专门覆盖本轮新增能力：区域处理三种方式（`mean`/`sum`/`std`）、
EEMD 噪声种子的透传与可复现性、EEMD 分量写入数据文件、序列写入数据文件、
以及写入文件的 NetCDF 描述属性（区域处理方式、预处理步骤、分量解释方差）。

---

## 6. 配置项

可通过环境变量覆盖：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PALEOVIS_DATA_DIR` | `./data` | 数据根目录 |
| `PALEOVIS_MAX_UPLOAD_MB` | `1024` | 单文件上传上限（MB） |

---

## 7. 技术说明

- **不依赖 CDN**：图表、地图全部用原生 Canvas / SVG 实现，内网环境可直接运行。
- **流式上传**：大文件分块写盘，超限立即中止并清理。
- **按请求打开数据集**：每个请求独立打开 NetCDF 并在结束时关闭，避免句柄泄漏。
- **预览图缓存**：服务端渲染的 PNG 以参数哈希命名缓存在 `data/cache/previews`。
- **中文字体**：自动探测 Microsoft YaHei / SimHei 等，避免图中中文变方块。
- **地图事件隔离**：选点/框选只在画布内 `mousedown` 发起时生效，全局 `mouseup` 需匹配本次交互，
  避免点击页面其他区域误触发选点。
