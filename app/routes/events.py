from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.db.session import Db
from app.services.events import log_event, validate_client_event
from app.services.orders import price_for
from app.services.rate_limit import rate_limit
from app.services.results import result_of
from app.services.sessions import get_session

router = APIRouter()


@router.post("/api/events", status_code=204, dependencies=[Depends(rate_limit("events"))])
async def client_event(request: Request, db: Db) -> Response:
    try:
        payload = await request.json()
        name = payload["name"]
        props = validate_client_event(name, payload.get("props", {}))
    except (ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(400, "Недопустимое событие") from None
    # Без сессии (бот, запрет cookie) событие не к чему привязать — молча пропускаем.
    session = get_session(db, request, request.app.state.settings)
    if session is None:
        return Response(status_code=204)
    if name == "paywall_view":
        if result_of(db, session) is None:  # без результата пейволла нет — событие ложное
            return Response(status_code=204)
        variants = request.app.state.app_config.pricing.ab_variants_rub
        props = {"price": price_for(db, session, variants)}
    log_event(db, session, name, **props)
    return Response(status_code=204)
