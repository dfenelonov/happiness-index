import csv
import itertools
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import ConfigError, check_production_readiness, load_configs
from app.db.models import Event, Order, Report, Result
from app.services import llm
from app.services.llm import (
    GigaChatProvider,
    LLMError,
    MockLLMProvider,
    YandexGPTProvider,
    make_llm_provider,
)
from app.services.mailer import OutboxMailer
from app.services.report_fallback import build_fallback
from app.services.reports import (
    ReportInvalid,
    build_input,
    compile_forbidden,
    domain_names,
    find_forbidden,
    generate,
    parse_content,
)
from tests.conftest import PROD_PROVIDER, REAL_CONFIG_DIR, SAFE_SECRETS, make_settings
from tests.flow import Q, complete_test, db_rows

CONFIGS = load_configs(REAL_CONFIG_DIR)
PROMPT, REPORT_CFG = CONFIGS.report_prompt, CONFIGS.app.report
NAMES = domain_names(Q)
DATA = {
    "happiness_index": 23,
    "vciom_answer": "скорее нет",
    "traits": {"E": 4.5, "A": 3.5, "C": 3.0, "N": 2.0, "O": 4.5},
    "archetype": {"id": "pathfinder", "name": "Первооткрыватель"},
    "domains": {"sleep": 2.0, "relationships": 4.5, "work": 3.0, "money": 2.5, "meaning": 4.0},
    "leaks": ["sleep", "money", "work"],
}
VALID = json.dumps(build_fallback(DATA, NAMES), ensure_ascii=False)
EMAIL = "buyer@example.ru"


def service(app: FastAPI):
    return app.state.report_service


def pay(client: TestClient, app: FastAPI, **test_kwargs) -> Order:
    """Тест → checkout → оплата в моке ЮKassa → вебхук."""
    complete_test(client, **test_kwargs)
    client.post("/checkout", data={"email": EMAIL, "agree_offer": "yes"})
    [order] = db_rows(app, Order)
    app.state.payment_gateway.set_status(order.yookassa_payment_id, "succeeded")
    client.post(
        "/webhooks/yookassa",
        json={"event": "payment.succeeded", "object": {"id": order.yookassa_payment_id}},
    )
    return order


def report_of(app: FastAPI) -> Report:
    [report] = db_rows(app, Report)
    return report


# --- Вход в LLM: только агрегаты ----------------------------------------------------------------


def test_input_is_aggregates_only(client: TestClient, app: FastAPI) -> None:
    complete_test(client)
    [result] = db_rows(app, Result)
    data = build_input(Q, result)
    assert set(data) == {
        "happiness_index",
        "vciom_answer",
        "traits",
        "archetype",
        "domains",
        "leaks",
    }
    assert data["vciom_answer"] == "скорее да" and set(data["traits"]) == set("EACNO")
    assert data["leaks"] == result.leaks


def test_prompt_has_no_email_or_ids(client: TestClient, app: FastAPI) -> None:
    order = pay(client, app)
    [result] = db_rows(app, Result)
    [(system, user)] = service(app).provider.calls
    prompt = system + user
    for secret in (
        EMAIL,
        "buyer",
        str(order.id),
        str(result.session_id),
        result.public_id,
        client.cookies["sid"],
    ):
        assert secret.lower() not in prompt.lower(), secret
    assert json.dumps(build_input(Q, result), ensure_ascii=False) in user


# --- Разбор ответа -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "wrap", [lambda t: t, lambda t: f"```json\n{t}\n```", lambda t: f"Вот отчёт:\n{t}\nГотово."]
)
def test_parse_tolerates_wrapping(wrap) -> None:
    assert parse_content(wrap(VALID), DATA)["leaks"][0]["domain"] == "sleep"


def _mutated(**changes) -> str:
    content = json.loads(VALID)
    for key, value in changes.items():
        if value is None:
            del content[key]
        else:
            content[key] = value
    return json.dumps(content, ensure_ascii=False)


