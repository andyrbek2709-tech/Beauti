# Validated Main Scenario

Этот документ — результат двойной внешней валидации (исследователь + ревью-агент) и считается эталоном реализации проекта.

## Main scenario (approved baseline)

1. Салон регистрируется в web-кабинете (`/auth/register`) и получает tenant-контекст (`salon_id`).
2. Админ входит в кабинет (`/auth/login`), получает JWT, настраивает:
   - Telegram bot token,
   - Telegram user id,
   - правила расписания и длительность слотов `30/45/60`.
3. Клиент приходит из Telegram или Web, запрашивает доступность (`/availability`).
4. Доступность считается только на сервере от актуальных данных БД.
5. Бронирование (`/book`) выполняется транзакционно и идемпотентно:
   - при гонке один запрос успешен,
   - остальным возвращается `409 slot_unavailable`.
6. Отмена (`/cancel`) обновляет статус и освобождает слот.
7. Любое изменение мгновенно отражается в обоих каналах, так как у них единый API и единая БД.

## Must-have risk controls

- Tenant isolation: строгая изоляция по `salon_id` во всех запросах и таблицах.
- DB anti-collision: ограничение уникальности активного слота.
- Idempotency: ключи для `book/cancel`.
- Telegram webhook security: верификация `secret_token`.
- Timezone policy: хранение времени в UTC, отображение в timezone салона.
- Ops baseline: healthcheck, мониторинг ошибок, backup/restore проверка.

## Typical gaps to avoid

- Отсутствие дедупликации Telegram updates.
- Логи с токенами/PII.
- Отсутствие negative tests на cross-tenant доступ.
- Непроверенные восстановление БД и rollback сценарий.
- Непротестированный мобильный UX в iOS Safari и Android Chrome.

## Go-live gate (minimum)

- Параллельные бронирования одного слота: только 1 success.
- Повтор с тем же `request_id`: повторно не создает запись.
- Cross-tenant read/write попытки: отклоняются.
- Неверный Telegram webhook secret: отклоняется.
- DST/timezone smoke-tests пройдены.
- Backup restore в staging выполнен успешно.
