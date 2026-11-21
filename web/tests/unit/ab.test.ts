import { describe, expect, it } from "vitest";
import { resolvePriceVariant } from "@/lib/ab";

const variants = [490, 690, 990];

describe("A/B-вариант цены", () => {
  it("первый визит — случайный вариант, закрепляется в cookie", () => {
    expect(resolvePriceVariant({ variants, random: () => 0 })).toEqual({ price: 490, persist: true, source: "random" });
    expect(resolvePriceVariant({ variants, random: () => 0.5 }).price).toBe(690);
    expect(resolvePriceVariant({ variants, random: () => 0.9999 }).price).toBe(990);
  });

  it("равновероятно: на 30 000 визитов каждый вариант ≈ 1/3", () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const counts = new Map<number, number>();
    for (let i = 0; i < 30_000; i++) {
      const { price } = resolvePriceVariant({ variants, random });
      counts.set(price, (counts.get(price) ?? 0) + 1);
    }
    for (const v of variants) expect(Math.abs(counts.get(v)! / 30_000 - 1 / 3)).toBeLessThan(0.02);
  });

  it("повторный визит — вариант из cookie, без перезаписи", () => {
    expect(resolvePriceVariant({ variants, cookie: "990", random: () => 0 })).toEqual({ price: 990, persist: false, source: "cookie" });
  });

  it("?price= переопределяет cookie и закрепляется", () => {
    expect(resolvePriceVariant({ variants, cookie: "990", query: "490" })).toEqual({ price: 490, persist: true, source: "query" });
    expect(resolvePriceVariant({ variants, cookie: "490", query: "490" }).persist).toBe(false);
  });

  it.each(["100", "abc", "690.0", "-490", ""])("недопустимый ?price=%s игнорируется", (query) => {
    expect(resolvePriceVariant({ variants, cookie: "990", query }).price).toBe(990);
  });

  it("вариант из cookie, которого больше нет в конфиге, — новый случайный", () => {
    expect(resolvePriceVariant({ variants, cookie: "1290", random: () => 0 })).toEqual({ price: 490, persist: true, source: "random" });
  });
});
