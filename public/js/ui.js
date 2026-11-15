export const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

export const icons = {
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
  logout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5"></path><path d="M15 12H3"></path><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"></path></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
  caretDown: '<svg viewBox="0 0 15 15" aria-hidden="true"><path d="M3.135 6.158a.5.5 0 0 1 .707-.023L7.5 9.56l3.658-3.425a.5.5 0 1 1 .684.73l-4 3.75a.5.5 0 0 1-.684 0l-4-3.75a.5.5 0 0 1-.023-.707Z"></path></svg>',
  caretRight: '<svg viewBox="0 0 15 15" aria-hidden="true"><path d="M6.158 3.135a.5.5 0 0 1 .707-.023l3.75 4a.5.5 0 0 1 0 .684l-3.75 4a.5.5 0 1 1-.73-.684L9.56 7.5 6.135 3.842a.5.5 0 0 1 .023-.707Z"></path></svg>',
};

let toastTimer;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

export function shortName(name) {
  return String(name ?? "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

export function showToast(message) {
  toast.textContent = message;
  toast.dataset.visible = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.dataset.visible = "false"; }, 2200);
}

export async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const field = document.createElement("textarea");
    field.value = url;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  showToast("Copied to clipboard");
}
