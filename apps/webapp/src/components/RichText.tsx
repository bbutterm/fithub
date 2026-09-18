import type { ReactNode } from "react";

/**
 * Текст от модели с минимальной разметкой: **жирный** и заголовки «### …».
 *
 * Старые советы и отчёты уже сохранены со звёздочками, а новые модель просят
 * писать без них — но полагаться на это нельзя. Разбираем сами, без innerHTML:
 * текст пришёл от модели, и доверять ему как HTML не стоит.
 */
export function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <p style={{ whiteSpace: "pre-wrap" }}>
      {lines.map((line, i) => {
        const heading = /^#{1,6}\s+(.+)$/.exec(line);
        const content = heading ? <b>{heading[1]}</b> : boldify(line);
        return (
          <span key={i}>
            {content}
            {i < lines.length - 1 ? "\n" : null}
          </span>
        );
      })}
    </p>
  );
}

/** «a **b** c» → a, <b>b</b>, c. Непарная звёздочка остаётся текстом. */
function boldify(line: string): ReactNode[] {
  const parts = line.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part));
}
