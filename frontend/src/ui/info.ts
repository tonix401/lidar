// Info icons: explanations stay out of the panel until the ⓘ next to a control is hovered or clicked.
// One floating box (#infoTip, position: fixed, so the scrolling panel doesn't clip it) shows the icon's
// data-tip; a click pins it until the next click elsewhere.
import { el } from "./dom";

/** an ⓘ icon with `text` as its explanation (change it later with setInfo) */
export function info(text: string): HTMLSpanElement {
  const i = el("span", { className: "info", textContent: "i", tabIndex: 0 });
  i.dataset.tip = text;
  i.setAttribute("role", "button");
  i.setAttribute("aria-label", text);
  return i;
}

export function setInfo(icon: HTMLElement, text: string): void {
  icon.dataset.tip = text;
  icon.setAttribute("aria-label", text);
  if (pinned === icon || hovered === icon) show(icon);
}

let box: HTMLElement | null = null, pinned: HTMLElement | null = null, hovered: HTMLElement | null = null;

function show(icon: HTMLElement): void {
  box ??= document.body.appendChild(el("div", { id: "infoTip", hidden: true }));
  box.textContent = icon.dataset.tip ?? "";
  box.hidden = false;
  const r = icon.getBoundingClientRect(), w = Math.min(300, innerWidth - 16);
  box.style.maxWidth = w + "px";
  box.style.left = Math.max(8, Math.min(r.left - 8, innerWidth - w - 8)) + "px";
  const below = r.bottom + 6, h = box.offsetHeight;
  box.style.top = (below + h > innerHeight - 8 ? Math.max(8, r.top - 6 - h) : below) + "px";
}

function hide(): void { if (box) box.hidden = true; }

const iconOf = (t: EventTarget | null) => t instanceof Element ? t.closest<HTMLElement>(".info") : null;

/** delegated listeners for every .info icon, present or added later */
export function bindInfoIcons(root: Document = document): void {
  root.addEventListener("mouseover", e => { const i = iconOf(e.target); if (i && i !== hovered) { hovered = i; show(i); } });
  root.addEventListener("mouseout", e => {
    const i = iconOf(e.target);
    if (i && i === hovered && !i.contains(e.relatedTarget as Node | null)) { hovered = null; pinned ? show(pinned) : hide(); }
  });
  root.addEventListener("click", e => {
    const i = iconOf(e.target);
    if (i) { e.preventDefault(); e.stopPropagation(); pinned = pinned === i ? null : i; pinned ? show(i) : hide(); }
    else if (pinned) { pinned = null; hide(); }
  }, true);
  root.addEventListener("keydown", e => {
    const i = iconOf(e.target);
    if (i && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pinned = pinned === i ? null : i; pinned ? show(i) : hide(); }
    else if (e.key === "Escape" && pinned) { pinned = null; hide(); }
  });
}