@pytest.mark.parametrize(
    "text",
    [
        "не JSON",
        "{ сломанный",
        _mutated(summary=None),
        _mutated(extra="поле"),
        _mutated(summary="коротко"),
        _mutated(strengths_to_use=["одна сильная сторона"]),
        _mutated(leaks=list(reversed(json.loads(VALID)["leaks"]))),
        _mutated(plan_30_days=json.loads(VALID)["plan_30_days"][:3]),
        _mutated(plan_30_days=[{**w, "week": 1} for w in json.loads(VALID)["plan_30_days"]]),
        _mutated(
            leaks=[{**leak, "actions": leak["actions"][:2]} for leak in json.loads(VALID)["leaks"]]
        ),
    ],
)
def test_parse_rejects_invalid(text: str) -> None:
    with pytest.raises(ReportInvalid):
        parse_content(text, DATA)


PATTERNS = compile_forbidden(PROMPT)


@pytest.mark.parametrize(
    ("text", "category"),
    [
        ("Похоже на депрессию", "diagnosis"),
        ("тревожное расстройство", "diagnosis"),
        ("поставим диагноз", "diagnosis"),
        ("признаки ПТСР", "diagnosis"),
        ("попробуй антидепрессанты", "medication"),
        ("выпей таблетку", "medication"),
        ("как тип INTJ", "mbti"),
        ("по MBTI", "mbti"),
        ("тест Майерс-Бриггс", "mbti"),
        ("из-за войны", "politics"),
        ("СВО влияет", "politics"),
        ("санкции давят", "politics"),
        ("экономика страны", "politics"),
        ("гарантируем результат", "promises"),
        ("на 100% счастлив", "promises"),
        ("избавишься навсегда", "promises"),
        ("изменит твою жизнь за неделю", "promises"),
    ],
)
def test_forbidden_detected(text: str, category: str) -> None:
    hits = find_forbidden({"summary": text}, PATTERNS)
    assert hits and hits[0].startswith(category), hits


@pytest.mark.parametrize(
    "text",
    [
        "двойная польза",
        "спокойный вечер",
        "своё время",
        "intj в нижнем регистре — просто буквы",
        "разговор со специалистом может помочь",
        "тревога за деньги",
        "экономия на кофе",
    ],
)
def test_forbidden_no_false_positives(text: str) -> None:
    assert find_forbidden({"summary": text}, PATTERNS) == []


def test_fallback_valid_and_clean_for_all_combinations() -> None:
    for entry, leaks, index in itertools.product(
        Q.scoring.archetype.table, itertools.permutations(NAMES, 3), (5, 90)
    ):
        data = DATA | {
            "happiness_index": index,
            "archetype": {"id": entry.id, "name": entry.name},
            "leaks": list(leaks),
        }
        content = build_fallback(data, NAMES)
        parse_content(json.dumps(content, ensure_ascii=False), data)
        assert find_forbidden(content, PATTERNS) == []
        assert ("специалист" in content["summary"]) is (index < REPORT_CFG.low_index_threshold)


# --- Генерация: ретраи, fallback, дедлайн --------------------------------------------------------


def test_retry_after_invalid_then_ready() -> None:
    provider = MockLLMProvider(["мусор", VALID])
    gen = generate(provider, PROMPT, REPORT_CFG, Q, DATA)
    assert gen.status == "ready" and len(gen.attempts) == 2 and not gen.attempts[0].ok
    assert gen.tokens_in > 0 and gen.tokens_out > 0


def test_forbidden_answer_is_retried() -> None:
    bad = json.loads(VALID)
    bad["summary"] += " Возможно, это депрессия."
    gen = generate(
        MockLLMProvider([json.dumps(bad, ensure_ascii=False), VALID]), PROMPT, REPORT_CFG, Q, DATA
    )
    assert gen.status == "ready" and gen.attempts[0].forbidden == ["diagnosis: депрессия"]


def test_three_failures_give_fallback() -> None:
    provider = MockLLMProvider([LLMError("таймаут"), "мусор", LLMError("HTTP 500"), VALID])
    gen = generate(provider, PROMPT, REPORT_CFG, Q, DATA)
    assert gen.status == "fallback" and len(gen.attempts) == REPORT_CFG.max_attempts
    assert gen.content == build_fallback(DATA, NAMES, REPORT_CFG.low_index_threshold)
    assert provider.script == [VALID]  # четвёртой попытки не было


