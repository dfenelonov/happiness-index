import { describe, expect, it } from "vitest";
import { CLIENT_EVENTS, cleanProps } from "@/lib/events";
import { rateLimited } from "@/lib/rate-limit";

describe("события", () => {
  it("свойства — только из белого списка: email и произвольный текст не проходят", () => {
    expect(
      cleanProps({
        channel: "telegram",
        email: "a@b.ru",
        n: 3,
        question_id: "life_1",
        result_id: "6a724e2f-3653-4a73-b351-b51667149410",
        text: "мой ответ",
      }),
    ).toEqual({ channel: "telegram", n: 3, question_id: "life_1", result_id: "6a724e2f-3653-4a73-b351-b51667149410" });
  });

  it("недопустимые значения отбрасываются", () => {
    expect(cleanProps({ channel: "facebook", n: -1, question_id: "Robert'); DROP", result_id: "123" })).toEqual({});
  });

  it("клиент не может прислать серверные события", () => {
    for (const e of ["test_start", "test_complete", "question_answered", "checkout_start", "payment_success", "payment_fail", "email_submit"]) {
      expect(CLIENT_EVENTS.has(e as never)).toBe(false);
    }
  });
});

describe("лимит запросов", () => {
  it("N в минуту на ключ, затем отказ; новое окно — снова можно", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rateLimited("k", 3, t)).toBe(false);
    expect(rateLimited("k", 3, t)).toBe(true);
    expect(rateLimited("other", 3, t)).toBe(false);
    expect(rateLimited("k", 3, t + 60_001)).toBe(false);
  });
});
