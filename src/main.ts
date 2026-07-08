figma.showUI(__html__, {
  width: 392,
  height: 460,
  themeColors: true
});

type ExportRequestMessage = {
  type: "export-request";
  folderName?: string;
};

type StatusMessage = {
  type: "status";
  message: string;
  tone?: "info" | "success" | "error";
};

type ProgressMessage = {
  type: "progress";
  phase: string;
  current: number;
  total: number;
  label: string;
  detail?: string;
};

type ExportReadyMessage = {
  type: "export-ready";
  folderName: string;
  files: ExportFile[];
  previewComposition?: PreviewComposition;
  summary: ExportSummary;
};

type ExportErrorMessage = {
  type: "export-error";
  message: string;
};

type ExportFile = {
  path: string;
  mimeType: string;
  bytes: Uint8Array;
  kind: "design-json" | "preview" | "asset";
};

type ExportableSceneNode = SceneNode & {
  exportAsync(settings?: ExportSettings): Promise<Uint8Array>;
};

type PreviewComposition = {
  path: string;
  mimeType: string;
  scale: number;
  warnings: PreviewWarning[];
  canvas: {
    width: number;
    height: number;
  };
  parts: PreviewPart[];
};

type PreviewPart = {
  nodeId: string;
  nodeName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  mimeType: string;
  bytes: Uint8Array;
};

type PreviewWarning = {
  nodeId?: string;
  nodeName?: string;
  reason: string;
};

type PreviewOutcome = {
  previewFile?: ExportFile;
  previewComposition?: PreviewComposition;
  metadata: JsonObject;
};

type ExportSummary = {
  rootName: string;
  rootType: string;
  selectedNodeCount: number;
  topLevelNodeCount: number;
  nodeCount: number;
  assetCount: number;
  fileCount: number;
  previewStatus: string;
  warningCount: number;
};

type JsonObject = Record<string, unknown>;

type AssetReference = {
  id: string;
  kind: "image";
  imageHash: string;
  path?: string;
  mimeType?: string;
  byteLength?: number;
  missing?: boolean;
  error?: string;
};

type ExportContext = {
  folderName: string;
  rootBox: Rect | null;
  nodeCount: number;
  totalNodes: number;
  progressEvery: number;
  nextAssetIndex: number;
  assetsByHash: Map<string, AssetReference>;
  assetFiles: ExportFile[];
};

const DEFAULT_PREVIEW_SCALE = 2;
const PREVIEW_SCALE_CANDIDATES = [2, 1, 0.5, 0.25];
const MAX_PREVIEW_CANVAS_PIXELS = 16000000;
const MAX_PREVIEW_CANVAS_EDGE = 8192;
const MAX_MULTI_PREVIEW_PARTS = 60;

class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

figma.ui.onmessage = (message: unknown) => {
  if (!isExportRequest(message)) {
    return;
  }

  void handleExport(message);
};

