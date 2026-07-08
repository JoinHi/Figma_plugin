# AI Flutter Design Exporter

中文 | [English](#english)

一个本地 Figma 插件，用来把当前选区导出成适合喂给 AI 大模型的结构化文件，目标是辅助生成 Flutter 布局。

## 功能

- 导出当前选区为 `design.json`，包含节点树、布局、尺寸、样式、文本、组件信息和图片资源引用。
- 导出图片素材到 `assets/`，并在 JSON 中使用相对路径引用。
- 尽量生成当前选区整体效果图 `preview.png`。
- 支持多选节点；多选时会生成一个虚拟根节点 `SELECTION`。
- 大选区导出时显示阶段、节点数量和文件写入进度。
- 预览图失败不会中断导出；`design.json` 和素材会优先保留下来。
- 不生成 zip 包，导出结果直接写入插件所在文件夹下。

## 导出结构

```text
<插件目录>/
  <导出名称>/
    design.json
    preview.png
    assets/
      image-001.png
      image-002.jpg
```

如果选区太大或 Figma 无法生成预览图，插件仍会导出 `design.json` 和 `assets/`。此时 `design.json.preview.status` 会是 `failed` 或 `skipped`，并记录原因。

## 安装和使用

1. 安装依赖并构建：

   ```bash
   npm install
   npm run build
   ```

2. 启动本地导出服务。推荐在插件文件夹里双击：

   ```text
   Start Figma Export Service.command
   ```

   也可以用终端命令：

   ```bash
   npm run start-export-service
   ```

3. 在 Figma Desktop 中打开 `Plugins > Development > Import plugin from manifest...`。
4. 选择本项目的 `manifest.json`。
5. 在画布中选中一个或多个节点。
6. 运行插件，输入导出文件夹名称并导出。

关闭服务时双击：

```text
Stop Figma Export Service.command
```

或运行：

```bash
npm run stop-export-service
```

## 多选说明

多选时，`design.json` 会生成一个虚拟根节点：

```json
{
  "type": "SELECTION",
  "name": "Selected nodes (2)",
  "children": []
}
```

每个顶层选中节点会作为 `children` 导出，坐标相对于整个选区左上角。如果同时选中父节点和它的子节点，插件会只保留父节点，避免重复导出。

## 本地服务

Figma 插件不能直接写本地文件夹，也不能可靠地启动或关闭本机进程。因此本项目包含一个轻量本地服务：

- 默认地址：`http://localhost:43119`
- 默认输出目录：插件文件夹本身
- 默认行为：插件放在哪个文件夹，导出的 `<导出名称>/` 就生成在哪个文件夹下

空闲时服务基本不占 CPU，主要占用几十 MB 内存和 `localhost:43119` 端口。不导出时可以关闭。

## 校验导出结果

```bash
npm run validate-export -- /path/to/export-folder
```

校验脚本会检查 `design.json`、`preview.png` 和 `design.json` 中声明的素材文件是否存在。若预览图被跳过或失败，可按 `design.json.preview.status` 判断。

## 提交到 GitHub

本项目的 `.gitignore` 已排除本地服务运行文件和导出的设计资源，例如：

```text
.export-service.pid
export-service.log
<导出名称>/design.json
<导出名称>/preview.png
<导出名称>/assets/
```

`dist/` 当前保留提交，因为 `manifest.json` 指向 `dist/main.js` 和 `dist/ui.html`，这样 clone 后更容易直接导入 Figma。修改源码后请运行：

```bash
npm run build
```

---

## English

A local Figma plugin that exports the current selection into structured files designed for AI models, with Flutter layout generation as the main target.

## Features

- Exports the current selection as `design.json`, including node tree, layout, bounds, styles, text, component metadata, and image references.
- Exports image assets into `assets/` and references them from JSON using relative paths.
- Tries to generate a full selection preview as `preview.png`.
- Supports multiple selected nodes by wrapping them in a virtual `SELECTION` root.
- Shows progress for large exports, including current phase, node count, and file-writing progress.
- Preview generation failures do not block the export; `design.json` and assets are preserved first.
- Does not generate zip files. Export results are written directly under the plugin folder.

## Export Structure

```text
<plugin-folder>/
  <export-name>/
    design.json
    preview.png
    assets/
      image-001.png
      image-002.jpg
```

If the selection is too large or Figma cannot generate a preview, the plugin still exports `design.json` and `assets/`. In that case, `design.json.preview.status` will be `failed` or `skipped`, with a reason.

## Installation and Usage

1. Install dependencies and build:

   ```bash
   npm install
   npm run build
   ```

2. Start the local export service. On macOS, you can double-click this file in the plugin folder:

   ```text
   Start Figma Export Service.command
   ```

   Or use the terminal:

   ```bash
   npm run start-export-service
   ```

3. In Figma Desktop, open `Plugins > Development > Import plugin from manifest...`.
4. Select this project's `manifest.json`.
5. Select one or more nodes on the canvas.
6. Run the plugin, enter an export folder name, and export.

To stop the service, double-click:

```text
Stop Figma Export Service.command
```

Or run:

```bash
npm run stop-export-service
```

## Multiple Selection

When multiple nodes are selected, `design.json` uses a virtual root:

```json
{
  "type": "SELECTION",
  "name": "Selected nodes (2)",
  "children": []
}
```

Each top-level selected node becomes a child. Coordinates are relative to the top-left of the full selection bounds. If both a parent and one of its children are selected, only the parent is exported to avoid duplication.

## Local Service

Figma plugins cannot directly write to arbitrary local folders and cannot reliably start or stop native processes. This project includes a lightweight local export service:

- Default URL: `http://localhost:43119`
- Default output directory: the plugin folder itself
- Default behavior: wherever the plugin folder lives, exports are written to `<plugin-folder>/<export-name>/`

When idle, the service uses almost no CPU. It mainly keeps a small Node.js process in memory and occupies the `localhost:43119` port. You can stop it when not exporting.

## Validate an Export

```bash
npm run validate-export -- /path/to/export-folder
```

The validator checks `design.json`, `preview.png`, and asset files referenced by `design.json`. If preview generation was skipped or failed, check `design.json.preview.status`.

## GitHub Notes

The `.gitignore` excludes local service runtime files and generated design exports, such as:

```text
.export-service.pid
export-service.log
<export-name>/design.json
<export-name>/preview.png
<export-name>/assets/
```

`dist/` is intentionally kept commit-ready because `manifest.json` points to `dist/main.js` and `dist/ui.html`, making the plugin easier to import after cloning. After changing source files, run:

```bash
npm run build
```
