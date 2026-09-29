// ==UserScript==
// @name         AQW Wiki Copy Join 
// @namespace    https://github.com/soyquetzal/aqw-wiki-gaze
// @version      1.0.0
// @description  Turns the /join commands on AQW Wiki map pages into a box with a one-click copy button.
// @author       soyquetzal
// @license      MIT
// @homepageURL  https://github.com/soyquetzal/aqw-wiki-gaze
// @supportURL   https://github.com/soyquetzal/aqw-wiki-gaze/issues
// @match        https://aqwwiki.wikidot.com/*
// @icon         https://www.aq.com/favicon.ico
// @updateURL    https://raw.githubusercontent.com/soyquetzal/aqw-wiki-gaze/main/aqw-wiki-copy-join.user.js
// @downloadURL  https://raw.githubusercontent.com/soyquetzal/aqw-wiki-gaze/main/aqw-wiki-copy-join.user.js
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==
(function () {
  "use strict";

  // On map pages the command is a plain-text list item with no child
  // elements, e.g. <li>/join arcangrove</li>. Requiring the whole text to be
  // "/command argument" keeps regular sentences untouched.
  const COMMAND_RE = /^\/[a-z]{2,15}\s+\S+$/i;
  const MARK = "aqwCmd";
  const RESET_DELAY_MS = 1_200;

  const LABELS = { copy: "Copy", copied: "Copied!", error: "Error" };

  const root = document.querySelector("#page-content");
  if (!root) return;

  const STYLES = `
    .awc-box {
      display: inline-flex;
      align-items: stretch;
      max-width: 100%;
      overflow: hidden;
      vertical-align: middle;
      border: 1px solid #4b5563;
      border-radius: 5px;
    }

    .awc-text {
      padding: 2px 9px;
      background: #1f2937;
      color: #f9fafb;
      font: 13px/1.6 Consolas, Menlo, monospace;
      overflow-wrap: anywhere;
      user-select: all;
    }

    .awc-btn {
      padding: 2px 10px;
      background: #374151;
      border: 0;
      border-left: 1px solid #4b5563;
      color: #f9fafb;
      font: bold 12px Arial, sans-serif;
      cursor: pointer;
    }

    .awc-btn:hover { background: #4b5563; }
    .awc-btn.ok    { background: #15803d; }
    .awc-btn.err   { background: #b91c1c; }
  `;

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The Clipboard API is unavailable or denied; fall back to execCommand.
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.append(area);
      area.select();

      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {}

      area.remove();
      return copied;
    }
  }

  function createBox(command) {
    const box = document.createElement("span");
    box.className = "awc-box";

    const text = document.createElement("span");
    text.className = "awc-text";
    text.textContent = command;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "awc-btn";
    button.textContent = LABELS.copy;
    button.title = `Copy "${command}"`;

    let resetTimer = null;

    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();

      const success = await copyText(command);

      button.textContent = success ? LABELS.copied : LABELS.error;
      button.classList.toggle("ok", success);
      button.classList.toggle("err", !success);

      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        button.textContent = LABELS.copy;
        button.classList.remove("ok", "err");
      }, RESET_DELAY_MS);
    });

    box.append(text, button);
    return box;
  }

  function enhanceCommands() {
    for (const item of root.querySelectorAll("li")) {
      if (item.children.length || item.dataset[MARK]) continue;

      const command = item.textContent.replace(/\s+/g, " ").trim();
      if (!COMMAND_RE.test(command)) continue;

      item.dataset[MARK] = "1";
      item.replaceChildren(createBox(command));
    }
  }

  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.append(style);

  enhanceCommands();
})();