async function handleExport(message: ExportRequestMessage): Promise<void> {
  try {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      throw new UserFacingError("请先在画布中选中一个 Frame、Component、Group 或其他可导出的节点。");
    }

    const roots = normalizeSelection(selection);

    if (roots.length === 0) {
      throw new UserFacingError("当前选区没有可导出的顶层节点。请重新选择后再导出。");
    }

    const exportableRoots = getExportableRoots(roots);
    const defaultFolderName = exportableRoots.length === 1
      ? exportableRoots[0].name
      : `${figma.currentPage.name}-selection`;

    const folderName = sanitizeFolderName(message.folderName || defaultFolderName || "figma-export");
    const rootBox = getUnionBounds(exportableRoots);

    if (!rootBox) {
      throw new UserFacingError("无法读取当前选区的边界。请改选 Frame、Component、Instance、Group 或可渲染节点。");
    }

    const totalNodes = countNodes(exportableRoots);
    postProgress({
      phase: "preparing",
      current: 0,
      total: totalNodes,
      label: `准备导出 ${totalNodes} 个节点`
    });

    const context: ExportContext = {
      folderName,
      rootBox,
      nodeCount: 0,
      totalNodes,
      progressEvery: Math.max(1, Math.ceil(totalNodes / 80)),
      nextAssetIndex: 1,
      assetsByHash: new Map(),
      assetFiles: []
    };

    postStatus(exportableRoots.length === 1
      ? "正在读取设计结构..."
      : `正在读取 ${exportableRoots.length} 个顶层节点的设计结构...`);
    const rootNode = exportableRoots.length === 1
      ? await serializeNode(exportableRoots[0], context, 0)
      : await createVirtualSelectionRoot(exportableRoots, context, selection.length);

    postStatus("正在导出整体效果图...");
    const previewOutcome = await createPreviewOutcome(exportableRoots, rootBox);

    const design = createDesignDocument(
      exportableRoots,
      rootNode,
      context,
      selection.length,
      previewOutcome.metadata
    );
    const designBytes = encodeText(JSON.stringify(design, null, 2));
    const files: ExportFile[] = [
      {
        path: "design.json",
        mimeType: "application/json;charset=utf-8",
        bytes: designBytes,
        kind: "design-json"
      },
      ...(previewOutcome.previewFile ? [previewOutcome.previewFile] : []),
      ...context.assetFiles
    ];
    const rootName = exportableRoots.length === 1
      ? exportableRoots[0].name
      : `Selected nodes (${exportableRoots.length})`;
    const rootType = exportableRoots.length === 1 ? exportableRoots[0].type : "SELECTION";

    const summary: ExportSummary = {
      rootName,
      rootType,
      selectedNodeCount: selection.length,
      topLevelNodeCount: exportableRoots.length,
      nodeCount: context.nodeCount,
      assetCount: context.assetsByHash.size,
      fileCount: files.length + (previewOutcome.previewComposition ? 1 : 0),
      previewStatus: String(previewOutcome.metadata.status || "unknown"),
      warningCount: Array.isArray(previewOutcome.metadata.warnings)
        ? previewOutcome.metadata.warnings.length
        : 0
    };

    postStatus("导出数据已准备完成。", "success");
    postToUi({
      type: "export-ready",
      folderName,
      files,
      previewComposition: previewOutcome.previewComposition,
      summary
    });
  } catch (error) {
    const messageText = errorMessage(error);
    figma.notify(messageText, { error: true });
    postToUi({
      type: "export-error",
      message: messageText
    });
  }
}

function normalizeSelection(selection: readonly SceneNode[]): SceneNode[] {
  const selectedIds = new Set(selection.map((node) => node.id));
  return selection.filter((node) => !hasSelectedAncestor(node, selectedIds));
}

function hasSelectedAncestor(node: SceneNode, selectedIds: Set<string>): boolean {
  let parent = readUnknown(node, "parent");

  while (parent && typeof parent === "object") {
    const parentObject = parent as JsonObject;
    const parentId = parentObject.id;

    if (typeof parentId === "string" && selectedIds.has(parentId)) {
      return true;
    }

    parent = parentObject.parent;
  }

  return false;
}

function getExportableRoots(roots: readonly SceneNode[]): ExportableSceneNode[] {
  return roots.map((root) => {
    if (!canExport(root)) {
      throw new UserFacingError(`所选节点 ${root.name} 不支持导出预览图。请改选 Frame、Component、Instance、Group 或可渲染节点。`);
    }

    return root;
  });
}

function countNodes(roots: readonly SceneNode[]): number {
  let total = 0;

  for (const root of roots) {
    total += countNode(root);
  }

  return total;
}

function countNode(node: SceneNode): number {
  let total = 1;
  const children = readArray<SceneNode>(node, "children");

  if (children) {
    for (const child of children) {
      total += countNode(child);
    }
  }

  return total;
}

async function createVirtualSelectionRoot(
  roots: readonly ExportableSceneNode[],
  context: ExportContext,
  selectedNodeCount: number
): Promise<JsonObject> {
  const children: JsonObject[] = [];

  for (const root of roots) {
    children.push(await serializeNode(root, context, 1));
  }

  return removeEmpty({
    id: "virtual-selection-root",
    name: `Selected nodes (${roots.length})`,
    type: "SELECTION",
    depth: 0,
    bounds: serializeBounds(context.rootBox, context.rootBox),
    selection: {
      selectedNodeCount,
      topLevelNodeCount: roots.length,
      nestedSelectionsRemoved: selectedNodeCount - roots.length
    },
    layout: {
      mode: "ABSOLUTE"
    },
    exportHints: {
      flutterWidgetGuess: "Stack",
      reason: "Multiple selected top-level nodes are exported under one virtual selection root."
    },
    children
  });
}

