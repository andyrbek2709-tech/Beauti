# Beautime: Unified Booking Ecosystem

Этот файл — единый рабочий источник для людей и AI-агентов, чтобы совместно развивать проект без конфликтов и потери контекста.

## Product idea (final)

Система онлайн-записи для салонов/парикмахеров, где клиент может записаться через:
- Telegram-бот
- мобильную веб-версию (Android/iPhone)

При этом:
- оба канала работают через один backend;
- данные синхронизируются автоматически;
- один слот может быть занят только одним клиентом;
- каждый салон изолирован от других (multi-tenant).

## Core principles

- Единый источник истины: PostgreSQL + единый API.
- Один write-path для брони/отмены независимо от канала.
- Автоматическая двусторонняя синхронизация Telegram <-> Web.
- Простота UX важнее сложных функций.
- Self-service onboarding: админ салона сам регистрируется, вводит `bot token` + `telegram user id`, и сервис начинает работать без ручной настройки разработчиком.

## Target architecture

- `api` — HTTP API + auth + booking logic + admin endpoints + telegram integration endpoint.
- `worker` — фоновые задачи (напоминания/служебные проверки).
- `postgres` — данные салонов, админов, расписаний, записей, идемпотентности, аудита.
- Deployment target: Railway (`api` + `worker` + managed PostgreSQL).

## Multi-salon model

Каждый салон имеет:
- свой `salon_id`;
- своих админов (логин/пароль);
- свои настройки расписания и длительности слотов (`30/45/60`);
- свою Telegram-интеграцию (`bot token`, `telegram user id`);
- свои записи клиентов.

Изоляция обеспечивается на уровне БД и запросов: все операции scoped по `salon_id`.

## Admin onboarding flow (self-service)

1. Владелец платформы создает инвайт (`POST /platform/invites`).
2. Салон открывает `.../admin?invite=<token>`.
3. Вводит только нужный минимум: `salonName`, `email/password`, `bot token`, `telegram user id`.
4. Платформа активирует салон (`POST /auth/accept-invite`) и выдает JWT.
5. Админ настраивает график, коридоры записи, длительность `30/45/60`.
6. Сервис готов к приему записей по обоим каналам.

## Client booking flow

1. Клиент выбирает дату и время в Telegram или Web.
2. Система проверяет доступность из актуальной БД.
3. Бронь фиксируется транзакционно.
4. Если слот уже занят — `409 slot_unavailable`.
5. При отмене слот автоматически освобождается.

## API baseline

- Public:
  - `GET /availability`
  - `POST /book`
  - `POST /cancel`
  - `GET /booking/:id`
- Auth/Admin:
  - `POST /platform/invites` (owner only, `x-platform-key`)
  - `POST /auth/accept-invite`
  - `POST /auth/register`
  - `POST /auth/login`
  - `GET /admin/profile`
  - `PUT /admin/integration/telegram`
  - `PUT /admin/settings`
  - `PUT /admin/working-rules`
  - `PUT /admin/exceptions`
  - `GET /admin/appointments`

## Data consistency rules

- DB-level защита от двойной записи: уникальность активного слота на салон.
- Транзакции для `book/cancel`.
- Идемпотентность `book/cancel` по `request_id`.
- Все расчеты доступности происходят серверно на основе:
  - правил расписания,
  - исключений,
  - активных записей.

## Railway deployment

- API start command: `npm run start:api`
- Worker start command: `npm run start:worker`
- Migration: `npm run migrate`
- Required env: см. `.env.example`
- Owner panel: `http://localhost:3000/owner` (создание invite-ссылок)

## Implementation phases

Подробный план фаз находится в:
- [`IMPLEMENTATION_PHASES.md`](IMPLEMENTATION_PHASES.md)
- Валидированный основной сценарий реализации:
- [`VALIDATED_MAIN_SCENARIO.md`](VALIDATED_MAIN_SCENARIO.md)

Этот документ обязателен для выполнения и приоритезации работ.

## All scenarios (single source of truth)

Ниже собраны все рабочие сценарии проекта в одном месте.