def test_deadline_stops_retries() -> None:
    ticks = iter([0.0, 0.0, 30.0, 54.5, 54.5])
    gen = generate(
        MockLLMProvider(["мусор", "мусор", VALID]),
        PROMPT,
        REPORT_CFG,
        Q,
        DATA,
        clock=lambda: next(ticks),
    )
    assert gen.status == "fallback" and gen.attempts[-1].error == "дедлайн"


def test_attempt_timeout_respects_deadline() -> None:
    seen = []

    class Recorder(MockLLMProvider):
        def complete(self, system, user, **kw):
            seen.append(kw["timeout"])
            return super().complete(system, user, **kw)

    ticks = iter([0.0, 45.0, 45.0])
    generate(Recorder(), PROMPT, REPORT_CFG, Q, DATA, clock=lambda: next(ticks))
    assert seen == [10.0]  # осталось 10 с из 55 — меньше, чем 25 на попытку


@pytest.mark.parametrize(
    ("model", "usd_rub", "vat", "expected"),
    [
        ("GigaChat-Pro", None, None, 1.5),  # 3000 токенов × 0,5 ₽, НДС уже в цене
        ("GigaChat-Max", None, None, 1.95),
        ("GigaChat", None, None, 0.195),  # Lite
        ("yandexgpt", 100.0, 0.2, 3 * 0.0066 * 100 * 1.2),  # $ без НДС → ₽ с НДС
        ("yandexgpt", None, 0.2, None),  # нет курса
        ("yandexgpt", 100.0, None, None),  # нет НДС
        ("unknown-model", 100.0, 0.2, None),
    ],
)
def test_token_cost(model, usd_rub, vat, expected) -> None:
    pricing = REPORT_CFG.token_pricing.model_copy(update={"usd_rub": usd_rub, "vat_rate": vat})
    cost = pricing.cost_rub(model, 1000, 2000)
    assert cost == (None if expected is None else pytest.approx(expected))


def test_reference_prices_from_owner() -> None:
    pricing = REPORT_CFG.token_pricing
    assert (pricing.usd_rub, pricing.vat_rate) == (80.87, 0.22)
    assert {m: p.input for m, p in pricing.prices.items()} == {
        "yandexgpt": 0.0066,
        "GigaChat": 0.065,
        "GigaChat-Pro": 0.5,
        "GigaChat-Max": 0.65,
    }
    assert REPORT_CFG.models["gigachat"].model == "GigaChat-Pro"  # по умолчанию Pro
    # YandexGPT: 1000 + 1000 токенов × $0,0066 × 80,87 ₽ × 1,22 (НДС)
    assert REPORT_CFG.cost_rub("yandexgpt", 1000, 1000) == pytest.approx(2 * 0.0066 * 80.87 * 1.22)
    assert REPORT_CFG.cost_rub("gigachat", 1000, 1000) == pytest.approx(1.0)
    assert REPORT_CFG.cost_rub("mock", 1000, 1000) is None


def test_yandex_model_uri_uses_version() -> None:
    model = REPORT_CFG.models["yandexgpt"]
    assert model.uri_path == f"yandexgpt/{model.version}"
    assert model.model_copy(update={"version": "latest"}).is_pinned is False
    assert model.model_copy(update={"version": "rc"}).is_pinned is False
    assert model.model_copy(update={"version": "some-pinned-id"}).is_pinned is True


def test_model_without_price_rejected(config_dir) -> None:
    from tests.conftest import edit_yaml

    edit_yaml(
        config_dir / "app.yaml",
        lambda d: d["report"]["models"]["gigachat"].update(model="GigaChat-Ultra"),
    )
    with pytest.raises(ConfigError, match="нет цены"):
        load_configs(config_dir)


