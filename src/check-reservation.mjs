#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_CANDIDATES = [
  DEFAULT_CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

const AVAILABLE_SYMBOLS = new Set(["◎", "○"]);
const UNAVAILABLE_SYMBOLS = new Set(["×", "-"]);
const SLOT_SYMBOLS = new Set([
  ...AVAILABLE_SYMBOLS,
  ...UNAVAILABLE_SYMBOLS,
]);

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    if (typeof WebSocket === "undefined") {
      throw new Error("This Node.js runtime does not provide WebSocket.");
    }

    this.socket = new WebSocket(this.wsUrl);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out connecting to Chrome DevTools."));
      }, 10_000);

      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Failed to connect to Chrome DevTools."));
        },
        { once: true },
      );
    });

    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(String(raw));
    if (!message.id) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result ?? {});
  }

  send(method, params = {}, sessionId = undefined) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome DevTools socket is not open.");
    }

    const id = this.nextId;
    this.nextId += 1;

    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    this.socket.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out on CDP command ${method}.`));
      }, 15_000);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close() {
    if (this.socket) {
      this.socket.close();
    }
  }
}

export function loadDotEnv(envFile = path.join(ROOT, ".env")) {
  if (!existsSync(envFile)) {
    return {};
  }

  const text = existsSync(envFile)
    ? readFile(envFile, "utf8").catch(() => "")
    : Promise.resolve("");

  return text.then((contents) => {
    const parsed = {};
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) {
        continue;
      }

      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      parsed[key] = value;
    }

    return parsed;
  });
}

export function normalizeLines(text) {
  return text
    .replace(/\u200b/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function stripLegend(lines) {
  let legendStart = -1;

  lines.forEach((line, index) => {
    const previous = lines[index - 1] ?? "";
    const compact = line.replace(/\s+/g, "");
    if (compact === "◎予約できます" || compact === "○予約できます") {
      legendStart = index;
    } else if (line.includes("予約できます") && AVAILABLE_SYMBOLS.has(previous)) {
      legendStart = index - 1;
    }
  });

  if (legendStart < 0) {
    return lines;
  }

  return lines.slice(0, legendStart);
}

export function detectAvailability(text) {
  const lines = normalizeLines(text);
  const scheduleLines = stripLegend(lines);
  const times = extractTimes(scheduleLines);
  const slots = extractSlots(scheduleLines, times).filter((slot) =>
    AVAILABLE_SYMBOLS.has(slot.symbol),
  );
  const scheduleText = scheduleLines.join("\n");
  const hasRawAvailableSymbol = [...AVAILABLE_SYMBOLS].some((symbol) =>
    scheduleText.includes(symbol),
  );

  if (slots.length > 0) {
    return {
      available: true,
      reason: "available-slot",
      slots,
      scheduleText,
    };
  }

  if (hasRawAvailableSymbol) {
    return {
      available: true,
      reason: "available-symbol",
      slots: [],
      scheduleText,
    };
  }

  return {
    available: false,
    reason: "no-available-slot",
    slots: [],
    scheduleText,
  };
}

function extractTimes(lines) {
  const times = [];
  for (const line of lines) {
    if (isDateLine(line)) {
      break;
    }
    if (/^\d{1,2}:\d{2}$/.test(line)) {
      times.push(line);
    }
  }

  if (times.length > 0) {
    return times;
  }

  return lines
    .filter((line) => /^\d{1,2}:\d{2}$/.test(line))
    .slice(0, 24);
}

function extractSlots(lines, times) {
  const slots = [];

  for (let index = 0; index < lines.length; index += 1) {
    const combined = parseCombinedDateLine(lines[index]);
    const lineIsDate = isDateLine(lines[index]);
    if (!combined && !lineIsDate) {
      slots.push(...extractInlineSlots(lines[index], times));
      continue;
    }

    const date = combined?.date ?? lines[index];
    let day = combined?.day ?? "";
    let cursor = index + 1;
    const inlineTail = combined ? lines[index].slice(combined.raw.length) : "";
    const symbols = [...slotTokens(inlineTail)];

    if (!day && isDayLine(lines[cursor] ?? "")) {
      day = lines[cursor];
      cursor += 1;
    }

    while (cursor < lines.length && symbols.length < Math.max(times.length, 1)) {
      const tokens = slotTokens(lines[cursor]);
      if (tokens.length === 0) {
        break;
      }
      symbols.push(...tokens);
      cursor += 1;
    }

    symbols.forEach((symbol, slotIndex) => {
      slots.push({
        date,
        day,
        time: times[slotIndex] ?? `slot-${slotIndex + 1}`,
        symbol,
      });
    });
  }

  return slots;
}

function extractInlineSlots(line, times) {
  const combined = parseCombinedDateLine(line);
  if (!combined) {
    return [];
  }

  const afterDate = line.slice(combined.raw.length).trim();
  const symbols = slotTokens(afterDate);
  return symbols.map((symbol, index) => ({
    date: combined.date,
    day: combined.day,
    time: times[index] ?? `slot-${index + 1}`,
    symbol,
  }));
}

function parseCombinedDateLine(line) {
  const match = line.match(
    /^(\d{1,4}\/\d{1,2}(?:\/\d{1,2})?)\s*([（(][月火水木金土日][）)])?/,
  );
  if (!match || !match[2]) {
    return null;
  }

  return {
    raw: match[0],
    date: match[1],
    day: match[2],
  };
}

function isDateLine(line) {
  return /^(\d{1,4}\/)?\d{1,2}\/\d{1,2}$/.test(line);
}

function isDayLine(line) {
  return /^[（(][月火水木金土日][）)]$/.test(line);
}

function slotTokens(line) {
  const normalized = line.replace(/[−ー]/g, "-").trim();
  if (!normalized) {
    return [];
  }

  const spaced = normalized.split(/\s+/);
  if (spaced.every((token) => SLOT_SYMBOLS.has(token))) {
    return spaced;
  }

  if (/^[◎○×-]+$/.test(normalized)) {
    return [...normalized].filter((token) => SLOT_SYMBOLS.has(token));
  }

  return [];
}

export function buildNotificationMessage({ detection, url, checkedAt }) {
  const checkedAtText = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(checkedAt);

  const slotLines = detection.slots.length
    ? detection.slots
        .slice(0, 12)
        .map((slot) =>
          [slot.date, slot.day, slot.time, slot.symbol].filter(Boolean).join(" "),
        )
    : ["予約表内に空き記号を検知しました。ページを確認してください。"];

  const extra = detection.slots.length > 12
    ? `\nほか ${detection.slots.length - 12} 件`
    : "";

  return [
    "Medical Forceの予約枠に空きが出ました。",
    "",
    ...slotLines,
    extra,
    "",
    url,
    "",
    `確認時刻: ${checkedAtText}`,
  ]
    .filter((line) => line !== "")
    .join("\n")
    .slice(0, 1900);
}

export function buildTestNotificationMessage({ detection, checkedAt }) {
  const checkedAtText = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(checkedAt);

  return [
    "Medical Force予約監視のテスト通知です。",
    `現在の判定: ${detection.available ? "空きあり" : "空きなし"}`,
    `理由: ${detection.reason}`,
    `確認時刻: ${checkedAtText}`,
  ].join("\n");
}

export function buildSignatures(detection) {
  if (detection.slots.length > 0) {
    return detection.slots.map((slot) =>
      [slot.date, slot.day, slot.time, slot.symbol].join("|"),
    );
  }

  const hash = crypto
    .createHash("sha256")
    .update(detection.scheduleText)
    .digest("hex")
    .slice(0, 16);
  return [`available-symbol:${hash}`];
}

async function scrapeRenderedText(url, config) {
  const chromePath = resolveChromePath(config.chromePath);

  const port = await getFreePort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "medical-force-watch-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "about:blank",
  ];

  const chrome = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let chromeError = "";
  chrome.stderr.on("data", (chunk) => {
    chromeError += String(chunk).slice(0, 2000);
  });

  let client = null;
  try {
    const version = await waitForJson(
      `http://127.0.0.1:${port}/json/version`,
      15_000,
    );
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.connect();

    const target = await client.send("Target.createTarget", { url: "about:blank" });
    const attached = await client.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;

    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Page.navigate", { url }, sessionId);

    if (config.clickTexts.length > 0) {
      for (const clickText of config.clickTexts) {
        await waitForBodyText(client, sessionId, clickText, 20_000);
        await clickByText(client, sessionId, clickText);
        await delay(900);
      }
    } else if (config.menuTexts.length > 0) {
      for (const menuText of config.menuTexts) {
        await waitForBodyText(client, sessionId, menuText, 20_000);
        await clickByText(client, sessionId, menuText);
        await delay(800);
      }

      if (config.confirmText) {
        await clickByText(client, sessionId, config.confirmText);
        await delay(1200);
      }
    }

    const scheduleTexts = [await waitForPageText(client, sessionId, config)];
    for (let index = 0; index < config.scanNextCount; index += 1) {
      const clicked = await clickFirstByText(client, sessionId, config.nextWeekTexts);
      if (!clicked) {
        break;
      }

      await waitForBodyTextChange(client, sessionId, scheduleTexts.at(-1), 8000).catch(
        () => {},
      );
      await delay(config.pageSettleMs);
      scheduleTexts.push(await waitForPageText(client, sessionId, config));
    }

    return scheduleTexts.join("\n\n--- next schedule page ---\n\n");
  } catch (error) {
    const suffix = config.debugLogs && chromeError ? ` Chrome stderr: ${chromeError}` : "";
    throw new Error(`${error.message}${suffix}`);
  } finally {
    if (client) {
      await client.send("Browser.close").catch(() => {});
      client.close();
    }
    if (!chrome.killed) {
      chrome.kill("SIGTERM");
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveChromePath(configuredPath) {
  if (configuredPath) {
    if (existsSync(configuredPath)) {
      return configuredPath;
    }
    throw new Error(`Chrome executable not found: ${configuredPath}`);
  }

  const detectedPath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (detectedPath) {
    return detectedPath;
  }

  throw new Error(
    `Chrome executable not found. Tried: ${CHROME_CANDIDATES.join(", ")}`,
  );
}

async function waitForPageText(client, sessionId, config) {
  const deadline = Date.now() + config.checkTimeoutMs;
  let lastText = "";

  while (Date.now() < deadline) {
    await delay(1000);
    const text = await readBodyText(client, sessionId);
    lastText = text || lastText;

    if (looksLikeReservationTable(text)) {
      await delay(config.pageSettleMs);
      return (await readBodyText(client, sessionId)) || text;
    }
  }

  return lastText;
}

async function waitForBodyText(client, sessionId, expectedText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";

  while (Date.now() < deadline) {
    const text = await readBodyText(client, sessionId);
    lastText = text;
    if (text.includes(expectedText)) {
      return text;
    }
    await delay(500);
  }

  throw new Error(
    `Could not find text "${expectedText}" on the page before timeout.`,
  );
}

async function waitForBodyTextChange(client, sessionId, previousText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const text = await readBodyText(client, sessionId);
    if (text && text !== previousText) {
      return text;
    }
    await delay(500);
  }

  throw new Error("Page text did not change before timeout.");
}

async function clickFirstByText(client, sessionId, texts) {
  for (const text of texts) {
    try {
      await clickByText(client, sessionId, text);
      return true;
    } catch {
      // Try the next configured label.
    }
  }

  return false;
}

async function clickByText(client, sessionId, text) {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const needle = ${JSON.stringify(text)};
        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const findClickable = (element) => {
          for (let current = element; current && current !== document.body; current = current.parentElement) {
            const style = window.getComputedStyle(current);
            if (
              current.matches("button, [role='button'], a, label, input, summary") ||
              style.cursor === "pointer"
            ) {
              return current;
            }
          }
          return element;
        };
        const elements = Array.from(document.querySelectorAll(
          "button, [role='button'], a, label, input, summary, li, span, p, div"
        ));
        const matches = elements
          .filter((element) => isVisible(element) && normalize(element.innerText).includes(needle))
          .sort((a, b) => normalize(a.innerText).length - normalize(b.innerText).length);
        const target = matches.find((element) => normalize(element.innerText) === needle) || matches[0];
        if (!target) {
          return { clicked: false, reason: "not-found" };
        }
        const clickable = findClickable(target);
        if (clickable.disabled || clickable.getAttribute("aria-disabled") === "true") {
          return {
            clicked: false,
            reason: "disabled",
            text: normalize(clickable.innerText || target.innerText)
          };
        }
        clickable.scrollIntoView({ block: "center", inline: "center" });
        const rect = clickable.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return {
          clicked: true,
          text: normalize(clickable.innerText || target.innerText),
          tag: clickable.tagName,
          x,
          y
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );

  const value = result.result?.value;
  if (!value?.clicked) {
    throw new Error(`Could not click "${text}": ${value?.reason ?? "unknown"}`);
  }

  await client.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: value.x, y: value.y },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: value.x, y: value.y, button: "left", clickCount: 1 },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: value.x, y: value.y, button: "left", clickCount: 1 },
    sessionId,
  );

  return value;
}