- **S1: Основной пользовательский сценарий (Telegram/Web)**
  - клиент выбирает слот -> сервер валидирует -> `POST /book` -> подтверждение;
  - при конфликте возвращается `409 slot_unavailable`;
  - отмена через `POST /cancel` освобождает слот для обоих каналов.

- **S2: Админ-сценарий подключения салона (self-service)**
  - регистрация/вход админа;
  - ввод `telegram bot token` + `telegram user id`;
  - сохранение интеграции;
  - настройка коридоров записи, исключений и длительности `30/45/60`.

- **S3: Автоматическая синхронизация каналов**
  - Telegram и Web используют один backend;
  - доступность считается только из актуальной БД;
  - любое изменение в одном канале сразу отражается в другом на следующем запросе.

- **S4: Multi-tenant изоляция**
  - каждый салон работает в своем `salon_id` контексте;
  - данные/записи/настройки салонов не пересекаются;
  - все запросы и ограничения применяются внутри tenant.

- **S5: Сценарий надежности и безопасности**
  - транзакционная бронь + DB anti-collision;
  - идемпотентность `book/cancel`;
  - webhook/операционный контроль, backup/restore, go-live gate.

- **S6: Сценарий совместной работы агентов**
  - агент берет модуль и фиксирует в `Work log`;
  - не трогает чужие незавершенные области;
  - после изменений обновляет `README`, прогоняет сборку и фиксирует результат.

- **S7: Дизайн-сценарий мобильной версии (обязательный)**
  - перед фронтенд-реализацией утверждаются UX-потоки и UI-kit;
  - мобильная запись проектируется как premium UX (быстро, понятно, красиво);
  - реализация web-клиента допускается только по согласованным макетам и токенам.

Детализация сценариев:
- Фазы исполнения: [`IMPLEMENTATION_PHASES.md`](IMPLEMENTATION_PHASES.md)
- Проверенный финальный baseline: [`VALIDATED_MAIN_SCENARIO.md`](VALIDATED_MAIN_SCENARIO.md)

## External validation result (double-agent review)

Проведена двойная внешняя проверка:
- Агент 1: собрал лучшие практики и проблемные зоны из официальной документации и инженерных источников.
- Агент 2: перепроверил полноту и собрал чеклист пробелов/рисков.

Итог: основной сценарий проекта утвержден в `VALIDATED_MAIN_SCENARIO.md` и считается baseline для всех следующих реализаций.

Ключевые подтвержденные риски:
- гонки на бронировании и double-booking;
- cross-tenant утечки данных;
- повторные операции из-за ретраев;
- незащищенный Telegram webhook;
- проблемы timezone/DST;
- слабая операционная готовность (backup/restore, alerting).

Ключевые подтвержденные меры:
- DB-level anti-collision + транзакции;
- идемпотентность критичных операций;
- строгий tenant-scope в данных и API;
- проверка Telegram webhook secret;
- UTC policy + tenant timezone;
- go-live gate и runbook.

## Agent collaboration protocol

Чтобы несколько агентов работали совместно и не мешали друг другу:

1. Перед началом работы агент фиксирует зону ответственности (модуль/фаза) в разделе `Work Log`.
2. Один агент = одна логическая задача (например: auth, booking, telegram, web-ui, infra).
3. Не менять чужие незавершенные области без явной договоренности в `Work Log`.
4. Любое изменение API/схемы БД должно сопровождаться:
   - обновлением этого `README`;
   - обновлением `IMPLEMENTATION_PHASES.md` (если влияет на фазы).
5. Любой агент обязан запускать сборку/проверку перед завершением задачи.
6. Все решения, влияющие на архитектуру, фиксируются в `Architecture Decisions`.

## Architecture decisions

- AD-001: Multi-tenant по `salon_id`, изоляция данных на уровне БД и API.
- AD-002: Self-service Telegram integration через веб-кабинет админа.
- AD-003: Единый booking write-path для Telegram и Web.
- AD-004: Railway как целевая платформа деплоя MVP.

## Quick start (for any agent)

