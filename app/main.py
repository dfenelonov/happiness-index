from fastapi import FastAPI

from app.config import Settings, check_production_readiness, get_settings, load_configs
from app.db.session import create_db_engine, make_session_factory
from app.routes import health


def create_app(settings: Settings | None = None) -> FastAPI:
    """Собирает приложение. Невалидный конфиг или неготовый production — отказ старта."""
    settings = settings or get_settings()
    configs = load_configs(settings.config_dir)
    check_production_readiness(settings)

    app = FastAPI(title=configs.app.site_name)
    app.state.settings = settings
    app.state.questionnaire = configs.questionnaire
    app.state.app_config = configs.app
    app.state.engine = create_db_engine(settings.database_url)
    app.state.session_factory = make_session_factory(app.state.engine)

    app.include_router(health.router)
    return app


app = create_app()