# --- HTTP-адаптеры провайдеров (без сети) --------------------------------------------------------


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_yandexgpt_request_and_response() -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["headers"] = str(request.url), request.headers
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "result": {
                    "alternatives": [{"message": {"role": "assistant", "text": VALID}}],
                    "usage": {
                        "inputTextTokens": "700",
                        "completionTokens": "900",
                        "totalTokens": "1600",
                    },
                    "modelVersion": "23.10.2024",
                }
            },
        )

    provider = YandexGPTProvider("api-key", "folder", "yandexgpt/latest", _client(handler))
    response = provider.complete("сис", "юзер", temperature=0.5, max_tokens=3000, timeout=10)
    assert seen["url"] == llm.YANDEXGPT_URL
    assert seen["headers"]["authorization"] == "Api-Key api-key"
    assert seen["headers"]["x-folder-id"] == "folder"
    assert seen["body"]["modelUri"] == "gpt://folder/yandexgpt/latest"
    assert seen["body"]["messages"] == [
        {"role": "system", "text": "сис"},
        {"role": "user", "text": "юзер"},
    ]
    assert seen["body"]["completionOptions"] == {
        "stream": False,
        "temperature": 0.5,
        "maxTokens": "3000",
    }
    assert (response.text, response.tokens_in, response.tokens_out) == (VALID, 700, 900)


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: httpx.Response(500, json={}),
        lambda r: httpx.Response(200, json={"unexpected": True}),
        lambda r: httpx.Response(200, content=b"not json"),
        lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow", request=r)),
    ],
    ids=["http500", "format", "not_json", "timeout"],
)
def test_yandexgpt_errors(handler) -> None:
    provider = YandexGPTProvider("k", "f", "m", _client(handler))
    with pytest.raises(LLMError):
        provider.complete("s", "u", temperature=0.5, max_tokens=10, timeout=1)


def test_gigachat_oauth_cached_and_refreshed() -> None:
    calls = []
    now = [1_000.0]

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if str(request.url) == llm.GIGACHAT_OAUTH_URL:
            assert request.headers["authorization"] == "Basic auth-key"
            assert b"scope=GIGACHAT_API_PERS" in request.content
            return httpx.Response(
                200,
                json={
                    "access_token": f"tok{len(calls)}",
                    "expires_at": int((now[0] + 1800) * 1000),
                },
            )
        assert request.headers["authorization"].startswith("Bearer tok")
        body = json.loads(request.content)
        assert body["model"] == "GigaChat" and body["messages"][0]["role"] == "system"
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": VALID}}],
                "usage": {"prompt_tokens": 650, "completion_tokens": 880},
                "model": "GigaChat:1.0",
            },
        )

    provider = GigaChatProvider(
        "auth-key", "GIGACHAT_API_PERS", "GigaChat", _client(handler), clock=lambda: now[0]
    )
    kw = {"temperature": 0.5, "max_tokens": 100, "timeout": 5}
    first = provider.complete("s", "u", **kw)
    provider.complete("s", "u", **kw)
    assert calls.count(llm.GIGACHAT_OAUTH_URL) == 1  # токен переиспользован
    now[0] += 1800  # токен истёк
    provider.complete("s", "u", **kw)
    assert calls.count(llm.GIGACHAT_OAUTH_URL) == 2
    assert (first.tokens_in, first.tokens_out, first.model) == (650, 880, "GigaChat:1.0")


def test_gigachat_oauth_failure() -> None:
    provider = GigaChatProvider("k", "s", "GigaChat", _client(lambda r: httpx.Response(401)))
    with pytest.raises(LLMError, match="oauth"):
        provider.complete("s", "u", temperature=0.5, max_tokens=10, timeout=1)


def test_provider_selection(tmp_path: Path) -> None:
    def make(**kw):
        return make_llm_provider(make_settings(tmp_path, **kw), REPORT_CFG)

    assert isinstance(make(llm_provider="mock"), MockLLMProvider)
    assert isinstance(make(llm_provider="yandexgpt"), MockLLMProvider)  # ключей нет → мок
    assert isinstance(
        make(llm_provider="yandexgpt", yandexgpt_api_key="k", yandexgpt_folder_id="f"),
        YandexGPTProvider,
    )
    assert isinstance(make(llm_provider="gigachat", gigachat_auth_key="k"), GigaChatProvider)