async function createPreviewOutcome(
  roots: readonly ExportableSceneNode[],
  rootBox: Rect
): Promise<PreviewOutcome> {
  try {
    if (roots.length === 1) {
      postProgress({
        phase: "preview",
        current: 0,
        total: 1,
        label: `正在导出预览图 ${roots[0].name}`
      });

      const previewFile = await exportPreviewFile(roots[0], DEFAULT_PREVIEW_SCALE);

      postProgress({
        phase: "preview",
        current: 1,
        total: 1,
        label: "预览图导出完成"
      });

      return {
        previewFile,
        metadata: {
          path: "preview.png",
          status: "generated",
          format: "png",
          scale: DEFAULT_PREVIEW_SCALE,
          warnings: []
        }
      };
    }

    const scaleChoice = chooseMultiPreviewScale(rootBox, roots.length);

    if (!scaleChoice.scale) {
      return {
        metadata: {
          path: null,
          status: "skipped",
          reason: scaleChoice.reason,
          warnings: [
            {
              reason: scaleChoice.reason
            }
          ]
        }
      };
    }

    const previewComposition = await createPreviewComposition(roots, rootBox, scaleChoice.scale);

    if (previewComposition.parts.length === 0) {
      return {
        metadata: {
          path: null,
          status: "failed",
          reason: "所有顶层节点的预览图都导出失败。",
          warnings: previewComposition.warnings
        }
      };
    }

    return {
      previewComposition,
      metadata: {
        path: "preview.png",
        status: "generated",
        format: "png",
        scale: scaleChoice.scale,
        canvas: previewComposition.canvas,
        partsAttempted: roots.length,
        partsGenerated: previewComposition.parts.length,
        warnings: previewComposition.warnings
      }
    };
  } catch (error) {
    const reason = errorMessage(error);
    postStatus(`预览图生成失败，将继续导出 JSON 和素材：${reason}`, "info");

    return {
      metadata: {
        path: null,
        status: "failed",
        reason,
        warnings: [
          {
            reason
          }
        ]
      }
    };
  }
}

async function exportPreviewFile(root: ExportableSceneNode, scale: number): Promise<ExportFile> {
  const previewBytes = await root.exportAsync({
    format: "PNG",
    constraint: {
      type: "SCALE",
      value: scale
    }
  });

  return {
    path: "preview.png",
    mimeType: "image/png",
    bytes: previewBytes,
    kind: "preview"
  };
}

async function createPreviewComposition(
  roots: readonly ExportableSceneNode[],
  rootBox: Rect,
  scale: number
): Promise<PreviewComposition> {
  const parts: PreviewPart[] = [];
  const warnings: PreviewWarning[] = [];
  let current = 0;

  for (const root of roots) {
    current += 1;
    postProgress({
      phase: "preview",
      current,
      total: roots.length,
      label: `正在导出预览部件 ${current}/${roots.length}`,
      detail: root.name
    });

    const bounds = getBounds(root);

    if (!bounds) {
      warnings.push({
        nodeId: root.id,
        nodeName: root.name,
        reason: "无法读取节点边界，已跳过该预览部件。"
      });
      continue;
    }

    try {
      const bytes = await root.exportAsync({
        format: "PNG",
        constraint: {
          type: "SCALE",
          value: scale
        }
      });

      parts.push({
        nodeId: root.id,
        nodeName: root.name,
        x: round(bounds.x - rootBox.x),
        y: round(bounds.y - rootBox.y),
        width: round(bounds.width),
        height: round(bounds.height),
        mimeType: "image/png",
        bytes
      });
    } catch (error) {
      warnings.push({
        nodeId: root.id,
        nodeName: root.name,
        reason: errorMessage(error)
      });
    }

    await yieldToUi();
  }

  return {
    path: "preview.png",
    mimeType: "image/png",
    scale,
    warnings,
    canvas: {
      width: round(rootBox.width),
      height: round(rootBox.height)
    },
    parts
  };
}