async function readBodyText(client, sessionId) {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        if (!document.body) return "";
        window.scrollTo(0, document.body.scrollHeight);
        return document.body.innerText || "";
      })()`,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );

  return String(result.result?.value ?? "");
}

function looksLikeReservationTable(text) {
  return (
    text.includes("予約") &&
    /(\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2})/.test(text) &&
    /[×◎○-]/.test(text)
  );
}

function looksLikeMenuSelection(text) {
  return (
    text.includes("メニューを選択してください") &&
    text.includes("メニューを確定する") &&
    !looksLikeReservationTable(text)
  );
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate a local port."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "no response"}`);
}

async function sendDiscord(webhookUrl, content) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${response.status} ${body}`);
  }
}

async function readState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return { notified: {}, lastCheckedAt: null, lastStatus: "unknown" };
  }
}

async function writeState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const tmpFile = `${stateFile}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpFile, stateFile);
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    noNotify: argv.includes("--no-notify"),
    printText: argv.includes("--print-text"),
  };
}

async function buildConfig(args) {
  const dotEnv = await loadDotEnv();
  const env = { ...dotEnv, ...process.env };
  const clickTexts = splitConfigList(env.CLICK_TEXTS || env.CLICK_TEXT || "");
  const menuTexts = (env.MENU_TEXTS || env.MENU_TEXT || "")
    ? splitConfigList(env.MENU_TEXTS || env.MENU_TEXT || "")
    : [];
  const nextWeekTexts = splitConfigList(
    env.NEXT_WEEK_TEXTS || env.NEXT_WEEK_TEXT || "翌週|次週|次へ",
  );

  return {
    url: env.WATCH_URL || "",
    webhookUrl: env.DISCORD_WEBHOOK_URL || "",
    clickTexts,
    menuTexts,
    confirmText: env.CONFIRM_TEXT === undefined ? "メニューを確定する" : env.CONFIRM_TEXT,
    checkTimeoutMs: Number(env.CHECK_TIMEOUT_MS || 45_000),
    pageSettleMs: Number(env.PAGE_SETTLE_MS || 2500),
    scanNextCount: Number(env.SCAN_NEXT_COUNT || env.NEXT_PAGE_COUNT || 1),
    nextWeekTexts,
    stateFile: path.resolve(ROOT, env.STATE_FILE || "data/notified-slots.json"),
    chromePath: env.CHROME_PATH || "",
    writeStatusState: envFlag(env.WRITE_STATUS_STATE, true),
    debugLogs: envFlag(env.DEBUG_LOGS, false),
    forceNotify: envFlag(env.FORCE_NOTIFY, false),
    dryRun: args.dryRun,
    noNotify: args.noNotify,
    printText: args.printText,
  };
}

