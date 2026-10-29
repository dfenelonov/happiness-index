from fastapi import APIRouter, HTTPException, Request, Response

from app.db.session import Db
from app.services.events import log_event, validate_client_event
from app.services.sessions import get_session

router = APIRouter()


@router.post("/api/events", status_code=204)
async def client_event(request: Request, db: Db) -> Response:
    try:
        payload = await request.json()
        contact_ids = {c.id for c in request.app.state.app_config.support_contacts}
        name = payload["name"]
        props = validate_client_event(name, payload.get("props", {}), contact_ids)
    except (ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(400, "Недопустимое событие") from None
    # Без сессии (бот, запрет cookie) событие не к чему привязать — молча пропускаем.
    if session := get_session(db, request, request.app.state.settings):
        log_event(db, session, name, **props)
    return Response(status_code=204)