function chooseMultiPreviewScale(rootBox: Rect, partCount: number): { scale?: number; reason: string } {
  if (partCount > MAX_MULTI_PREVIEW_PARTS) {
    return {
      reason: `选中的顶层节点数量为 ${partCount}，超过 ${MAX_MULTI_PREVIEW_PARTS} 个。已跳过整体预览图以保证 JSON 和素材先导出。`
    };
  }

  for (const scale of PREVIEW_SCALE_CANDIDATES) {
    const width = Math.ceil(rootBox.width * scale);
    const height = Math.ceil(rootBox.height * scale);
    const pixels = width * height;

    if (width <= MAX_PREVIEW_CANVAS_EDGE
      && height <= MAX_PREVIEW_CANVAS_EDGE
      && pixels <= MAX_PREVIEW_CANVAS_PIXELS) {
      const reason = scale === DEFAULT_PREVIEW_SCALE
        ? "使用默认预览图倍率。"
        : `选区较大，预览图倍率已降为 ${scale}。`;

      return { scale, reason };
    }
  }

  return {
    reason: `选区尺寸 ${round(rootBox.width)}x${round(rootBox.height)} 过大，已跳过整体预览图以避免导出失败。`
  };
}

async function serializeNode(node: SceneNode, context: ExportContext, depth: number): Promise<JsonObject> {
  context.nodeCount += 1;
  await maybeReportNodeProgress(node, context);

  const bounds = serializeBounds(getBounds(node), context.rootBox);
  const json: JsonObject = removeEmpty({
    id: node.id,
    name: node.name,
    type: node.type,
    depth,
    visible: node.visible !== false,
    locked: node.locked === true ? true : undefined,
    bounds,
    transform: serializeTransform(node),
    layout: serializeLayout(node),
    style: await serializeStyle(node, context),
    text: serializeText(node),
    component: serializeComponent(node),
    exportHints: serializeExportHints(node)
  });

  const children = readArray<SceneNode>(node, "children");

  if (children && children.length > 0) {
    const childNodes: JsonObject[] = [];

    for (const child of children) {
      childNodes.push(await serializeNode(child, context, depth + 1));
    }

    json.children = childNodes;
  }

  return json;
}

function createDesignDocument(
  roots: readonly SceneNode[],
  rootNode: JsonObject,
  context: ExportContext,
  selectedNodeCount: number,
  previewMetadata: JsonObject
): JsonObject {
  const isSingleRoot = roots.length === 1;

  return {
    schemaVersion: "1.0.0",
    purpose: "flutter-layout-generation",
    exportedAt: new Date().toISOString(),
    source: removeEmpty({
      tool: "figma",
      pageName: figma.currentPage.name,
      selectedNodeCount,
      topLevelNodeCount: roots.length,
      rootNodeId: isSingleRoot ? roots[0].id : undefined,
      rootNodeName: isSingleRoot ? roots[0].name : undefined,
      rootNodeType: isSingleRoot ? roots[0].type : undefined,
      rootNodes: isSingleRoot
        ? undefined
        : roots.map((root) => ({
          id: root.id,
          name: root.name,
          type: root.type
        }))
    }),
    coordinateSpace: {
      unit: "px",
      origin: "selection-bounds-top-left",
      bounds: serializeBounds(context.rootBox, context.rootBox)
    },
    preview: previewMetadata,
    assets: Array.from(context.assetsByHash.values()),
    root: rootNode,
    flutterGenerationHints: {
      preferAutoLayoutAsFlex: true,
      preferAbsoluteBoundsForOverlays: true,
      imageAssetBasePath: "assets/",
      notes: [
        "Use layout.mode and child layout fields to decide between Row, Column, Wrap, Stack, Positioned, and Align.",
        "Use bounds.local for coordinates relative to the selected root or multi-selection bounding box.",
        "Use style.fills image asset references as Flutter Image.asset or DecorationImage inputs."
      ]
    }
  };
}

