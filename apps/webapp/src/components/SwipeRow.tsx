import { useRef, useState, type ReactNode } from "react";
import { haptic } from "../telegram";

const ACTIONS_WIDTH = 132;

interface Props {
  children: ReactNode;
  onTap: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** Свайп влево открывает действия (как в чатах Telegram); тап — обычное действие. */
export function SwipeRow({ children, onTap, onEdit, onDelete }: Props) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; baseDx: number; horizontal: boolean | null }>({
    x: 0,
    y: 0,
    baseDx: 0,
    horizontal: null
  });

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    start.current = { x: t.clientX, y: t.clientY, baseDx: dx, horizontal: null };
    setDragging(true);
  }

  function onTouchMove(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    const moveX = t.clientX - start.current.x;
    const moveY = t.clientY - start.current.y;
    // Определяем направление жеста один раз: вертикаль — отдаём скроллу
    if (start.current.horizontal === null && (Math.abs(moveX) > 8 || Math.abs(moveY) > 8)) {
      start.current.horizontal = Math.abs(moveX) > Math.abs(moveY);
    }
    if (!start.current.horizontal) return;
    const next = Math.min(0, Math.max(-ACTIONS_WIDTH - 24, start.current.baseDx + moveX));
    setDx(next);
  }

  function onTouchEnd() {
    setDragging(false);
    const willOpen = dx < -ACTIONS_WIDTH / 2;
    if (willOpen && start.current.baseDx === 0) haptic("light");
    setDx(willOpen ? -ACTIONS_WIDTH : 0);
    start.current.horizontal = null;
  }

  function handleTap() {
    if (dx !== 0) {
      setDx(0); // открытые действия — тап закрывает
      return;
    }
    onTap();
  }

  return (
    <div className="swipe-wrap">
      <div className="swipe-actions" style={{ width: ACTIONS_WIDTH }}>
        <button
          className="swipe-btn swipe-edit"
          onClick={() => {
            setDx(0);
            onEdit();
          }}
        >
          ✏️<span>Изменить</span>
        </button>
        <button
          className="swipe-btn swipe-delete"
          onClick={() => {
            setDx(0);
            onDelete();
          }}
        >
          🗑<span>Удалить</span>
        </button>
      </div>
      <div
        className="swipe-content"
        style={{ transform: `translateX(${dx}px)`, transition: dragging ? "none" : "transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={handleTap}
      >
        {children}
      </div>
    </div>
  );
}