def test_production_refuses_mock_llm_and_missing_gigachat_key(
    tmp_path: Path, filled_config_dir
) -> None:
    base = SAFE_SECRETS | {
        "app_env": "production",
        "config_dir": filled_config_dir,
        "templates_dir": tmp_path / "t",
    }
    with pytest.raises(ConfigError, match="LLM_PROVIDER"):
        check_production_readiness(make_settings(tmp_path, **base | {"llm_provider": "mock"}))
    with pytest.raises(ConfigError, match="GIGACHAT_AUTH_KEY"):
        check_production_readiness(make_settings(tmp_path, **base | {"llm_provider": "gigachat"}))
    check_production_readiness(make_settings(tmp_path, **base | PROD_PROVIDER))


def test_production_refuses_floating_yandex_version_and_http(tmp_path: Path, config_dir) -> None:
    from tests.conftest import edit_yaml

    base = (
        SAFE_SECRETS
        | PROD_PROVIDER
        | {"app_env": "production", "config_dir": config_dir, "templates_dir": tmp_path / "t"}
    )
    with pytest.raises(ConfigError, match="плавающая версия «latest»"):
        check_production_readiness(make_settings(tmp_path, **base))
    edit_yaml(
        config_dir / "app.yaml",
        lambda d: d["report"]["models"]["yandexgpt"].update(version="5.1-pinned"),
    )
    with pytest.raises(ConfigError, match="APP_BASE_URL"):
        check_production_readiness(
            make_settings(tmp_path, **base | {"app_base_url": "http://x.ru"})
        )


def test_eval_model_override(tmp_path: Path) -> None:
    from scripts.eval_reports import main, with_model

    lite = with_model(REPORT_CFG, "gigachat", "GigaChat")
    assert (
        lite.models["gigachat"].model == "GigaChat"
        and REPORT_CFG.models["gigachat"].model == "GigaChat-Pro"
    )
    assert lite.cost_rub("gigachat", 1000, 1000) == pytest.approx(0.13)
    with pytest.raises(SystemExit):
        with_model(REPORT_CFG, "mock", "GigaChat")
    out = main(["--provider", "mock", "--only", "p01", "--out", str(tmp_path)])
    assert out.name.endswith("-mock")


# --- Путь в приложении: оплата → отчёт → письмо → PDF --------------------------------------------


def test_paid_order_gets_report_and_one_email(client: TestClient, app: FastAPI) -> None:
    order = pay(client, app)
    for _ in range(2):  # повтор вебхука
        client.post(
            "/webhooks/yookassa",
            json={"event": "payment.succeeded", "object": {"id": order.yookassa_payment_id}},
        )
    report = report_of(app)
    assert report.status == "ready" and report.provider == "mock" and report.attempts == 1
    assert report.tokens_in > 0 and report.generated_at and report.email_sent_at
    assert len(report.token) >= 32
    outbox = service(app).mailer.outbox
    assert len(outbox) == 1 and outbox[0].to == EMAIL
    assert f"http://localhost:8000/report/{report.token}" in outbox[0].text


def test_return_page_redirects_to_report_and_page_renders(client: TestClient, app: FastAPI) -> None:
    pay(client, app)
    report = report_of(app)
    location = client.get("/checkout/return").headers["location"]
    assert location == f"/report/{report.token}"
    html = client.get(location).text
    for part in (
        "Твой тип подробно",
        "Три утечки счастья",
        "План на 30 дней",
        "Неделя 4",
        "Сон и энергия",
        "Скачать PDF",
        "[Мок LLM]",
    ):
        assert part in html, part
    [event] = [e for e in db_rows(app, Event) if e.name == "report_view"]
    assert event.props == {"status": "ready"}


def test_report_pdf(client: TestClient, app: FastAPI) -> None:
    pay(client, app)
    r = client.get(f"/report/{report_of(app).token}.pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF") and len(r.content) > 5000


