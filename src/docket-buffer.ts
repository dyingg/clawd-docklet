export type ClientId = string;

export type EditParams = {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export type EditResultOk = { ok: true; version: number };
export type EditResultErr = {
  ok: false;
  code: "MustReadFirst" | "StaleRead" | "NoMatch" | "Ambiguous" | "NoOp";
  message: string;
};
export type EditResult = EditResultOk | EditResultErr;

export interface DocketBufferOptions {
  initialHtml?: string;
  onChange?: (html: string) => void | Promise<void>;
}

export interface DocketBuffer {
  getVersion(): number;
  read(clientId: ClientId): { html: string; version: number };
  write(html: string): number;
  hide(): number;
  edit(clientId: ClientId, params: EditParams): EditResult;
  forgetClient(clientId: ClientId): void;
}

export function createDocketBuffer(opts: DocketBufferOptions = {}): DocketBuffer {
  let html = opts.initialHtml ?? "";
  let version = 0;
  const lastRead = new Map<ClientId, number>();
  const onChange = opts.onChange;

  function fireOnChange(next: string): void {
    if (!onChange) return;
    // Never let a handler error propagate into the buffer's API surface.
    Promise.resolve()
      .then(() => onChange(next))
      .catch(() => { /* swallow — HUD errors are logged at the daemon level */ });
  }

  return {
    getVersion() {
      return version;
    },

    read(clientId) {
      lastRead.set(clientId, version);
      return { html, version };
    },

    write(next) {
      html = next;
      version += 1;
      fireOnChange(html);
      return version;
    },

    hide() {
      html = "";
      version += 1;
      fireOnChange(html);
      return version;
    },

    edit(clientId, params) {
      const seen = lastRead.get(clientId);
      if (seen === undefined) {
        return {
          ok: false,
          code: "MustReadFirst",
          message: "Call read_docket before edit_docket.",
        };
      }
      if (seen < version) {
        return {
          ok: false,
          code: "StaleRead",
          message: "Docket was modified since your last read. Call read_docket again and retry.",
        };
      }

      const { old_string, new_string, replace_all = false } = params;

      if (old_string === new_string) {
        return {
          ok: false,
          code: "NoOp",
          message: "new_string must differ from old_string.",
        };
      }

      const firstIndex = html.indexOf(old_string);
      if (firstIndex === -1) {
        return {
          ok: false,
          code: "NoMatch",
          message: "old_string not found in current docket.",
        };
      }

      // Count occurrences only when we need uniqueness, but always when
      // replace_all is false so the error surfaces the actual count.
      const occurrences = countOccurrences(html, old_string);
      if (!replace_all && occurrences > 1) {
        return {
          ok: false,
          code: "Ambiguous",
          message: `old_string matches ${occurrences} times; expand context to make it unique or pass replace_all: true.`,
        };
      }

      html = replace_all
        ? html.split(old_string).join(new_string)
        : html.slice(0, firstIndex) + new_string + html.slice(firstIndex + old_string.length);
      version += 1;
      lastRead.set(clientId, version);
      fireOnChange(html);
      return { ok: true, version };
    },

    forgetClient(clientId) {
      lastRead.delete(clientId);
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return count;
    count += 1;
    from = i + needle.length;
  }
}
