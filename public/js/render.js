import { selectedGuild, state } from "./state.js";
import { app, escapeHtml } from "./ui.js";
import { renderChannelsPanel, renderServerRail } from "./views/navigation.js";
import { renderMainPanel } from "./views/streams.js";

export function renderLogin(error = "") {
  const message = error ? `<p class="login-error">${escapeHtml(error)}</p>` : "";
  app.innerHTML = `<section class="login-screen">
    <a class="login-button" href="/api/auth/login">
      <svg viewBox="0 0 127.14 96.36" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.87 97.68 97.68 0 0 0-29.16 0A72.37 72.37 0 0 0 45.59 0a105.89 105.89 0 0 0-26.25 8.09C2.73 32.65-1.76 56.6.48 80.21a105.73 105.73 0 0 0 32.16 16.15 77.7 77.7 0 0 0 6.89-11.17 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2.04 20.92 9.78 43.61 9.78 64.28 0 .87.7 1.76 1.38 2.66 2.04a68.68 68.68 0 0 1-10.87 5.19 77.3 77.3 0 0 0 6.89 11.16 105.25 105.25 0 0 0 32.18-16.14c2.63-27.38-4.5-51.11-18.78-72.15ZM42.45 65.69c-6.25 0-11.4-5.7-11.4-12.7 0-7 5.03-12.7 11.4-12.7 6.42 0 11.5 5.75 11.4 12.7 0 7-5.03 12.7-11.4 12.7Zm42.24 0c-6.25 0-11.4-5.7-11.4-12.7 0-7 5.03-12.7 11.4-12.7 6.42 0 11.5 5.75 11.4 12.7 0 7-4.98 12.7-11.4 12.7Z"/></svg>
      <span>log in with discord</span>
    </a>
    ${message}
  </section>`;
}

export function renderShell() {
  const guild = selectedGuild();
  const hasChannelsPanel = Boolean(guild?.botAdded);
  const serverList = app.querySelector(".server-list");
  const serverScrollTop = serverList?.scrollTop ?? 0;
  const serverScrollLeft = serverList?.scrollLeft ?? 0;
  app.innerHTML = `<section class="layout" data-mobile-view="${state.mobileView}" data-has-guild="${hasChannelsPanel}">
    <div class="workspace" data-has-guild="${hasChannelsPanel}">${renderServerRail()}${renderChannelsPanel()}${renderMainPanel()}</div>
  </section>`;
  const updatedServerList = app.querySelector(".server-list");
  updatedServerList.scrollTop = serverScrollTop;
  updatedServerList.scrollLeft = serverScrollLeft;
}
