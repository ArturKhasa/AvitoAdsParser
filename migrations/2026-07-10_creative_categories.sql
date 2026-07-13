-- Связь креатив <-> категория, в которой его показали.
-- Один erid крутится в нескольких категориях, поэтому many-to-many, а не колонка.
CREATE TABLE IF NOT EXISTS avito_creative_categories (
  id               bigserial PRIMARY KEY,
  creative_id      bigint      NOT NULL REFERENCES avito_creatives(id) ON DELETE CASCADE,
  category_id      bigint      NOT NULL,   -- master_category из запроса
  microcategory_id bigint      NOT NULL,   -- microCategory из запроса
  category_name    text,                   -- денормализация для читаемости выборок
  first_seen_at    timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at     timestamptz NOT NULL DEFAULT NOW(),
  counter          integer     NOT NULL DEFAULT 1,
  CONSTRAINT avito_creative_categories_uniq UNIQUE (creative_id, category_id, microcategory_id)
);

CREATE INDEX IF NOT EXISTS avito_creative_categories_category_idx
  ON avito_creative_categories (category_id);
