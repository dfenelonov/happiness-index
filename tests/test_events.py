import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import PROJECT_ROOT
from app.db.models import Event, Session
from app.services.events import EVENTS, log_event
from tests.flow import ITEMS, answers_for, complete_test, consent, db_rows, run_test


def events(app: FastAPI) -> list[Event]:
    return sorted(db_rows(app, Event), key=lambda e: e.id)


def names(app: FastAPI) -> list[str]:
    return [e.name for e in events(app)]


def test_registry_matches_analytics_doc() -> None:
    doc = (PROJECT_ROOT / "docs" / "ANALYTICS.md").read_text(encoding="utf-8")
    documented = set(re.findall(r"^\| `(\w+)` \|", doc, flags=re.MULTILINE))
    assert documented == set(EVENTS)


def test_full_funnel_events(client: TestClient, app: FastAPI) -> None:
    client.get("/?utm_source=vk&utm_medium=cpc&ref=abcdef123")
    client.post("/consent", data={"agree": "yes"})
    client.get("/test")
    client.get("/test")  # перезагрузка первого вопроса
    run_test(client, answers_for())
    location = client.get("/test").headers["location"]
    client.get(location)

    evs = events(app)
    assert [e.name for e in evs[:3]] == ["landing_view", "consent_given", "test_start"]
    assert evs[0].props == {"utm_source": "vk", "utm_medium": "cpc", "ref": "abcdef123"}
    assert evs[1].props == {"version": app.state.app_config.consent.version}
    assert names(app).count("test_start") == 1

    answered = [e.props for e in evs if e.name == "question_answered"]
    assert answered == [{"index": n, "block": b.id} for n, (b, _) in enumerate(ITEMS, 1)]

    [complete] = [e for e in evs if e.name == "test_complete"]
    assert complete.props == {"archetype_id": "steady_anchor"}
    assert evs[-1].name == "result_view" and evs[-1].props == {"mode": "owner"}
    assert len({e.session_id for e in evs}) == 1


def test_test_start_logged_once_after_back(client: TestClient, app: FastAPI) -> None:
    consent(client)
    client.get("/test")
    client.post("/api/answers", data={"item_id": "vciom_1", "value": "rather_yes"})
    client.post("/api/answers", data={"item_id": "swls_1", "action": "back"})
    assert names(app).count("test_start") == 1


def test_no_answer_values_in_any_event(client: TestClient, app: FastAPI) -> None:
    complete_test(client)
    for event in events(app):
        assert "value" not in event.props
        if event.name == "question_answered":
            assert set(event.props) == {"index", "block"}


def test_result_view_modes(client: TestClient, app: FastAPI) -> None:
    location = complete_test(client)
    client.get(location)
    with TestClient(app) as guest:
        guest.get(location)
    modes = [e.props["mode"] for e in events(app) if e.name == "result_view"]
    assert modes == ["owner", "guest"]


@pytest.mark.parametrize(
    ("payload", "props"),
    [
        ({"name": "share_click", "props": {"channel": "vk"}}, {"channel": "vk"}),
        ({"name": "share_click", "props": {"channel": "card"}}, {"channel": "card"}),
    ],
)
def test_client_event_accepted(client: TestClient, app: FastAPI, payload, props) -> None:
    client.get("/")
    r = client.post("/api/events", json=payload)
    assert r.status_code == 204
    assert events(app)[-1].name == payload["name"] and events(app)[-1].props == props


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "test_complete", "props": {}},  # серверное событие нельзя подделать
        {"name": "payment_success", "props": {"price": 990}},
        {"name": "share_click", "props": {"channel": "email"}},
        {"name": "share_click", "props": {"channel": "vk", "email": "a@b.c"}},
        {"name": "share_click"},
        {"name": "support_link_click", "props": {"contact_id": "x"}},  # удалённое событие
        {"name": "share_click", "props": ["vk"]},
        {"props": {"channel": "vk"}},
        ["share_click"],
    ],
)
def test_client_event_rejected(client: TestClient, app: FastAPI, payload) -> None:
    client.get("/")
    before = len(events(app))
    assert client.post("/api/events", json=payload).status_code == 400
    assert len(events(app)) == before


def test_client_event_bad_json(client: TestClient) -> None:
    r = client.post("/api/events", content=b"{", headers={"Content-Type": "application/json"})
    assert r.status_code == 400


def test_client_event_without_session_ignored(client: TestClient, app: FastAPI) -> None:
    r = client.post("/api/events", json={"name": "share_click", "props": {"channel": "tg"}})
    assert r.status_code == 204 and events(app) == []


def test_log_event_rejects_unknown_props(app: FastAPI, client: TestClient) -> None:
    client.get("/")
    [session] = db_rows(app, Session)
    with app.state.session_factory() as db, pytest.raises(ValueError, match="email"):
        log_event(db, session, "share_click", channel="vk", email="x@y.z")


def test_registry_has_no_personal_data_keys() -> None:
    forbidden = {"email", "phone", "name", "value", "answer", "answers", "ip"}
    for name, keys in EVENTS.items():
        assert not keys & forbidden, name