def test_llm_down_gives_fallback_then_regenerated(client: TestClient, app: FastAPI) -> None:
    service(app).provider = MockLLMProvider([LLMError("недоступен")] * 3)
    pay(client, app)
    report = report_of(app)
    assert report.status == "fallback" and report.attempts == 3
    html = client.get(f"/report/{report.token}").text
    assert "Три утечки счастья" in html and "[Мок LLM]" not in html
    assert [e.props for e in db_rows(app, Event) if e.name == "report_view"] == [
        {"status": "fallback"}
    ]

    from scripts.regenerate_reports import regenerate_all

    service(app).provider = MockLLMProvider()
    assert regenerate_all(service(app)) == (1, 1)
    report = report_of(app)
    assert report.status == "ready" and report.regenerated_at is not None
    _link_mail, ready_mail = service(app).mailer.outbox
    assert ready_mail.subject == "Твой персональный отчёт готов" and ready_mail.to == EMAIL
    assert f"/report/{report.token}" in ready_mail.text
    assert regenerate_all(service(app)) == (0, 0)  # повторный запуск — писем больше нет
    assert len(service(app).mailer.outbox) == 2


def test_pending_and_failed_pages(client: TestClient, app: FastAPI) -> None:
    class Boom(MockLLMProvider):
        def complete(self, *a, **kw):
            raise RuntimeError("неожиданная ошибка")

    service(app).provider = Boom()
    pay(client, app)
    report = report_of(app)
    assert report.status == "failed"
    assert "Отчёт задерживается" in client.get(f"/report/{report.token}").text
    assert client.get(f"/report/{report.token}.pdf").status_code == 404

    with app.state.session_factory() as db:
        db.get(Report, report.order_id).status = "pending"
        db.commit()
    html = client.get(f"/report/{report.token}").text
    assert "Готовим твой отчёт" in html and 'http-equiv="refresh"' in html


def test_recover_pending_after_restart(client: TestClient, app: FastAPI) -> None:
    pay(client, app)
    with app.state.session_factory() as db:
        report = db.get(Report, report_of(app).order_id)
        report.status, report.content_json = "pending", None
        db.commit()
    service(app).recover_pending()
    assert report_of(app).status == "ready"
    assert len(service(app).mailer.outbox) == 1  # письмо уже было — повторно не шлём


def test_email_failure_does_not_block_report(client: TestClient, app: FastAPI) -> None:
    class Broken(OutboxMailer):
        def send(self, mail):
            raise OSError("smtp down")

    service(app).mailer = Broken()
    pay(client, app)
    report = report_of(app)
    assert report.status == "ready" and report.email_sent_at is None


def test_unknown_report_404(client: TestClient) -> None:
    assert client.get("/report/nope").status_code == 404
    assert client.get("/report/nope.pdf").status_code == 404


# --- Скрипт оценки -------------------------------------------------------------------------------


def _read_csv(out: Path) -> list[dict[str, str]]:
    with (out / "results.csv").open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def test_eval_script_with_mock(tmp_path: Path) -> None:
    from scripts.eval_reports import main

    out = main(["--provider", "mock", "--out", str(tmp_path)])
    rows = _read_csv(out)
    assert len(rows) == 20 and len({r["archetype"] for r in rows}) == 8
    assert {r["low_index"] for r in rows} == {"да", "нет"}
    assert all(r["status"] == "ready" for r in rows)
    assert len(list((out / "reports").glob("*.json"))) == 20
    assert "8 из 8" in (out / "summary.md").read_text(encoding="utf-8")


def test_eval_script_reports_failures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from scripts import eval_reports

    bad = json.loads(VALID)
    bad["summary"] += " По MBTI ты INTJ, гарантируем результат."
    bad_text = json.dumps(bad, ensure_ascii=False)
    provider = MockLLMProvider([bad_text, "не JSON", LLMError("таймаут")] + [bad_text] * 3)
    monkeypatch.setattr(eval_reports, "make_llm_provider", lambda *a: provider)
    out = eval_reports.main(["--only", "p01,p02", "--out", str(tmp_path)])
    rows = _read_csv(out)
    assert [r["status"] for r in rows] == ["fallback", "fallback"]
    assert "mbti: MBTI" in rows[0]["forbidden_hits"] and "promises" in rows[0]["forbidden_hits"]
    assert "нет JSON" in rows[0]["attempt_errors"] and "llm: таймаут" in rows[0]["attempt_errors"]
    summary = (out / "summary.md").read_text(encoding="utf-8")
    assert "fallback: **2/2**" in summary and "mbti:" in summary
