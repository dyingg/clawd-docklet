import { type Anchor, isAnchor } from "./config.js";

const POPOVER_WIDTH = 240;
const POPOVER_HEIGHT = 224;
const STATUS_TITLE = "D";

export type GStatusWindow = {
  setHTML: (html: string) => void;
  close: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type GlimpseStatusFactory = (
  html: string,
  options: { width: number; height: number; title?: string }
) => GStatusWindow;

export interface StatusItemCallbacks {
  initialAnchor: Anchor;
  onAnchor: (anchor: Anchor) => void | Promise<void>;
  onHide: () => void | Promise<void>;
}

export interface StatusItemOptions extends StatusItemCallbacks {
  /** Injected glimpseui.statusItem for tests. */
  factory?: GlimpseStatusFactory;
}

export interface StatusItem {
  /** Push a new active-anchor state into the popover UI (e.g. after external change). */
  setAnchor(anchor: Anchor): void;
  close(): void;
}

async function loadStatusFactory(): Promise<GlimpseStatusFactory> {
  // @ts-expect-error no types for "glimpseui"
  const mod = (await import("glimpseui")) as {
    statusItem: GlimpseStatusFactory;
  };
  return mod.statusItem;
}

/**
 * Render the popover's HTML with `selected` marked active.
 * Styled to look like a native macOS menu (SF text, small menu items,
 * checkmark on the active row, separator before the destructive action).
 */
export function renderPopoverHtml(selected: Anchor): string {
  return `<!doctype html>
<meta name="color-scheme" content="light dark">
<style>
  :root {
    --bg: #F6F6F6;
    --fg: rgba(0, 0, 0, 0.86);
    --fg-secondary: rgba(0, 0, 0, 0.5);
    --hover-bg: rgba(0, 0, 0, 0.06);
    --active-bg: rgba(0, 122, 255, 1);
    --active-fg: #fff;
    --sep: rgba(0, 0, 0, 0.1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #2B2B2B;
      --fg: rgba(255, 255, 255, 0.92);
      --fg-secondary: rgba(255, 255, 255, 0.5);
      --hover-bg: rgba(255, 255, 255, 0.08);
      --active-bg: rgba(10, 132, 255, 1);
      --sep: rgba(255, 255, 255, 0.14);
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
    user-select: none;
    cursor: default;
    overflow: hidden;
  }
  .header {
    padding: 8px 14px 2px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--fg-secondary);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 2px 6px;
  }
  li {
    display: flex;
    align-items: center;
    height: 22px;
    padding: 0 6px;
    border-radius: 4px;
    cursor: default;
    outline: none;
  }
  li:hover, li:focus {
    background: var(--hover-bg);
  }
  li:active {
    background: var(--active-bg);
    color: var(--active-fg);
  }
  li .mark {
    width: 14px;
    text-align: center;
    font-size: 11px;
    line-height: 1;
    opacity: 0;
    flex: 0 0 auto;
  }
  li.active .mark { opacity: 1; }
  li .label { flex: 1 1 auto; }
  .sep {
    height: 1px;
    background: var(--sep);
    margin: 4px 10px;
  }
</style>
<body>
  <div class="header">Docket anchor</div>
  <ul id="anchors">
    <li tabindex="0" data-anchor="top-right"><span class="mark">✓</span><span class="label">Top-right</span></li>
    <li tabindex="0" data-anchor="top-left"><span class="mark">✓</span><span class="label">Top-left</span></li>
    <li tabindex="0" data-anchor="bottom-right"><span class="mark">✓</span><span class="label">Bottom-right</span></li>
    <li tabindex="0" data-anchor="bottom-left"><span class="mark">✓</span><span class="label">Bottom-left</span></li>
    <li tabindex="0" data-anchor="follow-cursor"><span class="mark">✓</span><span class="label">Follow cursor</span></li>
  </ul>
  <div class="sep"></div>
  <ul>
    <li tabindex="0" id="hide"><span class="mark"></span><span class="label">Hide HUD</span></li>
  </ul>
  <script>
    (function () {
      var SELECTED = ${JSON.stringify(selected)};
      var anchorItems = document.querySelectorAll('li[data-anchor]');
      anchorItems.forEach(function (li) {
        if (li.dataset.anchor === SELECTED) li.classList.add('active');
        li.addEventListener('click', function () {
          window.glimpse.send({ type: 'set-anchor', anchor: li.dataset.anchor });
          anchorItems.forEach(function (x) { x.classList.remove('active'); });
          li.classList.add('active');
        });
      });
      document.getElementById('hide').addEventListener('click', function () {
        window.glimpse.send({ type: 'hide-hud' });
      });
      var items = document.querySelectorAll('li');
      document.addEventListener('keydown', function (e) {
        var active = document.activeElement;
        var idx = Array.prototype.indexOf.call(items, active);
        if (idx < 0) idx = 0;
        if (e.key === 'ArrowDown') {
          items[(idx + 1) % items.length].focus();
          e.preventDefault();
        } else if (e.key === 'ArrowUp') {
          items[(idx - 1 + items.length) % items.length].focus();
          e.preventDefault();
        } else if (e.key === 'Enter' && active && active.click) {
          active.click();
        }
      });
      if (items[0]) items[0].focus();
    })();
  </script>
</body>`;
}

/**
 * Create the menu-bar status item + popover. Returns a handle the daemon can
 * use to push state changes back (setAnchor) or tear it down (close).
 */
export function createStatusItem(opts: StatusItemOptions): StatusItem {
  const { initialAnchor, onAnchor, onHide } = opts;
  let currentAnchor: Anchor = initialAnchor;
  let disposed = false;
  let win: GStatusWindow | null = null;

  function attach(w: GStatusWindow): void {
    w.on("message", (...args: unknown[]) => {
      const data = args[0];
      if (!data || typeof data !== "object") return;
      const msg = data as { type?: unknown; anchor?: unknown };
      if (msg.type === "set-anchor" && isAnchor(msg.anchor)) {
        currentAnchor = msg.anchor;
        void onAnchor(msg.anchor);
      } else if (msg.type === "hide-hud") {
        void onHide();
      }
    });
  }

  function open(factory: GlimpseStatusFactory): void {
    if (disposed) return;
    const w = factory(renderPopoverHtml(currentAnchor), {
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      title: STATUS_TITLE,
    });
    attach(w);
    win = w;
  }

  if (opts.factory) {
    open(opts.factory);
  } else {
    loadStatusFactory().then(open, (err) => {
      console.error("status-item: failed to load glimpseui.statusItem:", err);
    });
  }

  return {
    setAnchor(anchor: Anchor): void {
      currentAnchor = anchor;
      if (!win) return;
      try {
        win.setHTML(renderPopoverHtml(anchor));
      } catch {
        /* ignore */
      }
    },
    close(): void {
      disposed = true;
      if (!win) return;
      try {
        win.close();
      } catch {
        /* ignore */
      }
      win = null;
    },
  };
}
