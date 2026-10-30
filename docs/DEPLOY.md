# Деплой в Yandex Cloud

Схема для MVP: одна VM с Docker Compose (приложение, Caddy с HTTPS, планировщик, бэкапы) и
Managed Service for PostgreSQL. Все данные — в регионе `ru-central1` (152-ФЗ, docs/LEGAL.md).

```
Интернет ─443─▶ Caddy (Let's Encrypt) ─▶ app (uvicorn, 1 процесс) ─▶ Managed PostgreSQL
                                        scheduler — перегенерация отчётов каждые 15 мин
                                        backup    — pg_dump раз в сутки, хранение 14 дней
```

## Ограничения MVP

- **Один процесс приложения.** Очередь генерации отчётов и лимиты запросов живут в памяти процесса.
  Больше воркеров — только после переноса очереди и лимитов во внешнее хранилище (Redis/YMQ).
- При рестарте незавершённые отчёты не теряются: при старте они снова ставятся в очередь.

## 1. Ресурсы в облаке

1. **Managed PostgreSQL 16**: минимальный класс хоста, автоматические бэкапы включены (по умолчанию
   их хранят 7 дней). Пользователь и база — `happiness`. Доступ — только из подсети VM.
2. **VM (Compute Cloud)**: Ubuntu LTS, 2 vCPU / 4 ГБ, публичный **статический** IP.
   Группа безопасности: входящие 80 и 443 — всем; 22 — только с ваших адресов.
3. **DNS**: A-запись домена → статический IP VM.
4. Корневой сертификат Managed PostgreSQL положи на VM в `certs/root.crt` рядом с репозиторием
   (ссылка на сертификат — в консоли кластера, раздел «Подключиться»).

## 2. Настройка VM

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
git clone <репозиторий> happiness && cd happiness
mkdir -p certs && cp ~/root.crt certs/root.crt
cp .env.example .env && nano .env
```

Обязательное в `.env` (без этого приложение в production не стартует — см. docs/LAUNCH_CHECKLIST.md):

```bash
APP_ENV=production
APP_BASE_URL=https://<домен>
DOMAIN=<домен>
DATABASE_URL=postgresql+psycopg://happiness:<пароль>@<хост>.mdb.yandexcloud.net:6432/happiness?sslmode=verify-full&sslrootcert=/app/certs/root.crt
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
EMAIL_HASH_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
EMAIL_ENCRYPTION_KEY=<python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())">
ADMIN_PASSWORD=<длинный пароль>
INTERNAL_LINK_TOKEN=<секрет для ссылки /internal/...>
YOOKASSA_SHOP_ID=... YOOKASSA_SECRET_KEY=test_...      # боевой — только с YOOKASSA_ALLOW_LIVE=true
LLM_PROVIDER=gigachat|yandexgpt + ключи провайдера
SMTP_HOST=... SMTP_PORT=465 SMTP_USER=... SMTP_PASSWORD=... MAIL_FROM=...
YANDEX_METRIKA_ID=...                                   # необязательно
```

> `EMAIL_ENCRYPTION_KEY` и `EMAIL_HASH_KEY` после запуска не менять: без них не расшифровать email
> в заказах и не найти их по хешу. Храни копию в Lockbox или менеджере паролей.

## 3. Запуск

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d --build
docker compose -f deploy/docker-compose.prod.yml logs -f app    # миграции и старт
curl https://<домен>/healthz                                     # {"status":"ok"}
```

Если приложение не стартует, в логе будет `ConfigError` со списком того, что не готово (плейсхолдеры,
секреты, версия модели, https).

## 4. После запуска

1. **ЮKassa**: в кабинете магазина → HTTP-уведомления → URL `https://<домен>/webhooks/yookassa`,
   события `payment.succeeded`, `payment.canceled`, `refund.succeeded`. Проверка IP включена в коде.
2. **Свои браузеры** пометь ссылкой `https://<домен>/internal/<INTERNAL_LINK_TOKEN>` — их сессии не
   попадут в метрики.
3. Тестовая покупка в тестовом магазине → отчёт открылся, письмо пришло, `/admin` показывает оплату
   (с переключателем «показать внутренние»).
4. Мониторинг: проверка доступности `https://<домен>/healthz` (Yandex Monitoring или любой uptime-сервис).

## Обновление

```bash
git pull && docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d --build
```

Миграции применяются при старте контейнера. Перед миграциями, меняющими данные, сделай ручной бэкап.

## Бэкапы и восстановление

- Основные — автоматические бэкапы Managed PostgreSQL (восстановление на момент времени — в консоли).
- Дополнительно сервис `backup` раз в сутки делает `pg_dump` в том `backups` (14 дней). Рекомендуется
  копировать их в Object Storage: `aws s3 sync` с endpoint `https://storage.yandexcloud.net`.
- Восстановление дампа: `pg_restore --clean --if-exists -d "<url>" happiness-<дата>.dump`.

## Логи

- `docker compose -f deploy/docker-compose.prod.yml logs app` — access-лог приложения без IP,
  query-строк и токенов отчётов; генерация отчётов — модель, токены, время, стоимость.
- Access-лог Caddy отключён, чтобы IP не попадали в логи (docs/LEGAL.md).
