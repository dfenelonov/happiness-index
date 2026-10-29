from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import APP_DIR, Settings, check_production_readiness, get_settings, load_configs
from app.db.session import create_db_engine, make_session_factory
from app.routes import events, health, pages, results, test
from app.services.test_flow import TestFlow
from app.web import render


def create_app(settings: Settings | None = None) -> FastAPI:
    """Собирает приложение. Невалидный конфиг или неготовый production — отказ старта."""
    settings = settings or get_settings()
    configs = load_configs(settings.config_dir)
    check_production_readiness(settings)

    app = FastAPI(title=configs.app.site_name)
    app.state.settings = settings
    app.state.questionnaire = configs.questionnaire
    app.state.app_config = configs.app
    app.state.test_flow = TestFlow(
        configs.questionnaire, show_placeholders=not settings.is_production
    )
    app.state.templates = Jinja2Templates(directory=settings.templates_dir)
    app.state.engine = create_db_engine(settings.database_url)
    app.state.session_factory = make_session_factory(app.state.engine)

    app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
    for module in (health, pages, test, results, events):
        app.include_router(module.router)

    @app.exception_handler(StarletteHTTPException)
    async def html_errors(request: Request, exc: StarletteHTTPException):
        if exc.status_code == 404:
            return render(request, "not_found.html", status=404)
        return await http_exception_handler(request, exc)

    return app


app = create_app()