async function serializeStyle(node: SceneNode, context: ExportContext): Promise<JsonObject | undefined> {
  const style: JsonObject = removeEmpty({
    opacity: readPlain(node, "opacity"),
    blendMode: readPlain(node, "blendMode"),
    fills: await serializePaints(readUnknown(node, "fills"), context),
    strokes: await serializePaints(readUnknown(node, "strokes"), context),
    strokeWeight: readPlain(node, "strokeWeight"),
    strokeAlign: readPlain(node, "strokeAlign"),
    strokeCap: readPlain(node, "strokeCap"),
    strokeJoin: readPlain(node, "strokeJoin"),
    dashPattern: readPlain(node, "dashPattern"),
    cornerRadius: serializeCornerRadius(node),
    effects: serializeEffects(readUnknown(node, "effects")),
    clipsContent: readPlain(node, "clipsContent"),
    background: await serializePaints(readUnknown(node, "backgrounds"), context)
  });

  return Object.keys(style).length > 0 ? style : undefined;
}

async function serializePaints(value: unknown, context: ExportContext): Promise<unknown> {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === figma.mixed) {
    return "MIXED";
  }

  if (!Array.isArray(value)) {
    return toPlainValue(value);
  }

  const paints: unknown[] = [];

  for (const paint of value) {
    paints.push(await serializePaint(paint, context));
  }

  return paints;
}

async function serializePaint(paint: unknown, context: ExportContext): Promise<JsonObject> {
  const source = asObject(paint);
  const type = String(source.type || "UNKNOWN");
  const base: JsonObject = removeEmpty({
    type,
    visible: source.visible === false ? false : undefined,
    opacity: toPlainValue(source.opacity),
    blendMode: toPlainValue(source.blendMode)
  });

  if (type === "SOLID") {
    return removeEmpty({
      ...base,
      color: serializeColor(source.color),
      boundVariables: toPlainValue(source.boundVariables)
    });
  }

  if (type === "IMAGE") {
    const imageHash = typeof source.imageHash === "string" ? source.imageHash : undefined;
    const asset = imageHash ? await registerImageAsset(imageHash, context) : undefined;

    return removeEmpty({
      ...base,
      scaleMode: toPlainValue(source.scaleMode),
      imageTransform: toPlainValue(source.imageTransform),
      rotation: toPlainValue(source.rotation),
      filters: toPlainValue(source.filters),
      asset
    });
  }

  if (type.startsWith("GRADIENT")) {
    return removeEmpty({
      ...base,
      gradientTransform: toPlainValue(source.gradientTransform),
      gradientStops: toPlainValue(source.gradientStops)
    });
  }

  return removeEmpty({
    ...base,
    raw: toPlainValue(source)
  });
}

async function registerImageAsset(imageHash: string, context: ExportContext): Promise<AssetReference> {
  const existing = context.assetsByHash.get(imageHash);

  if (existing) {
    return existing;
  }

  const image = figma.getImageByHash(imageHash);
  const id = `image-${String(context.nextAssetIndex).padStart(3, "0")}`;
  context.nextAssetIndex += 1;

  if (!image) {
    const missing: AssetReference = {
      id,
      kind: "image",
      imageHash,
      missing: true,
      error: "Image bytes are not available from Figma."
    };
    context.assetsByHash.set(imageHash, missing);
    return missing;
  }

  try {
    const bytes = await image.getBytesAsync();
    const format = sniffImageFormat(bytes);
    const path = `assets/${id}.${format.extension}`;
    const asset: AssetReference = {
      id,
      kind: "image",
      imageHash,
      path,
      mimeType: format.mimeType,
      byteLength: bytes.byteLength
    };

    context.assetsByHash.set(imageHash, asset);
    context.assetFiles.push({
      path,
      mimeType: format.mimeType,
      bytes,
      kind: "asset"
    });

    return asset;
  } catch (error) {
    const missing: AssetReference = {
      id,
      kind: "image",
      imageHash,
      missing: true,
      error: errorMessage(error)
    };
    context.assetsByHash.set(imageHash, missing);
    return missing;
  }
}

