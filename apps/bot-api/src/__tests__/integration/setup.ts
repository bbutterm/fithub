import { beforeEach } from "vitest";
import { prisma } from "../../db.js";

/**
 * Перед каждым тестом база пустая.
 *
 * TRUNCATE с CASCADE и перезапуском последовательностей, а не удаление по
 * таблицам: порядок внешних ключей меняется с каждой миграцией, и поддерживать
 * его вручную означает чинить тесты вместо кода. Список таблиц берётся из самой
 * базы, поэтому новая таблица подхватывается без правок здесь.
 */
let tables: string[] | null = null;

async function tableNames(): Promise<string[]> {
  if (tables) return tables;
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
  `;
  tables = rows.map((r) => `"${r.tablename}"`);
  return tables;
}

beforeEach(async () => {
  const names = await tableNames();
  if (names.length === 0) return;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names.join(", ")} RESTART IDENTITY CASCADE`);
});
