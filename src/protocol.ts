export type ReqFrame = {
  kind: "req";
  id: string;
  method: string;
  params: unknown;
};

export type ResFrame = {
  kind: "res";
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
};

export type EvtFrame = {
  kind: "evt";
  topic: string;
  payload: unknown;
};

export type Frame = ReqFrame | ResFrame | EvtFrame;

export function encode(frame: Frame): string {
  return JSON.stringify(frame) + "\n";
}

export class LineDecoder {
  private buffer = "";

  push(chunk: string | Buffer): Frame[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const frames: Frame[] = [];
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      frames.push(JSON.parse(line) as Frame);
    }
    return frames;
  }
}
