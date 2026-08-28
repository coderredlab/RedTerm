import type { Cell, TerminalImage, TextStyle } from './ansi-parser';

export interface CanvasRendererConfig {
  fontSize: number;
  fontFamily: string;
  lineHeightMultiplier: number;
  defaultFg: string;
  defaultBg: string;
  cursorColor: string;
  horizontalPadding: number;
  onImageLoad?: () => void;
}

const DEFAULT_CONFIG: CanvasRendererConfig = {
  fontSize: 14,
  fontFamily: '"Sarasa Term K Nerd", "JetBrains Mono", "Fira Code", monospace',
  lineHeightMultiplier: 1.4,
  defaultFg: '#e8d4d4',
  defaultBg: '#1a0f0f',
  cursorColor: '#ff6b6b',
  horizontalPadding: 8,
};

const MAX_IMAGE_CACHE_ENTRIES = 64;
const MAX_IMAGE_CACHE_PIXELS = 8 * 1024 * 1024;

type ImageCacheEntry =
  | { kind: 'ready'; canvas: HTMLCanvasElement; pixelCount: number }
  | { kind: 'loading'; url: string; pixelCount: number };

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private visibleCtx: CanvasRenderingContext2D;
  /** 오프스크린 버퍼 — 모든 draw 호출은 여기에, endDraw에서 visible canvas로 복사 (더블 버퍼링) */
  private offscreen: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: CanvasRendererConfig;
  private dpr: number;
  private imageCache = new Map<number, ImageCacheEntry>();
  private imageCachePixels = 0;
  private activeImageIds = new Set<number>();


  charWidth = 0;
  charHeight = 0;

  private cols = 0;
  private rows = 0;

  constructor(canvas: HTMLCanvasElement, config?: Partial<CanvasRendererConfig>) {
    this.canvas = canvas;
    const visibleCtx = canvas.getContext('2d', { alpha: false });
    if (!visibleCtx) throw new Error('Failed to get 2d context');
    this.visibleCtx = visibleCtx;

    // 오프스크린 캔버스 (더블 버퍼링)
    this.offscreen = document.createElement('canvas');
    const offCtx = this.offscreen.getContext('2d', { alpha: false });
    if (!offCtx) throw new Error('Failed to get offscreen 2d context');
    this.ctx = offCtx;

    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dpr = window.devicePixelRatio || 1;
  }

  measureFont() {
    const { fontSize, fontFamily, lineHeightMultiplier } = this.config;

    // 그릴 그 ctx에서 직접 잰다 — DOM과 Canvas가 서로 다른 폰트로 fallback되면
    // 측정값과 실제 글리프 폭이 어긋나 셀이 글자보다 훨씬 넓어진다.
    const measureWith = (family: string) => {
      this.ctx.font = `${fontSize}px ${family}`;
      const m = this.ctx.measureText('M').width;
      const i = this.ctx.measureText('i').width;
      return { m, i, monospace: Math.abs(m - i) < 0.5 };
    };

    let result = measureWith(fontFamily);
    let appliedFamily = fontFamily;
    if (!result.monospace) {
      const fallback = measureWith('monospace');
      if (fallback.monospace) {
        result = fallback;
        appliedFamily = 'monospace';
      }
    }

    this.charWidth = result.m;
    this.charHeight = Math.round(fontSize * lineHeightMultiplier);
    this.ctx.font = `${fontSize}px ${appliedFamily}`;
  }

  resize(widthCss: number, heightCss: number, cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.dpr = window.devicePixelRatio || 1;

    const pw = Math.round(widthCss * this.dpr);
    const ph = Math.round(heightCss * this.dpr);

    this.canvas.width = pw;
    this.canvas.height = ph;
    this.canvas.style.width = `${widthCss}px`;
    this.canvas.style.height = `${heightCss}px`;

    // 오프스크린도 동일 크기
    this.offscreen.width = pw;
    this.offscreen.height = ph;

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.font = `${this.config.fontSize}px ${this.config.fontFamily}`;
    this.ctx.textBaseline = 'top';
  }

  /** 런타임에 config 업데이트 (폰트 크기, 색상 등). 호출 후 measureFont()→resize() 필요. */
  updateConfig(newConfig: Partial<CanvasRendererConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  clear() {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    // clearRect로 pixel buffer를 완전 리셋 후, fillRect로 배경 채우기 (Android WebView 잔상 방지)
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.fillStyle = this.config.defaultBg;
    this.ctx.fillRect(0, 0, w, h);
  }

  /** 스크롤 소수점 오프셋 적용 — clear() 후, 모든 draw 호출 전에 호출 */
  beginDraw(scrollFracY: number) {
    this.ctx.save();
    this.ctx.translate(0, -scrollFracY);
  }

  /** beginDraw 후 draw 완료 시 호출 — 오프스크린 버퍼를 visible canvas에 한번에 복사 */
  endDraw() {
    this.ctx.restore();
    // restore() 후 폰트/baseline 재설정
    this.ctx.font = `${this.config.fontSize}px ${this.config.fontFamily}`;
    this.ctx.textBaseline = 'top';

    // 더블 버퍼링: 완성된 프레임을 visible canvas에 한번에 복사
    this.visibleCtx.drawImage(this.offscreen, 0, 0);
  }

  drawRow(screenY: number, cells: Cell[]) {
    const { horizontalPadding, defaultBg, fontSize, fontFamily } = this.config;
    const y = screenY * this.charHeight;
    const baseFont = `${fontSize}px ${fontFamily}`;

    // 행 배경 클리어 (+1px overlap으로 서브픽셀 갭 방지)
    const rowH = this.charHeight + 1;
    this.ctx.fillStyle = defaultBg;
    this.ctx.fillRect(0, y, this.canvas.width / this.dpr, rowH);

    // Pass 1: 셀 배경 그리기 (같은 색 연속 셀을 하나의 rect로 합쳐서 서브픽셀 갭 방지)
    let x = horizontalPadding;
    let runBg = '';
    let runX = 0;
    let runW = 0;

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (cell.char === '') continue;
      const cellWidth = this.isWideChar(cell.char) ? this.charWidth * 2 : this.charWidth;
      const bg = this.resolveBg(cell.style);

      if (bg !== defaultBg) {
        if (bg === runBg) {
          // 같은 배경색 연속 — run 확장
          runW += cellWidth;
        } else {
          // 이전 run flush
          if (runW > 0) {
            this.ctx.fillStyle = runBg;
            this.ctx.fillRect(runX, y, runW, rowH);
          }
          // 새 run 시작
          runBg = bg;
          runX = x;
          runW = cellWidth;
        }
      } else {
        // default bg — 이전 run flush
        if (runW > 0) {
          this.ctx.fillStyle = runBg;
          this.ctx.fillRect(runX, y, runW, rowH);
          runW = 0;
        }
      }
      x += cellWidth;
    }
    // 마지막 run flush
    if (runW > 0) {
      this.ctx.fillStyle = runBg;
      this.ctx.fillRect(runX, y, runW, rowH);
    }

    // Pass 2: 모든 텍스트 그리기 (배경 위에 — 너드폰트 overflow 보호)
    // textAlign='center'로 모든 문자를 셀 중앙에 배치 (DOM text-align:center 재현)
    x = horizontalPadding;
    let currentFont = '';
    const textY = y + (this.charHeight - fontSize) / 2;
    this.ctx.textAlign = 'center';

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      // wide char placeholder: skip (wide char already advanced x by 2 cells)
      if (cell.char === '') continue;

      const style = cell.style;
      const cellWidth = this.isWideChar(cell.char) ? this.charWidth * 2 : this.charWidth;

      // hidden(SGR 8): 텍스트를 그리지 않음
      if (!style.hidden) {
        // 전경색
        this.ctx.fillStyle = this.resolveFg(style);

        // 폰트 (변경 시에만 설정 — 성능 최적화)
        const fontPrefix = this.getFontPrefix(style);
        const targetFont = fontPrefix ? `${fontPrefix}${baseFont}` : baseFont;
        if (targetFont !== currentFont) {
          this.ctx.font = targetFont;
          currentFont = targetFont;
        }

        // 셀 중앙점에 텍스트 그리기
        this.ctx.fillText(cell.char, x + cellWidth / 2, textY);
      }

      // 밑줄
      if (style.underline) {
        this.ctx.fillStyle = this.resolveFg(style);
        this.ctx.fillRect(x, y + this.charHeight - 1, cellWidth, 1);
      }

      // 취소선 (SGR 9)
      if (style.strikethrough) {
        this.ctx.fillStyle = this.resolveFg(style);
        this.ctx.fillRect(x, y + this.charHeight / 2, cellWidth, 1);
      }

      x += cellWidth;
    }

    this.ctx.textAlign = 'start'; // 복원
  }

  drawCursor(cursorX: number, screenY: number) {
    const x = this.config.horizontalPadding + cursorX * this.charWidth;
    const y = screenY * this.charHeight;
    this.ctx.fillStyle = this.config.cursorColor;
    this.ctx.globalAlpha = 0.95;
    this.ctx.fillRect(x, y, Math.max(1, this.charWidth), this.charHeight);
    this.ctx.globalAlpha = 1.0;
  }

  drawSelection(startRow: number, startCol: number, endRow: number, endCol: number, viewStartRow: number) {
    this.ctx.fillStyle = 'rgba(255, 107, 107, 0.3)';

    for (let row = startRow; row <= endRow; row++) {
      const screenY = row - viewStartRow;
      if (screenY < 0 || screenY >= this.rows + 2) continue;

      const y = screenY * this.charHeight;
      const colStart = row === startRow ? startCol : 0;
      const lastCol = row === endRow ? endCol : this.cols - 1;
      if (lastCol < colStart) continue;

      const x = this.config.horizontalPadding + colStart * this.charWidth;
      const w = (lastCol - colStart + 1) * this.charWidth;
      this.ctx.fillRect(x, y, w, this.charHeight);
    }
  }

  drawVisibleRows(buffer: Cell[][], startRow: number, endRow: number) {
    for (let bufferY = startRow; bufferY < endRow && bufferY < buffer.length; bufferY++) {
      const screenY = bufferY - startRow;
      this.drawRow(screenY, buffer[bufferY]);
    }
  }

  drawImages(images: TerminalImage[], startRow: number, endRow: number) {
    this.activeImageIds.clear();
    for (const image of images) this.activeImageIds.add(image.id);
    this.pruneImageCache(this.activeImageIds);
    for (const image of images) {
      if (image.row >= endRow || image.row + image.heightCells <= startRow) continue;
      const source = this.getImageCanvas(image);
      if (!source) continue;

      const x = this.config.horizontalPadding + image.col * this.charWidth;
      const y = (image.row - startRow) * this.charHeight;
      const width = image.widthCells * this.charWidth;
      const height = image.heightCells * this.charHeight;
      this.ctx.drawImage(source, x, y, width, height);
    }
  }

  private getImageCanvas(image: TerminalImage): HTMLCanvasElement | null {
    const cached = this.imageCache.get(image.id);
    if (cached?.kind === 'ready') return cached.canvas;
    if (cached?.kind === 'loading') return null;

    const pixelCount = image.pixelWidth * image.pixelHeight;
    if (!this.evictImageCacheIfNeeded(pixelCount)) return null;

    if (image.kind === 'png' || image.kind === 'encoded') {
      const blob = new Blob([image.data], { type: image.mimeType });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const loadingEntry: ImageCacheEntry = { kind: 'loading', url, pixelCount };
      this.imageCache.set(image.id, loadingEntry);
      this.imageCachePixels += pixelCount;
      img.onload = () => {
        if (this.imageCache.get(image.id) !== loadingEntry) {
          URL.revokeObjectURL(url);
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = image.pixelWidth;
        canvas.height = image.pixelHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          this.deleteImageCacheEntry(image.id);
          return;
        }

        ctx.drawImage(img, 0, 0, image.pixelWidth, image.pixelHeight);
        URL.revokeObjectURL(url);
        this.imageCache.set(image.id, { kind: 'ready', canvas, pixelCount });
        this.config.onImageLoad?.();
      };

      img.onerror = () => {
        if (this.imageCache.get(image.id) === loadingEntry) {
          this.deleteImageCacheEntry(image.id);
        }
      };
      img.src = url;
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = image.pixelWidth;
    canvas.height = image.pixelHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get image canvas context');
    ctx.putImageData(new ImageData(image.data, image.pixelWidth, image.pixelHeight), 0, 0);

    this.imageCache.set(image.id, { kind: 'ready', canvas, pixelCount });
    this.imageCachePixels += pixelCount;
    return canvas;
  }

  private evictImageCacheIfNeeded(incomingPixels: number): boolean {
    if (incomingPixels > MAX_IMAGE_CACHE_PIXELS) return false;

    while (
      this.imageCache.size >= MAX_IMAGE_CACHE_ENTRIES ||
      this.imageCachePixels + incomingPixels > MAX_IMAGE_CACHE_PIXELS
    ) {
      const oldestKey = this.imageCache.keys().next().value as number | undefined;
      if (oldestKey === undefined) return false;
      this.deleteImageCacheEntry(oldestKey);
    }
    return true;
  }

  private pruneImageCache(activeImageIds: Set<number>) {
    for (const imageId of this.imageCache.keys()) {
      if (!activeImageIds.has(imageId)) {
        this.deleteImageCacheEntry(imageId);
      }
    }
  }

  private deleteImageCacheEntry(imageId: number) {
    const entry = this.imageCache.get(imageId);
    if (!entry) return;
    if (entry.kind === 'loading') {
      URL.revokeObjectURL(entry.url);
    }
    this.imageCachePixels -= entry.pixelCount;
    this.imageCache.delete(imageId);
  }

  drawDirtyRows(
    buffer: Cell[][],
    dirtyBufferRows: Set<number> | 'all',
    scrollbackLength: number,
    startRow: number,
    endRow: number,
  ) {
    if (dirtyBufferRows === 'all') {
      this.drawVisibleRows(buffer, startRow, endRow);
      return;
    }

    for (const bufferY of dirtyBufferRows) {
      const fullY = bufferY + scrollbackLength;
      if (fullY >= startRow && fullY < endRow) {
        const screenY = fullY - startRow;
        this.drawRow(screenY, buffer[fullY]);
      }
    }
  }

  // ─── Style helpers ─────────────────────────────────────

  private resolveNormalFg(style: TextStyle): string {
    return style.fg ?? this.config.defaultFg;
  }

  private resolveFg(style: TextStyle): string {
    const fg = this.resolveNormalFg(style);

    if (style.inverse) {
      return style.bg === 'transparent' ? this.config.defaultBg : style.bg;
    }
    if (style.dim) {
      return this.blendWithBg(fg, 0.5);
    }
    return fg;
  }

  private resolveBg(style: TextStyle): string {
    if (style.inverse) {
      return this.resolveNormalFg(style);
    }
    return style.bg === 'transparent' ? this.config.defaultBg : style.bg;
  }

  private getFontPrefix(style: TextStyle): string {
    const parts: string[] = [];
    if (style.italic) parts.push('italic');
    if (style.bold) parts.push('bold');
    return parts.length > 0 ? parts.join(' ') + ' ' : '';
  }

  private blendWithBg(fgHex: string, alpha: number): string {
    const fg = this.parseColor(fgHex);
    const bg = this.parseColor(this.config.defaultBg);
    if (!fg || !bg) return fgHex;

    const r = Math.round(fg.r * alpha + bg.r * (1 - alpha));
    const g = Math.round(fg.g * alpha + bg.g * (1 - alpha));
    const b = Math.round(fg.b * alpha + bg.b * (1 - alpha));
    return `rgb(${r},${g},${b})`;
  }

  private colorCache = new Map<string, { r: number; g: number; b: number } | null>();

  private parseColor(color: string): { r: number; g: number; b: number } | null {
    const cached = this.colorCache.get(color);
    if (cached !== undefined) return cached;

    let result: { r: number; g: number; b: number } | null = null;

    if (color.startsWith('#')) {
      const hex = color.slice(1);
      if (hex.length === 3) {
        result = {
          r: parseInt(hex[0] + hex[0], 16),
          g: parseInt(hex[1] + hex[1], 16),
          b: parseInt(hex[2] + hex[2], 16),
        };
      } else if (hex.length === 6) {
        result = {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
        };
      }
    } else if (color.startsWith('rgb')) {
      const match = color.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (match) {
        result = { r: +match[1], g: +match[2], b: +match[3] };
      }
    }

    if (this.colorCache.size > 512) {
      const first = this.colorCache.keys().next().value;
      if (first !== undefined) this.colorCache.delete(first);
    }
    this.colorCache.set(color, result);
    return result;
  }

  // ─── Character width detection ─────────────────────────

  private wideCharCache = new Map<string, boolean>();

  private isWideChar(char: string): boolean {
    const cached = this.wideCharCache.get(char);
    if (cached !== undefined) return cached;

    const code = char.codePointAt(0)!;
    const isWide =
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0x1100 && code <= 0x11FF) ||
      (code >= 0x3130 && code <= 0x318F) ||
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x20000 && code <= 0x2A6DF) ||  // CJK Ext-B
      (code >= 0x2A700 && code <= 0x2CEAF) ||  // CJK Ext-C/D/E/F
      (code >= 0xF900 && code <= 0xFAFF) ||    // CJK Compatibility Ideographs
      (code >= 0x3040 && code <= 0x309F) ||
      (code >= 0x30A0 && code <= 0x30FF) ||
      (code >= 0xFF00 && code <= 0xFFEF);

    if (this.wideCharCache.size >= 2048) {
      const first = this.wideCharCache.keys().next().value;
      if (first !== undefined) this.wideCharCache.delete(first);
    }
    this.wideCharCache.set(char, isWide);
    return isWide;
  }

  destroy() {
    while (this.imageCache.size > 0) {
      const imageId = this.imageCache.keys().next().value as number | undefined;
      if (imageId === undefined) break;
      this.deleteImageCacheEntry(imageId);
    }
    this.activeImageIds.clear();
    this.colorCache.clear();
    this.wideCharCache.clear();
  }
}