function serializeLayout(node: SceneNode): JsonObject | undefined {
  const layout = removeEmpty({
    mode: readPlain(node, "layoutMode"),
    wrap: readPlain(node, "layoutWrap"),
    primaryAxisSizingMode: readPlain(node, "primaryAxisSizingMode"),
    counterAxisSizingMode: readPlain(node, "counterAxisSizingMode"),
    primaryAxisAlignItems: readPlain(node, "primaryAxisAlignItems"),
    counterAxisAlignItems: readPlain(node, "counterAxisAlignItems"),
    counterAxisAlignContent: readPlain(node, "counterAxisAlignContent"),
    itemSpacing: readPlain(node, "itemSpacing"),
    counterAxisSpacing: readPlain(node, "counterAxisSpacing"),
    padding: serializePadding(node),
    constraints: readPlain(node, "constraints"),
    layoutAlign: readPlain(node, "layoutAlign"),
    layoutGrow: readPlain(node, "layoutGrow"),
    layoutPositioning: readPlain(node, "layoutPositioning"),
    minWidth: readPlain(node, "minWidth"),
    maxWidth: readPlain(node, "maxWidth"),
    minHeight: readPlain(node, "minHeight"),
    maxHeight: readPlain(node, "maxHeight"),
    strokesIncludedInLayout: readPlain(node, "strokesIncludedInLayout")
  });

  return Object.keys(layout).length > 0 ? layout : undefined;
}

function serializePadding(node: SceneNode): JsonObject | undefined {
  const padding = removeEmpty({
    left: readPlain(node, "paddingLeft"),
    right: readPlain(node, "paddingRight"),
    top: readPlain(node, "paddingTop"),
    bottom: readPlain(node, "paddingBottom")
  });

  return Object.keys(padding).length > 0 ? padding : undefined;
}

function serializeText(node: SceneNode): JsonObject | undefined {
  if (node.type !== "TEXT") {
    return undefined;
  }

  const text = removeEmpty({
    characters: readPlain(node, "characters"),
    fontSize: readPlain(node, "fontSize"),
    fontName: readPlain(node, "fontName"),
    fontWeight: readPlain(node, "fontWeight"),
    textAlignHorizontal: readPlain(node, "textAlignHorizontal"),
    textAlignVertical: readPlain(node, "textAlignVertical"),
    textAutoResize: readPlain(node, "textAutoResize"),
    paragraphIndent: readPlain(node, "paragraphIndent"),
    paragraphSpacing: readPlain(node, "paragraphSpacing"),
    listSpacing: readPlain(node, "listSpacing"),
    hangingPunctuation: readPlain(node, "hangingPunctuation"),
    hangingList: readPlain(node, "hangingList"),
    letterSpacing: readPlain(node, "letterSpacing"),
    lineHeight: readPlain(node, "lineHeight"),
    textCase: readPlain(node, "textCase"),
    textDecoration: readPlain(node, "textDecoration")
  });

  return Object.keys(text).length > 0 ? text : undefined;
}

function serializeComponent(node: SceneNode): JsonObject | undefined {
  if (node.type !== "INSTANCE" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    return undefined;
  }

  const mainComponent = readUnknown(node, "mainComponent");
  const component = removeEmpty({
    key: readPlain(node, "key"),
    variantProperties: readPlain(node, "variantProperties"),
    componentProperties: readPlain(node, "componentProperties"),
    mainComponent: mainComponent && typeof mainComponent === "object"
      ? removeEmpty({
        id: toPlainValue((mainComponent as JsonObject).id),
        name: toPlainValue((mainComponent as JsonObject).name),
        key: toPlainValue((mainComponent as JsonObject).key)
      })
      : undefined
  });

  return Object.keys(component).length > 0 ? component : undefined;
}

function serializeExportHints(node: SceneNode): JsonObject {
  const layoutMode = readUnknown(node, "layoutMode");
  const children = readArray<SceneNode>(node, "children");

  return removeEmpty({
    flutterWidgetGuess: guessFlutterWidget(node, layoutMode, children),
    shouldClip: readUnknown(node, "clipsContent") === true ? true : undefined
  });
}

function guessFlutterWidget(node: SceneNode, layoutMode: unknown, children: readonly SceneNode[] | undefined): string {
  if (node.type === "TEXT") {
    return "Text";
  }

  if (hasImageFill(node)) {
    return children && children.length > 0 ? "ContainerWithDecorationImage" : "Image";
  }

  if (layoutMode === "HORIZONTAL") {
    return "Row";
  }

  if (layoutMode === "VERTICAL") {
    return "Column";
  }

  if (children && children.length > 0) {
    return "Stack";
  }

  if (node.type === "ELLIPSE") {
    return "Container.circle";
  }

  return "Container";
}

