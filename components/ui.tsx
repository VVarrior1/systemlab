"use client";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";

export function Tip({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip.Provider delayDuration={250}><Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={6}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root></Tooltip.Provider>;
}
export function Modal({ open, onOpenChange, title, description, children, wide = false }: { open: boolean; onOpenChange: (value: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className={`modal ${wide ? "modal-wide" : ""}`} aria-describedby={description ? undefined : undefined}><div className="modal-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close dialog"><X size={18} /></Dialog.Close></div><Dialog.Description className={description ? "modal-description" : "sr-only"}>{description || title}</Dialog.Description>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}

/**
 * ARIA tabs pattern: props for one tab in a tablist with a roving tabindex. Arrow keys move
 * between tabs (and select them), Home and End jump to the ends. Panels use `tabPanelProps`.
 */
export function tabProps<T extends string>(prefix: string, ids: readonly T[], id: T, active: T, select: (id: T) => void) {
  const selected = id === active;
  return {
    role: "tab" as const,
    id: `${prefix}-tab-${id}`,
    "aria-selected": selected,
    "aria-controls": selected ? `${prefix}-panel-${id}` : undefined,
    tabIndex: selected ? 0 : -1,
    onClick: () => select(id),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const index = ids.indexOf(id);
      const target = event.key === "ArrowRight" ? ids[(index + 1) % ids.length]
        : event.key === "ArrowLeft" ? ids[(index - 1 + ids.length) % ids.length]
          : event.key === "Home" ? ids[0] : event.key === "End" ? ids[ids.length - 1] : undefined;
      if (target === undefined) return;
      event.preventDefault();
      select(target);
      document.getElementById(`${prefix}-tab-${target}`)?.focus();
    },
  };
}

export function tabPanelProps(prefix: string, id: string) {
  return { role: "tabpanel" as const, id: `${prefix}-panel-${id}`, "aria-labelledby": `${prefix}-tab-${id}`, tabIndex: 0 };
}
