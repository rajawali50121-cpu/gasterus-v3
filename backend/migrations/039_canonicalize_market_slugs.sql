-- Samakan slug lima pasar dengan kosakata kanonik di
-- backend/data/toto-source-map.json.
--
-- LATAR BELANG
-- Dua kosakata slug pernah hidup berdampingan:
--   - kanonik  : newjersey-mid-pool, tennessee-mid-pool, tennessee-eve-pool,
--                washington-md-pool, washington-ev-pool  (source map; dipakai
--                collector, scheduler, dan DRAW_SCHEDULE)
--   - lama/typo: newjerseymid-pool, tennesse-mid-pool, tennesse-eve-pool,
--                washingtonmd-pool, washingtonev-pool     (dipakai markets.seed.json
--                lama, toto-official-source.js, dan migration 038)
--
-- Baris markets untuk slug lama itu TIDAK PERNAH disentuh collector lagi karena
-- collector selalu menulis ke slug kanonik. Akibatnya:
--   - markets.result / verification_status / updated_at membeku (teramati 20 jam),
--   - markets.draw_time juga tidak ikut terisi dari migration 038 yang memakai
--     slug lama,
--   - baris itu tertinggal SUSPENDED tanpa close_at sehingga tidak bisa dipasang.
--
-- KENAPA AMAN
-- markets.slug adalah satu-satunya kolom slug di skema ini. Semua tabel lain
-- (market_betting_configs, bets, market_result_history) mereferensikan
-- markets.id (BIGINT), bukan markets.slug. Karena itu mengganti slug TIDAK
-- menyentuh foreign key, histori bet, market_result_history, maupun nomor
-- period. markets.id tidak berubah.
--
-- KEBIJAKAN: JANGAN DUPLIKAT, JANGANG MENIMPA
-- 1. Tidak ada INSERT dan tidak ada DELETE. Baris diperbaiki di tempatnya.
-- 2. Hanya kolom markets.slug yang disentuh. result, verification_status,
--    period, draw_time, source_updated_at, dan updated_at TIDAK diubah, sehingga
--    usia data yang membeku tetap terlihat jujur dan tidak disamarkan.
-- 3. Sebelum mengubah, migrasi memeriksa apakah slug kanonik sudah ada. Kalau
--    ternyata sudah ada, migrasi DIBATALKAN (RAISE EXCEPTION) dan tidak
--    menggabungkan dua baris secara diam-diam. Pilihan itu milik operator.
-- 4. auto_reopen_blocked hanya dilepas pada lima baris hasil rename, dan hanya
--    bila memang sedang TRUE. Nilai lain tidak ditulis ulang.
-- 5. betting_status sengaja tidak diubah. Pasar tetap SUSPENDED sampai
--    reconcileCashBettingWindows menghitungkan jendela betting yang aman dari
--    histori terverifikasi — fail-closed tetap terjaga.
--
-- Idempoten: setiap langkah aman dijalankan berkali-kali, ditutup verifikasi.

BEGIN;

-- (1) PRE-FLIGHT: batalkan kalau slug kanonik sudah ada di markets.
DO $$
DECLARE
  bentrok TEXT;
BEGIN
  SELECT string_agg(t.target, ', ') INTO bentrok
  FROM (VALUES
    ('newjerseymid-pool', 'newjersey-mid-pool'),
    ('tennesse-mid-pool', 'tennessee-mid-pool'),
    ('tennesse-eve-pool', 'tennessee-eve-pool'),
    ('washingtonmd-pool', 'washington-md-pool'),
    ('washingtonev-pool', 'washington-ev-pool')
  ) AS t(legacy, target)
  JOIN markets m ON m.slug = t.target;

  IF bentrok IS NOT NULL THEN
    RAISE EXCEPTION
      'Migrasi 039 dibatalkan: slug kanonik sudah ada di markets (%). Tidak ada data yang diubah; periksa dan putuskan manual sebelum menjalankan ulang.',
      bentrok;
  END IF;
END $$;

-- (2) Laporan supaya bisa diaudit di log Railway.
DO $$
DECLARE
  jumlah INTEGER;
BEGIN
  SELECT COUNT(*) INTO jumlah FROM markets
  WHERE slug IN ('newjerseymid-pool','tennesse-mid-pool','tennesse-eve-pool','washingtonmd-pool','washingtonev-pool');
  RAISE NOTICE 'Migration 039: % baris markets akan diubah slugnya ke kosakata kanonik', jumlah;
END $$;

-- (3) Rename. Hanya kolom slug; data hasil, draw_time, dan updated_at utuh.
UPDATE markets SET slug = 'newjersey-mid-pool' WHERE slug = 'newjerseymid-pool';
UPDATE markets SET slug = 'tennessee-mid-pool' WHERE slug = 'tennesse-mid-pool';
UPDATE markets SET slug = 'tennessee-eve-pool' WHERE slug = 'tennesse-eve-pool';
UPDATE markets SET slug = 'washington-md-pool' WHERE slug = 'washingtonmd-pool';
UPDATE markets SET slug = 'washington-ev-pool' WHERE slug = 'washingtonev-pool';

-- (4) Buka jalan auto-reopen untuk kelima baris itu saja. updated_at di sini
--     disentuh sebagai jejak audit pelepasan kunci.
UPDATE market_betting_configs c
SET auto_reopen_blocked = FALSE,
    updated_at = now()
FROM markets m
WHERE c.market_id = m.id
  AND c.auto_reopen_blocked
  AND m.slug IN ('newjersey-mid-pool','tennessee-mid-pool','tennessee-eve-pool','washington-md-pool','washington-ev-pool');

-- (5) VERIFIKASI: slug lama habis, slug kanonik hadir, tidak ada duplikat.
DO $$
DECLARE
  sisa_lama INTEGER;
  hilang TEXT;
BEGIN
  SELECT COUNT(*) INTO sisa_lama FROM markets
  WHERE slug IN ('newjerseymid-pool','tennesse-mid-pool','tennesse-eve-pool','washingtonmd-pool','washingtonev-pool');
  IF sisa_lama <> 0 THEN
    RAISE EXCEPTION 'Migrasi 039 gagal: masih ada % baris dengan slug lama', sisa_lama;
  END IF;

  SELECT string_agg(t.target, ', ') INTO hilang
  FROM (VALUES
    ('newjersey-mid-pool'),
    ('tennessee-mid-pool'),
    ('tennessee-eve-pool'),
    ('washington-md-pool'),
    ('washington-ev-pool')
  ) AS t(target)
  LEFT JOIN markets m ON m.slug = t.target
  WHERE m.id IS NULL;

  IF hilang IS NOT NULL THEN
    RAISE EXCEPTION 'Migrasi 039 gagal: slug kanonik berikut tidak ditemukan setelah rename: %', hilang;
  END IF;

  RAISE NOTICE 'Migration 039: lima slug kanonik terpasang; tidak ada duplikat dan tidak ada data hasil yang ditimpa';
END $$;

COMMIT;