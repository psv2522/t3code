import { describe, expect, it } from "vite-plus/test";

import { ditherPixels } from "./mainBackground";

function solid(width: number, height: number, value: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data.set([value, value, value, 200], index);
  }
  return data;
}

describe("ditherPixels", () => {
  it("splits a flat tone between the two nearest levels with gray grain", () => {
    const data = solid(16, 16, 128);
    ditherPixels(data, 16);

    const lows: number[] = [];
    const highs: number[] = [];
    for (let index = 0; index < data.length; index += 4) {
      expect(data[index]).toBe(data[index + 1]);
      expect(data[index]).toBe(data[index + 2]);
      expect(data[index + 3]).toBe(200);
      (data[index]! < 128 ? lows : highs).push(data[index]!);
    }
    expect(lows.length).toBe(128);
    expect(highs.length).toBe(128);
    expect(Math.min(...lows)).toBeGreaterThanOrEqual(85 - 18);
    expect(Math.max(...highs)).toBeLessThanOrEqual(170 + 18);
  });

  it("is deterministic", () => {
    const first = solid(9, 7, 60);
    const second = solid(9, 7, 60);
    ditherPixels(first, 9);
    ditherPixels(second, 9);
    expect(first).toEqual(second);
  });
});
