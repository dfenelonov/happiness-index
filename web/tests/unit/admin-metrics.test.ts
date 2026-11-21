import { describe, expect, it } from "vitest";
import { breakdown, colorFor, funnelMetrics, questionReach, wilson, type EventRow } from "@/lib/admin-metrics";
import { appConfig } from "@/lib/config";

const T = appConfig().metrics;
const ev = (anonId: string, name: string, extra: Partial<EventRow> = {}): EventRow => ({ name, anonId, priceVariant: null, utmSource: null, props: null, ...extra });

describe("метрики /admin", () => {
  it("цвет: ≥ go — зелёный, < stop — красный, между — жёлтый, нет данных — серый", () => {
    expect(colorFor(0.6, 0.6, 0.45)).toBe("green");
    expect(colorFor(0.5, 0.6, 0.45)).toBe("yellow");
    expect(colorFor(0.44, 0.6, 0.45)).toBe("red");
    expect(colorFor(0.01, 0.05, null)).toBe("yellow");
    expect(colorFor(null, 0.6, 0.45)).toBe("gray");
  });

  it("CI Уилсона", () => {
    const [lo, hi] = wilson(50, 100)!;
    expect(lo).toBeCloseTo(0.404, 3);
    expect(hi).toBeCloseTo(0.596, 3);
    expect(wilson(0, 0)).toBeNull();
  });

  it("4 метрики считаются по посетителям, повторные события не задваивают", () => {
    const rows = [
      ...["a", "b", "c", "d"].map((a) => ev(a, "test_start")),
      ...["a", "b", "c"].map((a) => ev(a, "test_complete")),
      ev("a", "share_click"),
      ev("a", "share_click"),
      ev("a", "payment_success"),
      ev("a", "subscription_click"),
      ev("z", "share_click"), // не завершал тест — не в числителе
    ];
    const { metrics, steps } = funnelMetrics(rows, T);
    const m = Object.fromEntries(metrics.map((x) => [x.key, x]));
    expect(m.completion).toMatchObject({ num: 3, den: 4, value: 0.75, color: "green" });
    expect(m.share).toMatchObject({ num: 1, den: 3 });
    expect(m.purchase).toMatchObject({ num: 1, den: 3 });
    expect(m.subscription).toMatchObject({ num: 1, den: 1, value: 1 });
    expect(steps.find((s) => s.name === "share_click")!.visitors).toBe(2);
  });

  it("разбивка по варианту цены и UTM", () => {
    const rows = [
      ev("a", "test_complete", { priceVariant: 490, utmSource: "vk" }),
      ev("a", "payment_success", { priceVariant: 490 }),
      ev("b", "test_complete", { priceVariant: 990 }),
    ];
    const byPrice = breakdown(rows, T, "priceVariant");
    expect(byPrice.map((g) => g.group).sort()).toEqual(["490", "990"]);
    expect(byPrice.find((g) => g.group === "490")!.metrics.find((m) => m.key === "purchase")!.value).toBe(1);
    expect(breakdown(rows, T, "utmSource").map((g) => g.group).sort()).toEqual(["(прямой заход)", "vk"]);
  });

  it("доходимость по вопросам", () => {
    const rows = [
      ev("a", "test_start", { props: { test_id: "t1" } }),
      ev("b", "test_start", { props: { test_id: "t2" } }),
      ev("a", "question_answered", { props: { test_id: "t1", n: 1 } }),
      ev("a", "question_answered", { props: { test_id: "t1", n: 1 } }),
      ev("b", "question_answered", { props: { test_id: "t2", n: 1 } }),
      ev("a", "question_answered", { props: { test_id: "t1", n: 2 } }),
    ];
    const reach = questionReach(rows, 3);
    expect(reach[0]).toMatchObject({ n: 1, reached: 2, share: 1, drop: 0 });
    expect(reach[1]).toMatchObject({ n: 2, reached: 1, share: 0.5, drop: 0.5 });
    expect(reach[2]).toMatchObject({ reached: 0 });
  });
});
