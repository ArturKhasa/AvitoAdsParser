-- Колонки соотношения сторон картинки креатива (приходят строками: "1").
ALTER TABLE avito_creatives ADD COLUMN IF NOT EXISTS image_ratio_x TEXT;
ALTER TABLE avito_creatives ADD COLUMN IF NOT EXISTS image_ratio_y TEXT;
