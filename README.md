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
  - `GET /platform/invites`
  - `POST /platform/invites/:token/revoke`
  - `GET /platform/salons` (owner only)
  - `DELETE /platform/salons/:salonId` (owner only)
  - `GET /platform/stats` (owner only)
  - `POST /auth/accept-invite`
  - `POST /auth/register`
  - `POST /auth/login`
  - `POST /auth/password-reset/telegram/start`
  - `POST /auth/password-reset/telegram/confirm`
  - `GET /admin/profile`
  - `PUT /admin/integration/telegram`
  - `POST /admin/integration/telegram/auto-setup`
  - `GET /admin/integration/telegram/check`
  - `PUT /admin/settings`
  - `PUT /admin/working-rules`
  - `PUT /admin/exceptions`
  - `GET /admin/appointments` — возвращает только активные (`status='booked'`) записи на дату; в каждом элементе есть флаг `is_admin_block`.
  - `POST /admin/slots/block` — закрыть свободный слот (тело: `{ "slotStartAt": "<ISO>" }`). Создаёт техническую запись со `status='booked'`, `is_admin_block=true`. Конфликт со существующей бронью → `409`.
  - `DELETE /admin/slots/block/:appointmentId` — снять блокировку (переводит запись в `cancelled`, освобождая слот).

## Telegram capabilities (current)

- Клиентская запись полностью внутри Telegram (без перехода в web).
- Для нового клиента запись открывается только после сохранения телефона.
- Валидация телефона: принимаются только `8XXXXXXXXXX` или `+7XXXXXXXXXX` (также `7XXXXXXXXXX`).
- Ограничение: 1 активная запись на 14 дней на клиента Telegram.
- Отмена клиентом через кнопку в Telegram + уведомление мастеру.
- Напоминания клиенту за ~24 часа и ~1 час до визита.
- Кнопка подтверждения планов в напоминании (`Планы в силе`) + уведомление мастеру.
- Мастер видит сетку занятости по дню (`🟩 занято`, `⬜ свободно`) и карточку записи по нажатию на занятый слот.
- Мастер может отменять запись с вводом причины; клиент получает сообщение об отмене с причиной.
- Кнопочный режим для мастера: меню без обязательного ручного ввода команд.
- Массовая рассылка клиентам с подтверждением (двухшаговый сценарий).
- Пауза записи по диапазону дат с безопасным подтверждением и выбором режима:
  - только закрыть новые записи;
  - отменить записи в периоде с пользовательским текстом уведомления.
- Месячные шаблоны графика кнопками: `четные даты` / `нечетные даты` / `через день`.
- Двойной сброс настроек мастера (двойное подтверждение) с немедленным переходом к повторной настройке графика.
- Команда `/help` для мастера расширена: подробное описание всех кнопок, блоков меню и рабочих сценариев.
- После регистрации и после сброса настроек по умолчанию применяется сетка `1 час` и горизонт записи `14 дней`.
- Добавлен защитный fallback доступности: если рабочие правила еще не заданы, слоты строятся по базовому окну `10:00-20:00` (ежедневно), чтобы запись не "падала" в режим "слотов нет".
- Ручная блокировка слота мастером (миграция `014_admin_slot_block.sql`):
  - в дневном расписании пустой слот тапается → подтверждение «Закрыть слот ДД.ММ ЧЧ:ММ?» → `🔒 Закрыть`;
  - закрытый слот помечается `🔒` и при повторном нажатии предлагает `✅ Снять блокировку`;
  - технически создаётся `appointments` со `status='booked'`, `is_admin_block=true`, `client_phone='admin_block'` — благодаря уникальному индексу `uq_active_slot_per_salon` клиент в этот слот записаться не может (`409 slot_unavailable`);
  - reminder-воркер блокировки игнорирует (фильтр `client_telegram_user_id IS NOT NULL`);
  - аналогичная фича доступна и в веб-админке (`/admin`, раздел «Расписание дня»).

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
- Migration: `npm run migrate` — **не входит в startCommand**, миграции накатываются вручную после деплоя (см. ниже).
- Required env: см. `.env.example`
- Owner panel: `http://localhost:3000/owner` (создание invite-ссылок)

