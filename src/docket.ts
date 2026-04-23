export type HudMode = "always" | "lazy";

/** Subset of glimpseui's GlimpseWindow that Docket touches. */
export type GWindow = {
  setHTML: (html: string) => void;
  close: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type GlimpseOpen = (html: string, options: Record<string, unknown>) => GWindow;

export interface DocketOptions {
  /** Injected glimpseui.open (for tests). Defaults to the real module loaded lazily. */
  open?: GlimpseOpen;
  /** When true, show/hide/close are no-ops. Used by tests and CI. */
  disabled?: boolean;
  /** Max time to wait for the probe window's `ready` event. */
  probeTimeoutMs?: number;
}

export interface Docket {
  show(html: string, title?: string): Promise<void>;
  hide(): Promise<void>;
  close(): Promise<void>;
}

type ScreenDims = { width: number; height: number };

const HUD_WIDTH = 320;
const HUD_HEIGHT = 400;
const MARGIN = 20;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;

export const PLACEHOLDER_HTML = `<!doctype html>
<meta name="color-scheme" content="light dark">
<body style="background:transparent!important;margin:0;font-family:-apple-system,system-ui,sans-serif">
  <div style="position:fixed;top:20px;right:20px;
              display:flex;align-items:center;gap:8px;
              padding:8px 14px;border-radius:999px;
              background:color-mix(in srgb, canvas 70%, transparent);
              backdrop-filter:blur(24px) saturate(180%);
              -webkit-backdrop-filter:blur(24px) saturate(180%);
              border:1px solid color-mix(in srgb, canvastext 10%, transparent);
              font-size:12px;color:canvastext;">
    <span style="width:8px;height:8px;border-radius:50%;background:#34c759;
                 box-shadow:0 0 6px rgba(52,199,89,.6)"></span>
    clawd-docklet
  </div>
</body>`;

async function loadGlimpseOpen(): Promise<GlimpseOpen> {
  // glimpseui ships .mjs without types; cast through unknown at the boundary.
  // @ts-expect-error no types for "glimpseui"
  const mod = (await import("glimpseui")) as { open: GlimpseOpen };
  return mod.open;
}

export function createDocket(opts: DocketOptions = {}): Docket {
  const disabled = opts.disabled === true;
  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let openFn: GlimpseOpen | null = opts.open ?? null;

  async function getOpen(): Promise<GlimpseOpen> {
    if (openFn) return openFn;
    openFn = await loadGlimpseOpen();
    return openFn;
  }

  let win: GWindow | null = null;
  let dims: ScreenDims | null = null;
  let probeInFlight: Promise<ScreenDims> | null = null;

  function probe(): Promise<ScreenDims> {
    if (dims) return Promise.resolve(dims);
    if (probeInFlight) return probeInFlight;
    // Assign probeInFlight synchronously (no await above this line) so
    // concurrent callers share the same probe and we never open two probe
    // windows. The setTimeout must also be scheduled synchronously so tests
    // using fake timers can advance to the timeout deterministically.
    probeInFlight = new Promise<ScreenDims>((resolve, reject) => {
      // Resolve the open fn synchronously when injected; otherwise fall back
      // to the lazy dynamic import path.
      const startProbe = (open: GlimpseOpen) => {
        const probeWin = open("", {
          width: 1,
          height: 1,
          x: -10000,
          y: -10000,
          frameless: true,
          transparent: true,
          clickThrough: true,
          noDock: true,
        });
        const timer = setTimeout(() => {
          try { probeWin.close(); } catch { /* ignore */ }
          reject(new Error(`docket: probe timed out after ${probeTimeoutMs}ms`));
        }, probeTimeoutMs);
        probeWin.once("ready", (...args: unknown[]) => {
          clearTimeout(timer);
          const info = args[0] as { screen?: { visibleWidth?: number; visibleHeight?: number } } | undefined;
          const width = info?.screen?.visibleWidth ?? 0;
          const height = info?.screen?.visibleHeight ?? 0;
          try { probeWin.close(); } catch { /* ignore */ }
          if (!width || !height) {
            reject(new Error(`docket: probe returned invalid dims (${width}×${height})`));
            return;
          }
          dims = { width, height };
          resolve(dims);
        });
        probeWin.once("error", (...args: unknown[]) => {
          clearTimeout(timer);
          try { probeWin.close(); } catch { /* ignore */ }
          const err = args[0];
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      };
      if (openFn) {
        startProbe(openFn);
      } else {
        loadGlimpseOpen().then(
          (fn) => { openFn = fn; startProbe(fn); },
          reject,
        );
      }
    }).finally(() => {
      probeInFlight = null;
    });
    return probeInFlight;
  }

  function openReal(open: GlimpseOpen, html: string, d: ScreenDims, title?: string): GWindow {
    const options: Record<string, unknown> = {
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      x: d.width - HUD_WIDTH - MARGIN,
      y: d.height - HUD_HEIGHT - MARGIN,
      frameless: true,
      transparent: true,
      clickThrough: true,
      floating: true,
      noDock: true,
    };
    if (title !== undefined) options.title = title;
    const w = open(html, options);
    w.once("closed", () => {
      if (win === w) win = null;
    });
    return w;
  }

  return {
    async show(html: string, title?: string): Promise<void> {
      if (disabled) return;
      if (win) {
        win.setHTML(html);
        return;
      }
      const d = await probe();
      // Another concurrent show() may have opened the window while we awaited.
      if (win) {
        (win as GWindow).setHTML(html);
        return;
      }
      // probe() ensures openFn is cached; use it synchronously so concurrent
      // post-probe resumes don't both open a real window.
      const open = openFn ?? await getOpen();
      if (win) {
        (win as GWindow).setHTML(html);
        return;
      }
      win = openReal(open, html, d, title);
    },
    async hide(): Promise<void> {
      if (disabled) return;
      if (!win) return;
      try { win.close(); } catch { /* ignore */ }
      win = null;
    },
    async close(): Promise<void> {
      if (disabled) return;
      if (win) {
        try { win.close(); } catch { /* ignore */ }
        win = null;
      }
    },
  };
}
