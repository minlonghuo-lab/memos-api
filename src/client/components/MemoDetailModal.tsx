import { useEffect } from "react";
import { createPortal } from "react-dom";
import MemoDetailContent from "./MemoDetailContent";

interface Props {
  memoId: MemoId;
  onClose: () => void;
}

const MemoDetailModal: React.FC<Props> = ({ memoId, onClose }) => {
  useEffect(() => {
    const prevBodyOverflow = document.body.style.overflow;
    const prevBodyPaddingRight = document.body.style.paddingRight;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.paddingRight = prevBodyPaddingRight;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/60 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-8">
        <div className="mx-auto w-full max-w-4xl" onMouseDown={(event) => event.stopPropagation()}>
          <div className="overflow-hidden rounded-[1.25rem] border border-white/50 bg-zinc-100 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <MemoDetailContent memoId={memoId} mode="modal" onClose={onClose} />
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default MemoDetailModal;