### Production (Railway) — координаты и операции

- Workspace: `andyrbek2709-tech's Projects`
- Project: `exciting-friendship` (id `010fd185-e9e0-4d0b-8391-02402b3bf659`)
- Environment: `production` (id `14cd9dae-dd7a-49aa-bf7f-f07b255f5da7`)
- Service: `Beauti` (id `d9c70958-94a8-4c48-9242-27753215941c`)
- Public URL: https://beauti-production.up.railway.app (`/health`, `/admin`, `/availability`, …)
- Repo (auto-deploy from `main`): https://github.com/andyrbek2709-tech/Beauti
- Postgres: отдельный сервис в том же проекте, переменная `DATABASE_URL` подключена в Beauti как reference.

### CLI cheat sheet

CLI лежит в `C:\Users\Admin\AppData\Roaming\npm\railway.cmd` (PowerShell `where.exe railway` его не находит — путь нужно давать целиком). Авторизация уже выполнена под `andyrbek2709@gmail.com`.

```powershell
# Привязать репозиторий к сервису (один раз на машину/папку)
railway link `
  --project 010fd185-e9e0-4d0b-8391-02402b3bf659 `
  --environment 14cd9dae-dd7a-49aa-bf7f-f07b255f5da7 `
  --service d9c70958-94a8-4c48-9242-27753215941c

# Накатить миграции на прод-БД (использует переменные сервиса)
railway run --service Beauti -- npm run migrate

# Прод-логи (build/deploy/runtime)
railway logs --service Beauti

# Перезапустить последний деплой без пересборки
railway restart --service Beauti

# Передеплоить из main без пересборки кода
railway redeploy --service Beauti

# Посмотреть переменные окружения сервиса (KV-вид)
railway variables --service Beauti --kv