1. Установить зависимости: `npm install`
2. Скопировать env: `.env.example` -> `.env`
3. Запустить миграции: `npm run migrate`
4. Запустить API: `npm run dev`
5. Запустить worker: `npm run dev:worker`
6. Проверить сборку: `npm run build`
7. Открыть клиентский web: `http://localhost:3000/`
8. Открыть админку: `http://localhost:3000/admin`
9. Открыть owner-панель: `http://localhost:3000/owner`
10. Проверить защиту от двойной записи:
   - `SALON_ID=<id> npm run test:e2e:race`
11. Проверить идемпотентность брони:
   - `SALON_ID=<id> npm run test:e2e:idempotency`
12. Проверить, что отмена освобождает слот:
   - `SALON_ID=<id> npm run test:e2e:cancel-release`

## Work log (agent journal)

Используйте этот журнал как сменный дневник, чтобы следующий агент сразу понимал контекст.

### 2026-04-21
- Создан backend-каркас на TypeScript/Express.
- Добавлены доменные сервисы бронирования и отмены.
- Добавлены транзакции и идемпотентность.
- Добавлена multi-tenant модель (salons/admins/integrations).
- Добавлены auth endpoint (`register/login`) и JWT admin auth.
- Добавлены admin endpoint для Telegram token + ID.
- Добавлены миграции и Railway-ready конфигурация.
- Сборка `npm run build` проходит успешно.
- Выполнена двойная внешняя валидация (исследователь + ревью-агент).
- Зафиксирован финальный baseline в `VALIDATED_MAIN_SCENARIO.md`.
- Стартована Фаза 0.5 (дизайн): добавлены `docs/design/UX_UI_BRIEF.md`, `docs/design/SCREEN_SPECS.md`, `docs/design/DESIGN_TOKENS.json`.
- Добавлен invite-flow: `platform/invites` + `auth/accept-invite` + web-экран активации салона.
- Добавлена owner-панель `/owner` для генерации invite-ссылок в 1 клик.
- В owner-панели добавлен список последних инвайтов со статусами (`active/used/expired`).
- Добавлена возможность отзыва инвайта (`revoked`) из owner-панели.
- В owner-панели добавлены фильтры по статусам и поиск по token/note.
- Добавлен неблокирующий billing stub (trial 14 дней) и owner-статистика (`/platform/stats`).
- Добавлен Telegram webhook security: проверка `x-telegram-bot-api-secret-token` + дедупликация `update_id`.
- В админке добавлена автонастройка Telegram-бота и кнопка проверки подключения.
- В админке добавлена встроенная пошаговая инструкция по созданию Telegram-бота через BotFather.
- Добавлена кнопка "Скопировать шаблон для поддержки" при проблемах подключения Telegram.
- Добавлена кнопка "Проверить всё" с простым итогом: готово к работе или что исправить.
- Добавлен реальный Telegram-диалог в webhook: команды владельца (`/help`, `/status`, `/today`, `/link`) и автоответ клиенту со ссылкой записи.
- Добавлен e2e-тест конкурентной записи: много одновременных попыток в один слот, ожидается только 1 успешная запись.
- Добавлен e2e-тест идемпотентности: повтор одного и того же запроса возвращает ту же запись без дублей.
- Добавлен e2e-тест "отмена освобождает слот": после отмены слот снова доступен.
- Добавлена базовая наблюдаемость: `/metrics` + техстатус в owner-панели.
- Исправлен invite UX: при входе по инвайту показывается только активация, после активации бот подключается автоматически без повторного ввода.
- После активации по инвайту пользователь переводится на вход в админку; Telegram уже подключен и приходит уведомление о подключении/применении настроек.

## What was done after implementation

Этот раздел ведется только постфактум, после каждой завершенной итерации.

- Итерация 1: Базовая архитектура и схема БД.
- Итерация 2: API бронирования/отмены с защитой от коллизий.
- Итерация 3: Multi-salon + admin self-service onboarding.
- Итерация 4: Railway deployment baseline (api/worker/postgres).

## Next priority backlog

- Фаза 0.5: утвердить макеты в Figma на основе `docs/design/*`.
- Web UI для кабинета админа (login/settings/integration).
- E2E тесты гонок на один слот.
- Observability: метрики/алерты/backup-restore drill.
- Telegram webhook security hardening (`secret_token` verification + update dedup).
- Tenant security hardening (RLS/negative tests на cross-tenant доступ).
