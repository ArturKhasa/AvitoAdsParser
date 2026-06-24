-- Добавляет erid и переводит уникальность avito_creatives на erid.
-- Запустить ОДИН раз перед рестартом fetch-creative.mjs.

-- 1. колонка
ALTER TABLE avito_creatives ADD COLUMN IF NOT EXISTS erid TEXT;

-- 2. снять старую уникальность по title (иначе блокирует вставку при дубле title)
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'avito_creatives'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (title)'
  LOOP
    EXECUTE format('ALTER TABLE avito_creatives DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

-- 3. уникальность по erid (NULL у старых строк допускается — несколько NULL не конфликтуют)
CREATE UNIQUE INDEX IF NOT EXISTS avito_creatives_erid_uniq ON avito_creatives (erid);