# Список деплоев
railway deployment list --json
```

Деплой триггерится автоматически по push в `main` на GitHub. Миграции — **отдельный шаг**: после успешного деплоя обязательно вызывать `railway run --service Beauti -- npm run migrate`, иначе новые колонки/индексы в проде не появятся и эндпоинты под них упадут.

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
- В owner-панель добавлено управление салонами: список + удаление салона без ручного SQL.
- На странице `/admin` добавлено восстановление пароля через Telegram: отправка 6-значного кода в Telegram и смена пароля по коду.

### 2026-04-22
- Исправлена автонастройка Telegram webhook за reverse proxy Railway (`https`/`trust proxy`), устранена ошибка `An HTTPS URL must be provided for webhook`.
- Реализована запись клиента полностью внутри Telegram: выбор даты/времени кнопками, подтверждение, уведомление мастеру.
- Добавлена таблица `telegram_clients` и сохранение клиентского профиля из Telegram.
- Для новых клиентов включен phone-first UX: сначала номер, затем запись.
- Добавлена fallback-поддержка ручного ввода телефона; затем ужесточена валидация по формату РФ (`8XXXXXXXXXX` / `+7XXXXXXXXXX`).
- Изменено подтверждение записи: короткий текст без длинного ID, с благодарностью клиенту.
- Добавлены напоминания за 24 часа и за 1 час с кнопкой подтверждения планов.
- Добавлена фиксация подтверждения визита (`client_confirmed_at`) и уведомление мастеру.
- Для мастера расширено Telegram-меню: `Сегодня/Завтра/Послезавтра/14 дней`, просмотр сетки и карточки записи.
- Добавлен просмотр деталей записи в один клик по занятому слоту.
- Добавлена отмена записи мастером через Telegram с обязательной причиной.
- Добавлена клиентская отмена по кнопке + уведомления мастеру.
- Введено ограничение: один Telegram-клиент может иметь только одну активную запись в ближайшие 14 дней.
- Добавлена пауза записи и последующая переработка в безопасный режим диапазона дат.
- Пауза теперь настраивается кнопками `с даты по дату` с предпросмотром количества затрагиваемых записей.
- Для паузы добавлены режимы:
  - закрыть только новые записи;
  - отменить существующие записи с обязательным пользовательским текстом уведомления.
- Добавлены месячные шаблоны графика (`четные/нечетные/через день`) и их учет в availability/booking.
- Добавлено напоминание мастеру о необходимости продлить график, если покрытие горизонта заканчивается.
- Добавлена массовая рассылка клиентам из Telegram-меню мастера с подтверждением и отчетом (`sent/failed`).
- Добавлен двойной “сброс настроек” мастера (паузы+шаблоны) с немедленным возвратом к выбору нового регламента.
- Owner-панель улучшена: автозагрузка полного списка салонов, удаление салонов, сохранение platform key в браузере.
- Все изменения собраны, миграции применены и задеплоены в Railway прод.

### 2026-04-21 (latest updates)
- Для Telegram-мастера расширена команда `/help`: добавлена полная справка "что делает каждая кнопка" с группировкой по блокам меню.
- Изменены дефолты при создании салона (`register`/`accept-invite`): сетка по умолчанию `60 минут`, горизонт записи `14 дней`.
- Обновлен сценарий `Сбросить настройки`: теперь дополнительно принудительно устанавливаются дефолты `1 час / 14 дней`, чтобы мастер сразу мог работать без ручного добора базовых параметров.
- Исправлен критичный UX-баг после сброса: если `working_rules` пустые, availability не возвращает пустой результат, а использует базовое окно `10:00-20:00` на каждый день.
- Выполнены проверка сборки (`npm run build`) и деплой в Railway; `GET /health` возвращает `{"ok":true}`.

### 2026-04-23 (latest updates)
- В Telegram-боте заменено действие `Сбросить настройки` на `Очистить график` и перенесено в раздел `Настройки` (нижняя кнопка списка).
- Добавлено безопасное подтверждение перед очисткой (`Очистить` / `Отмена`) с понятным списком того, что будет удалено.
- Логика очистки графика теперь сбрасывает: рабочие дни, рабочее время, длительность записи, закрытые даты/паузы и шаблоны графика.
- После очистки показывается понятное сообщение и быстрый переход в раздел `График`.
- Раздел `Помощь` дополнен блоком `Как очистить график` простым пользовательским языком.
- Обновлена логика availability: читаются все `working_rules`, но используются только активные; это позволяет хранить "пустой" (неактивный) график без автоподстановки fallback-окон.

## What was done after implementation

Этот раздел ведется только постфактум, после каждой завершенной итерации.

- Итерация 1: Базовая архитектура и схема БД.
- Итерация 2: API бронирования/отмены с защитой от коллизий.
- Итерация 3: Multi-salon + admin self-service onboarding.
- Итерация 4: Railway deployment baseline (api/worker/postgres).
- Итерация 5 (2026-04-26): Упрощение UX «Рабочие дни», горизонт 30 дней, аудит изоляции.

### Итерация 5 — детально

**1. Telegram-бот «Рабочие дни» — новый флоу (commit `3c66d48`).**
Раньше при выборе «Рабочие дни» открывался список из 7 кнопок-дней недели с toggle. Теперь:
- Шаг 1: «Каждый день» / «Через день».
- Шаг 2: «Сегодня» / «Завтра» (стартовая дата).
- Шаг 3: график сразу сохраняется и активен на год вперёд.

Реализация ([src/server.ts](src/server.ts) callback `adm:workdays`, `adm:workdays:type:*`, `adm:workdays:start:*`):
- «Каждый день» → upsert все 7 дней в `working_rules` с `is_active = true`, любые активные `salon_work_patterns` деактивируются.
- «Через день» → то же + INSERT в `salon_work_patterns` (`pattern_type='every_other_day'`, `anchor_date=startDate`, `period = startDate..startDate+1 year`).

**2. Миграция 016: UNIQUE на `working_rules(salon_id, weekday)`.**
Файл [src/migrations/016_working_rules_unique_constraint.sql](src/migrations/016_working_rules_unique_constraint.sql). Сначала дедупликация дублей, потом DROP старого индекса, потом ADD CONSTRAINT. Без этой миграции `ON CONFLICT (salon_id, weekday)` крашился с 500 («there is no unique or exclusion constraint matching the ON CONFLICT specification»).

**3. Горизонт записи: 14 → 30 дней повсюду.**
- `BOOKING_HORIZON_DAYS=30` на Railway (было 14, переменная перебивала дефолт кода).
- [src/config.ts](src/config.ts): дефолт `bookingHorizonDays` 14 → 30.
- [src/server.ts](src/server.ts): все INSERT в `master_settings` при регистрации/инвайте/clear-schedule (`60,30,2,…`), все `COALESCE(..., 30)`, fallback `?? 30`.
- [src/services/bookingService.ts](src/services/bookingService.ts): `getAvailabilityForSalon` теперь читает `horizonDays` из `master_settings` конкретного салона (а не из глобального config). Per-salon settings всегда выигрывают над env.
- [public/web-app.js](public/web-app.js): дефолт `toDate` = `today + 30 days`.
- [src/server.ts](src/server.ts) Telegram-клиент: `renderDateChoices` slice `(0, 30)` (был 14).
- [src/server.ts](src/server.ts) админская кнопка переименована «Следующие 30 дней», функция `renderAdmin30Days` берёт `length: 30`.
- Бизнес-правило «1 запись на 14 дней» для клиента → теперь 30 (`interval '30 days'`, текст ошибки тоже).
- Миграция 015 [src/migrations/015_booking_horizon_30days.sql](src/migrations/015_booking_horizon_30days.sql) — UPDATE существующих салонов 14 → 30.

**Не трогали (это билинг, не горизонт):** `interval '14 days'` в `subscriptions`/`billing_events` — это trial-период новых салонов.

**4. UI: Сегодня/Завтра наверх (commit `53b1d46`).**
В Telegram-боте на экране «Записи» (callback `adm:section:bookings`) кнопки `Сегодня` / `Завтра` подняты над днями недели. Финальный порядок: Сегодня/Завтра → дни недели (2 в ряд) → «Следующие 30 дней» → «Главное меню».

**5. Аудит изоляции салонов (commit `4db00a3`).**
Прошёлся по всем INSERT/UPDATE/DELETE в `server.ts` и `bookingService.ts`.
- Все HTTP `/admin/*` эндпоинты используют `req.admin!.salonId` из JWT — `salonId` физически не приходит из тела запроса.
- Все Telegram-callback'и админа гейтятся проверкой `fromId === adminTelegramUserId` для конкретного `salon_id` из URL `/telegram/webhook/:salonId`.
- Все WHERE/SET на `working_rules`, `master_settings`, `schedule_exceptions`, `salon_work_patterns`, `booking_pauses`, `telegram_admin_actions` фильтруются по `salon_id`.
- Defense-in-depth: добавил `AND salon_id = $X` в три UPDATE на `appointments`, где раньше было только `WHERE id = $1` (ownership проверялся отдельным SELECT, эксплуатировать было нельзя, но теперь и сам UPDATE не пробьётся): подтверждение клиента по напоминанию, разблокировка слота админом через бот, разблокировка слота админом через web.
- Мёртвый код в [src/services/bookingService.ts](src/services/bookingService.ts): функции `getAvailability` / `bookAppointment` / `cancelAppointment` (без salonId) от старой master-based архитектуры — нигде не вызываются.

**Текущее состояние ENV (Railway, service Beauti):**
- `BOOKING_HORIZON_DAYS=30`
- `CANCEL_CUTOFF_HOURS=2`
- `TZ=Europe/Moscow`
- остальное — без изменений (`DATABASE_URL`, `JWT_SECRET`, `ADMIN_API_KEY`, `CONTROL_TOWER_API_URL`).

## Next priority backlog

- Добавить кнопку “Показать активный шаблон графика” для мастера.
- Добавить двойное подтверждение перед массовой отменой в паузе (дополнительный guard).
- Добавить фильтры рассылки (все/активные/ближайшие 3 дня).
- Добавить “Мои записи” для клиента Telegram (просмотр + отмена без поиска).
- Перенести owner-dashboard в отдельный репозиторий и начать интеграцию событий.
