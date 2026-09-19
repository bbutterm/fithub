import { describe, expect, it } from "vitest";
import { assignRanks, rankFeedCandidates, weekRangeUtc } from "../feed.js";

describe("weekRangeUtc", () => {
  it("неделя идёт с понедельника 00:00 МСК", () => {
    // среда 2026-09-16, 12:00 МСК
    const r = weekRangeUtc(new Date("2026-09-16T09:00:00Z"));
    expect(r.key).toBe("2026-09-14");
    expect(r.start.toISOString()).toBe("2026-09-13T21:00:00.000Z"); // 14-е 00:00 МСК
    expect(r.end.toISOString()).toBe("2026-09-20T21:00:00.000Z");
  });

  it("воскресенье ещё принадлежит уходящей неделе", () => {
    expect(weekRangeUtc(new Date("2026-09-20T18:00:00Z")).key).toBe("2026-09-14");
  });

  it("понедельник 00:30 МСК — уже новая неделя", () => {
    expect(weekRangeUtc(new Date("2026-09-20T21:30:00Z")).key).toBe("2026-09-21");
  });

  it("границы стыкуются без дыр и нахлёстов", () => {
    const a = weekRangeUtc(new Date("2026-09-16T09:00:00Z"));
    const b = weekRangeUtc(new Date("2026-09-23T09:00:00Z"));
    expect(a.end.getTime()).toBe(b.start.getTime());
  });
});

describe("rankFeedCandidates", () => {
  const card = (id: number, voteCount: number, published: string) => ({ id, voteCount, publishedAt: new Date(published) });

  it("сначала наименее оценённые, внутри — свежие", () => {
    const out = rankFeedCandidates([
      card(1, 5, "2026-09-19T10:00:00Z"),
      card(2, 0, "2026-09-18T10:00:00Z"),
      card(3, 0, "2026-09-19T10:00:00Z")
    ]);
    expect(out.map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it("не мутирует вход и переживает отсутствие даты публикации", () => {
    const input = [{ id: 1, voteCount: 1, publishedAt: null }, { id: 2, voteCount: 0, publishedAt: null }];
    const out = rankFeedCandidates(input);
    expect(out.map((c) => c.id)).toEqual([2, 1]);
    expect(input.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe("assignRanks", () => {
  it("равные результаты делят место, следующий его пропускает", () => {
    const out = assignRanks([
      { userId: 1, likes: 3 },
      { userId: 2, likes: 7 },
      { userId: 3, likes: 7 },
      { userId: 4, likes: 1 }
    ]);
    expect(out.map((r) => [r.row.userId, r.rank])).toEqual([
      [2, 1],
      [3, 1],
      [1, 3],
      [4, 4]
    ]);
  });

  it("пустая таблица — пустой результат", () => {
    expect(assignRanks([])).toEqual([]);
  });
});
