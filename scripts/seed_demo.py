"""Демо-данные для /admin: синтетическая воронка — сессии, события, результаты, заказы, отчёты.

    uv run python scripts/seed_demo.py --sessions 4000 --seed 42

Только для локальной БД: в APP_ENV=production не запускается. Вероятности ниже — выдуманные
параметры симуляции для проверки дашборда, а не прогноз.
"""

import argparse
import random
import secrets
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import insert

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db.models import Event, Lead, Order, Report, Result, Session

UTM = {"vk": 0.35, "tg": 0.25, "yandex": 0.15, None: 0.15, "share": 0.10}
P_START, HAZARD_PER_QUESTION, P_SHARE = 0.72, 0.012, 0.09
P_PAYWALL_VIEW, CONVERSION = 0.85, {490: 0.04, 690: 0.03, 990: 0.02}
P_REFUND, P_FAKEDOOR, P_EMAIL, P_INTERNAL = 0.03, 0.07, 0.5, 0.05
REPORT_STATUS = {"ready": 0.92, "fallback": 0.03, "regenerated": 0.04, "failed": 0.01}


def pick(rng: random.Random, weights: dict):
    return rng.choices(list(weights), weights=list(weights.values()))[0]


def seed(app, sessions: int, rng: random.Random) -> dict[str, int]:
    q = app.state.questionnaire
    cfg = app.state.app_config
    cipher = app.state.email_cipher
    items = [(b.id, i.id) for b in q.blocks for i in b.items]
    archetypes = [e.id for e in q.scoring.archetype.table]
    domains = list(q.scoring.domains.tie_break_order)
    vciom = [o.id for o in q.scales["vciom5"].options or []]
    now = datetime.now(UTC)
    rows: dict[str, list[dict]] = {
        k: [] for k in ("sessions", "events", "results", "orders", "reports", "leads")
    }

    def event(sid, name, at, **props):
        rows["events"].append({"session_id": sid, "name": name, "props": props, "created_at": at})

    for n in range(sessions):
        sid = uuid.uuid4()
        at = now - timedelta(days=rng.uniform(0, 14))
        utm = pick(rng, UTM)
        session = {
            "id": sid,
            "sid_hash": secrets.token_hex(32),
            "created_at": at,
            "utm_source": utm,
            "utm_medium": "cpc" if utm in ("vk", "yandex") else None,
            "ref_public_id": secrets.token_urlsafe(9) if utm == "share" else None,
            "is_internal": rng.random() < P_INTERNAL,
            "price_variant": None,
        }
        rows["sessions"].append(session)
        event(sid, "landing_view", at, utm_source=utm)
        if rng.random() > P_START:
            continue
        event(sid, "consent_given", at, version=cfg.consent.version)
        event(sid, "test_start", at)
        answered = 0
        for index, (block, _) in enumerate(items, 1):
            if rng.random() < HAZARD_PER_QUESTION:
                break
            event(sid, "question_answered", at, index=index, block=block)
            answered = index
        if answered < len(items):
            continue
        archetype = rng.choice(archetypes)
        rows["results"].append(
            {
                "session_id": sid,
                "public_id": secrets.token_urlsafe(9),
                "life_raw": 20,
                "happiness_index": rng.choice(range(0, 101, 10)),
                **{f"trait_{t}": rng.choice([1.5, 2.5, 3.0, 3.5, 4.5]) for t in "eacno"},
                "archetype_id": archetype,
                "domain_scores": {d: 3.0 for d in domains},
                "leaks": rng.sample(domains, 3),
                "vciom_answer": rng.choice(vciom),
                "completed_at": at,
            }
        )
        event(sid, "test_complete", at, archetype_id=archetype)
        event(sid, "result_view", at, mode="owner")
        if rng.random() < P_SHARE:
            event(sid, "share_click", at, channel=rng.choice(["vk", "tg", "copy", "card"]))
        price = rng.choice(cfg.pricing.ab_variants_rub)
        session["price_variant"] = price
        if rng.random() < P_PAYWALL_VIEW:
            event(sid, "paywall_view", at, price=price)
        conversion = CONVERSION.get(price, 0.03)
        if rng.random() > conversion * 1.6:
            continue
        email = f"demo{n}@example.invalid"
        order = {
            "id": uuid.uuid4(),
            "session_id": sid,
            "amount_rub": price,
            "status": "canceled",
            "email_encrypted": cipher.encrypt(email),
            "email_hash": cipher.hash(email),
            "created_at": at,
            "yookassa_payment_id": f"seed-{uuid.uuid4().hex}",
        }
        rows["orders"].append(order)
        event(sid, "checkout_start", at, price=price)
        if rng.random() > 1 / 1.6:
            continue
        order |= {"status": "succeeded", "paid_at": at}
        event(sid, "payment_success", at, price=price)
        status = pick(rng, REPORT_STATUS)
        rows["reports"].append(
            {
                "order_id": order["id"],
                "token": secrets.token_urlsafe(32),
                "status": "ready" if status == "regenerated" else status,
                "regenerated_at": at if status == "regenerated" else None,
                "created_at": at,
                "provider": "seed",
                "model": "seed",
            }
        )
        if rng.random() < P_REFUND:
            order |= {"status": "refunded", "refunded_at": at}
            event(sid, "payment_refund", at, price=price)
        if rng.random() < P_FAKEDOOR:
            event(sid, "sub_fakedoor_click", at)
            if rng.random() < P_EMAIL:
                event(sid, "sub_email_submit", at)
                rows["leads"].append(
                    {
                        "id": uuid.uuid4(),
                        "email_encrypted": cipher.encrypt(email),
                        "email_hash": cipher.hash(email),
                        "source": "sub_fakedoor",
                        "session_id": sid,
                        "consent_at": at,
                    }
                )

    with app.state.session_factory() as db:
        for model, key in (
            (Session, "sessions"),
            (Event, "events"),
            (Result, "results"),
            (Order, "orders"),
            (Report, "reports"),
            (Lead, "leads"),
        ):
            if rows[key]:
                db.execute(insert(model), rows[key])
        db.commit()
    return {k: len(v) for k, v in rows.items()}


def main(argv: list[str] | None = None) -> dict[str, int]:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--sessions", type=int, default=4000)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    from app.main import create_app

    app = create_app()
    if app.state.settings.is_production:
        sys.exit("seed_demo: в production не запускается")
    counts = seed(app, args.sessions, random.Random(args.seed))
    print("добавлено:", ", ".join(f"{k}={v}" for k, v in counts.items()))
    return counts


if __name__ == "__main__":
    main()