function hasImageFill(node: SceneNode): boolean {
  const fills = readUnknown(node, "fills");

  if (!Array.isArray(fills)) {
    return false;
  }

  return fills.some((fill) => asObject(fill).type === "IMAGE");
}

function serializeBounds(bounds: Rect | null, rootBox: Rect | null): JsonObject | undefined {
  if (!bounds) {
    return undefined;
  }

  const absolute = {
    x: round(bounds.x),
    y: round(bounds.y),
    width: round(bounds.width),
    height: round(bounds.height)
  };

  return {
    absolute,
    local: rootBox
      ? {
        x: round(bounds.x - rootBox.x),
        y: round(bounds.y - rootBox.y),
        width: round(bounds.width),
        height: round(bounds.height)
      }
      : absolute
  };
}

function serializeTransform(node: SceneNode): JsonObject | undefined {
  const transform = readUnknown(node, "relativeTransform");

  if (!transform) {
    return undefined;
  }

  return removeEmpty({
    relativeTransform: toPlainValue(transform),
    rotation: readPlain(node, "rotation")
  });
}

function serializeCornerRadius(node: SceneNode): JsonObject | undefined {
  const all = readUnknown(node, "cornerRadius");
  const corners = removeEmpty({
    topLeft: readPlain(node, "topLeftRadius"),
    topRight: readPlain(node, "topRightRadius"),
    bottomRight: readPlain(node, "bottomRightRadius"),
    bottomLeft: readPlain(node, "bottomLeftRadius")
  });

  if (all !== undefined && all !== figma.mixed) {
    return removeEmpty({
      all: toPlainValue(all),
      ...corners
    });
  }

  if (Object.keys(corners).length > 0) {
    return corners;
  }

  if (all === figma.mixed) {
    return { all: "MIXED" };
  }

  return undefined;
}

function serializeEffects(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value === figma.mixed) {
    return "MIXED";
  }

  if (!Array.isArray(value)) {
    return toPlainValue(value);
  }

  return value.map((effect) => {
    const source = asObject(effect);

    return removeEmpty({
      type: toPlainValue(source.type),
      visible: source.visible === false ? false : undefined,
      color: serializeColor(source.color),
      offset: toPlainValue(source.offset),
      radius: toPlainValue(source.radius),
      spread: toPlainValue(source.spread),
      blendMode: toPlainValue(source.blendMode)
    });
  });
}

function serializeColor(value: unknown): JsonObject | undefined {
  const source = asObject(value);

  if (typeof source.r !== "number" || typeof source.g !== "number" || typeof source.b !== "number") {
    return undefined;
  }

  return {
    r: round(source.r),
    g: round(source.g),
    b: round(source.b),
    hex: rgbToHex(source.r, source.g, source.b)
  };
}

function getBounds(node: SceneNode): Rect | null {
  const absoluteBoundingBox = readUnknown(node, "absoluteBoundingBox");

  if (isRect(absoluteBoundingBox)) {
    return absoluteBoundingBox;
  }

  const absoluteRenderBounds = readUnknown(node, "absoluteRenderBounds");

  if (isRect(absoluteRenderBounds)) {
    return absoluteRenderBounds;
  }

  return null;
}

