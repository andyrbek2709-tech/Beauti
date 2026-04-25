-- Флаг для «ручной блокировки» слота администратором.
-- is_admin_block = true означает, что запись создана не клиентом,
-- а администратором вручную, чтобы закрыть этот временной слот.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_admin_block boolean NOT NULL DEFAULT false;
