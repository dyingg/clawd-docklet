import { describe, expect, test } from "vitest";
import { encode, LineDecoder, type Frame } from "../src/protocol.js";

describe("protocol", () => {
  test("encode appends newline", () => {
    const frame: Frame = { kind: "req", id: "1", method: "ping", params: null };
    expect(encode(frame)).toBe(JSON.stringify(frame) + "\n");
  });

  test("encode/decode roundtrip", () => {
    const frame: Frame = { kind: "req", id: "1", method: "ping", params: { x: 1 } };
    const dec = new LineDecoder();
    expect(dec.push(encode(frame))).toEqual([frame]);
  });

  test("decoder handles split chunks", () => {
    const dec = new LineDecoder();
    expect(dec.push('{"kind":"req","id":"1",')).toEqual([]);
    expect(dec.push('"method":"ping","params":null}\n')).toEqual([
      { kind: "req", id: "1", method: "ping", params: null },
    ]);
  });

  test("decoder yields multiple frames from one chunk", () => {
    const a: Frame = { kind: "req", id: "1", method: "a", params: null };
    const b: Frame = { kind: "res", id: "2", result: 42 };
    const dec = new LineDecoder();
    expect(dec.push(encode(a) + encode(b))).toEqual([a, b]);
  });

  test("decoder ignores empty lines", () => {
    const dec = new LineDecoder();
    expect(dec.push("\n\n")).toEqual([]);
  });
});
