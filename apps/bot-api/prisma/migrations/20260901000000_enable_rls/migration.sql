-- Включаем row level security на всех таблицах схемы public.
--
-- До этой миграции RLS не включался нигде: Prisma его не создаёт, а Supabase
-- делает это сам только для таблиц, заведённых через дашборд. В результате
-- любая таблица читалась и правилась снаружи через Data API по ключу anon —
-- security advisor Supabase помечает это как rls_disabled_in_public.
--
-- Политик намеренно не создаём. Приложение подключается владельцем таблиц,
-- а владельца RLS не ограничивает, тогда как остальным ролям без единой
-- политики не достаётся ничего. Поведение приложения не меняется.
--
-- Проход циклом, а не перечислением: три таблицы (ProcessedUpdate,
-- RecognitionLock, BenchImage) создаются приложением в рантайме и в схеме
-- Prisma отсутствуют, но защитить их нужно так же. Повторный запуск безопасен —
-- ENABLE ROW LEVEL SECURITY на уже защищённой таблице ничего не меняет.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