function splitConfigList(value) {
  return String(value)
    .split("|")
    .map((text) => text.trim())
    .filter(Boolean);
}

function envFlag(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  return !["", "0", "false", "no", "off"].includes(String(value).toLowerCase());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await buildConfig(args);
  if (!config.url) {
    throw new Error("WATCH_URL is not set.");
  }

  const checkedAt = new Date();
  const text = await scrapeRenderedText(config.url, config);
  if (
    config.clickTexts.length === 0 &&
    config.menuTexts.length === 0 &&
    looksLikeMenuSelection(text)
  ) {
    throw new Error(
      "The page is still on menu selection. Set MENU_TEXTS in .env to the menu label(s) that open the reservation table.",
    );
  }

  const detection = detectAvailability(text);

  if (config.printText) {
    process.stdout.write(`${text}\n`);
  }

  const state = await readState(config.stateFile);

  if (!detection.available) {
    if (config.forceNotify && !config.dryRun && !config.noNotify) {
      if (!config.webhookUrl) {
        throw new Error("DISCORD_WEBHOOK_URL is not set.");
      }
      await sendDiscord(
        config.webhookUrl,
        buildTestNotificationMessage({ detection, checkedAt }),
      );
    }

    if (!config.dryRun && config.writeStatusState) {
      state.lastCheckedAt = checkedAt.toISOString();
      state.lastStatus = detection.reason;
      await writeState(config.stateFile, state);
    }
    console.log(
      JSON.stringify({
        available: false,
        reason: config.forceNotify ? "test-notified" : detection.reason,
      }),
    );
    return;
  }

  const signatures = buildSignatures(detection);
  const notified = state.notified ?? {};
  const freshSignatures = signatures.filter((signature) => !notified[signature]);

  if (freshSignatures.length === 0) {
    if (!config.dryRun && config.writeStatusState) {
      state.lastCheckedAt = checkedAt.toISOString();
      state.lastStatus = detection.reason;
      await writeState(config.stateFile, state);
    }
    console.log(
      JSON.stringify({
        available: true,
        reason: "already-notified",
        slots: detection.slots,
      }),
    );
    return;
  }

  const message = buildNotificationMessage({
    detection,
    url: config.url,
    checkedAt,
  });

  if (!config.dryRun && !config.noNotify) {
    if (!config.webhookUrl) {
      throw new Error("DISCORD_WEBHOOK_URL is not set.");
    }
    await sendDiscord(config.webhookUrl, message);
  }

  if (!config.dryRun) {
    for (const signature of freshSignatures) {
      notified[signature] = checkedAt.toISOString();
    }
    state.notified = notified;
    state.lastCheckedAt = checkedAt.toISOString();
    state.lastStatus = detection.reason;
    await writeState(config.stateFile, state);
  }

  console.log(
    JSON.stringify({
      available: true,
      reason: config.dryRun || config.noNotify ? "detected-no-notify" : "notified",
      slots: detection.slots,
      message,
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
