import { useI18n } from "../lib/i18n";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    const cancel = (e: Event) => {
      e.preventDefault();
      close.current();
    };
    el?.addEventListener("cancel", cancel);
    return () => {
      el?.removeEventListener("cancel", cancel);
      el?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? "wide" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <span className="eyebrow">LAST MILE / COMMAND</span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label={t("ui.close")}
        >
          <X size={19} />
        </button>
      </div>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