function getUnionBounds(nodes: readonly SceneNode[]): Rect | null {
  let union: Rect | null = null;

  for (const node of nodes) {
    const bounds = getBounds(node);

    if (!bounds) {
      continue;
    }

    if (!union) {
      union = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      };
      continue;
    }

    const minX = Math.min(union.x, bounds.x);
    const minY = Math.min(union.y, bounds.y);
    const maxX = Math.max(union.x + union.width, bounds.x + bounds.width);
    const maxY = Math.max(union.y + union.height, bounds.y + bounds.height);

    union = {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  return union;
}

function isRect(value: unknown): value is Rect {
  const source = asObject(value);
  return typeof source.x === "number"
    && typeof source.y === "number"
    && typeof source.width === "number"
    && typeof source.height === "number";
}

function canExport(node: SceneNode): node is SceneNode & { exportAsync(settings?: ExportSettings): Promise<Uint8Array> } {
  return typeof node.exportAsync === "function";
}

function isExportRequest(message: unknown): message is ExportRequestMessage {
  return asObject(message).type === "export-request";
}

async function maybeReportNodeProgress(node: SceneNode, context: ExportContext): Promise<void> {
  const current = context.nodeCount;

  if (current === 1
    || current === context.totalNodes
    || current % context.progressEvery === 0) {
    postProgress({
      phase: "serializing",
      current,
      total: context.totalNodes,
      label: `正在读取节点 ${current}/${context.totalNodes}`,
      detail: node.name
    });
    await yieldToUi();
  }
}

function postStatus(message: string, tone: StatusMessage["tone"] = "info"): void {
  postToUi({
    type: "status",
    message,
    tone
  });
}

function postProgress(message: Omit<ProgressMessage, "type">): void {
  postToUi({
    type: "progress",
    ...message
  });
}

function postToUi(message: StatusMessage | ProgressMessage | ExportReadyMessage | ExportErrorMessage): void {
  figma.ui.postMessage(message);
}

function yieldToUi(): Promise<void> {
  return new Promise((resolveYield) => {
    setTimeout(resolveYield, 0);
  });
}

function sanitizeFolderName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|#%{}$!@+`=\r\n\t]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "figma-export";
  }

  return cleaned;
}

function sniffImageFormat(bytes: Uint8Array): { extension: string; mimeType: string } {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47) {
    return { extension: "png", mimeType: "image/png" };
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }

  if (bytes.length >= 6
    && bytes[0] === 0x47
    && bytes[1] === 0x49
    && bytes[2] === 0x46) {
    return { extension: "gif", mimeType: "image/gif" };
  }

  if (bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50) {
    return { extension: "webp", mimeType: "image/webp" };
  }

  return { extension: "bin", mimeType: "application/octet-stream" };
}

function encodeText(value: string): Uint8Array {
  const textEncoder = readUnknown(globalThis, "TextEncoder");

  if (typeof textEncoder === "function") {
    const TextEncoderConstructor = textEncoder as { new (): { encode(input: string): Uint8Array } };
    return new TextEncoderConstructor().encode(value);
  }

  const bytes: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18));
      bytes.push(0x80 | ((codePoint >> 12) & 0x3f));
      bytes.push(0x80 | ((codePoint >> 6) & 0x3f));
      bytes.push(0x80 | (codePoint & 0x3f));
    }
  }

  return new Uint8Array(bytes);
}

function readPlain(source: SceneNode, key: string): unknown {
  return toPlainValue(readUnknown(source, key));
}

function readUnknown(source: unknown, key: string): unknown {
  try {
    return asObject(source)[key];
  } catch {
    return undefined;
  }
}

function readArray<T>(source: unknown, key: string): readonly T[] | undefined {
  const value = readUnknown(source, key);
  return Array.isArray(value) ? value as readonly T[] : undefined;
}

function toPlainValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (value === figma.mixed) {
    return "MIXED";
  }

  if (typeof value === "number") {
    return round(value);
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toPlainValue);
  }

  if (typeof value === "object") {
    const result: JsonObject = {};

    for (const [key, child] of Object.entries(value as JsonObject)) {
      const plain = toPlainValue(child);

      if (plain !== undefined) {
        result[key] = plain;
      }
    }

    return result;
  }

  return String(value);
}

function removeEmpty<T extends JsonObject>(object: T): T {
  for (const key of Object.keys(object)) {
    const value = object[key];

    if (value === undefined) {
      delete object[key];
    }
  }

  return object;
}

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object") {
    return value as JsonObject;
  }

  return {};
}

function round(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  return Math.round(value * 1000) / 1000;
}

function rgbToHex(r: number, g: number, b: number): string {
  const toChannel = (value: number): string => {
    const channel = Math.max(0, Math.min(255, Math.round(value * 255)));
    return channel.toString(16).padStart(2, "0");
  };

  return `#${toChannel(r)}${toChannel(g)}${toChannel(b)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
