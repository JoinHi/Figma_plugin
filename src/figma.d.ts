declare const __html__: string;
declare const figma: PluginAPI;

type FigmaMixed = typeof figma.mixed;

interface PluginAPI {
  readonly mixed: unique symbol;
  readonly currentPage: PageNode;
  readonly ui: UIAPI;
  showUI(html: string, options?: ShowUIOptions): void;
  closePlugin(message?: string): void;
  notify(message: string, options?: NotificationOptions): NotificationHandler;
  getImageByHash(hash: string): FigmaImage | null;
}

interface ShowUIOptions {
  width?: number;
  height?: number;
  themeColors?: boolean;
}

interface NotificationOptions {
  timeout?: number;
  error?: boolean;
}

interface NotificationHandler {
  cancel(): void;
}

interface UIAPI {
  onmessage: ((pluginMessage: unknown) => void) | null;
  postMessage(pluginMessage: unknown): void;
  resize(width: number, height: number): void;
}

interface FigmaImage {
  getBytesAsync(): Promise<Uint8Array>;
}

interface PageNode {
  readonly id: string;
  readonly name: string;
  readonly selection: readonly SceneNode[];
}

interface SceneNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly removed?: boolean;
  readonly parent?: BaseNode | null;
  readonly children?: readonly SceneNode[];
  readonly absoluteBoundingBox?: Rect | null;
  readonly absoluteRenderBounds?: Rect | null;
  readonly relativeTransform?: Transform;
  readonly rotation?: number;
  exportAsync?(settings?: ExportSettings): Promise<Uint8Array>;
  [key: string]: unknown;
}

interface BaseNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Transform = readonly [readonly [number, number, number], readonly [number, number, number]];

interface ExportSettings {
  format: "PNG" | "JPG" | "SVG" | "PDF";
  constraint?: {
    type: "SCALE" | "WIDTH" | "HEIGHT";
    value: number;
  };
}
