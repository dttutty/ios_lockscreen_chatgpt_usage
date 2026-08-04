// iOS Lockscreen ChatGPT Usage
// Run this script once inside Scriptable to save the API URL and token.

const SETTINGS_KEY = "ios-lockscreen-chatgpt-usage.settings.v1";
const CACHE_KEY = "ios-lockscreen-chatgpt-usage.cache.v1";
const REFRESH_MINUTES = 15;

let settings = loadKeychainJSON(SETTINGS_KEY);
let mode = widgetMode(args.widgetParameter);
if (config.runsInApp) {
  const prepared = await prepareSettings(settings, mode);
  settings = prepared.settings;
  mode = prepared.mode;
}

const widget = await buildWidget(settings, mode);
widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
widget.addAccessoryWidgetBackground = true;
widget.setPadding(
  mode === "combined" ? 4 : 2,
  mode === "combined" ? 8 : 3,
  mode === "combined" ? 4 : 2,
  mode === "combined" ? 8 : 3
);

Script.setWidget(widget);
if (config.runsInApp) {
  if (mode === "combined") {
    await widget.presentAccessoryRectangular();
  } else {
    await widget.presentAccessoryCircular();
  }
}
Script.complete();

async function prepareSettings(existing, currentMode) {
  if (!existing) {
    return { settings: await configure(existing), mode: currentMode };
  }

  const menu = new Alert();
  menu.title = "ChatGPT Usage";
  menu.message = "Choose a preview or update the server connection.";
  menu.addAction("Preview Weekly Circle");
  menu.addAction("Preview 5-Hour Circle");
  menu.addAction("Preview Combined Rectangle");
  menu.addAction("Edit Configuration");
  menu.addCancelAction("Cancel");
  const choice = await menu.presentSheet();
  if (choice === 0) return { settings: existing, mode: "weekly" };
  if (choice === 1) return { settings: existing, mode: "short" };
  if (choice === 2) return { settings: existing, mode: "combined" };
  if (choice === 3) {
    return { settings: await configure(existing), mode: currentMode };
  }
  return { settings: existing, mode: currentMode };
}

async function configure(existing) {
  const alert = new Alert();
  alert.title = "Connect to Usage Service";
  alert.message =
    "Settings are stored only in the Scriptable Keychain. The API URL must use HTTPS.";
  alert.addTextField(
    "https://usage.example.com/v1/usage",
    existing?.url || ""
  );
  alert.addSecureTextField("Bearer Token", existing?.token || "");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  const choice = await alert.presentAlert();
  if (choice === -1) {
    return existing;
  }

  const url = alert.textFieldValue(0).trim();
  const token = alert.textFieldValue(1).trim();
  if (!url.startsWith("https://") || token.length < 32) {
    const invalid = new Alert();
    invalid.title = "Invalid Configuration";
    invalid.message =
      "Enter an HTTPS API URL and a random Token containing at least 32 characters.";
    invalid.addAction("OK");
    await invalid.presentAlert();
    return existing;
  }

  const next = { url, token };
  Keychain.set(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

async function buildWidget(currentSettings, currentMode) {
  const resultWidget = new ListWidget();
  if (!currentSettings) {
    renderStatus(resultWidget, currentMode, "SETUP", "RUN", "SCRIPT");
    return resultWidget;
  }

  try {
    const data = await fetchUsage(currentSettings);
    Keychain.set(CACHE_KEY, JSON.stringify(data));
    renderUsage(resultWidget, data, false, currentMode);
  } catch (error) {
    const cached = loadKeychainJSON(CACHE_KEY);
    if (cached) {
      renderUsage(resultWidget, cached, true, currentMode);
    } else if (currentMode === "combined") {
      addMessage(resultWidget, "ChatGPT Usage Unavailable", shortError(error));
    } else {
      renderStatus(resultWidget, currentMode, "USAGE", "—", "ERROR");
    }
  }
  return resultWidget;
}

async function fetchUsage(currentSettings) {
  const request = new Request(currentSettings.url);
  request.method = "GET";
  request.headers = {
    Authorization: `Bearer ${currentSettings.token}`,
    Accept: "application/json",
  };
  request.timeoutInterval = 10;
  const data = await request.loadJSON();
  const status = request.response?.statusCode || 0;
  if (status !== 200) {
    throw new Error(`HTTP ${status}`);
  }
  if (!data.primary && !data.secondary) {
    throw new Error("The server returned no usable rate-limit windows");
  }
  return data;
}

function renderUsage(resultWidget, data, fromPhoneCache, currentMode) {
  const windows = sortedWindows(data);
  const isCached = fromPhoneCache || data.stale;
  if (currentMode === "combined") {
    renderCombined(resultWidget, windows, isCached);
    return;
  }

  const window = selectWindow(windows, currentMode);
  if (!window) {
    const expectedLabel = currentMode === "short" ? "5H LEFT" : "1W LEFT";
    renderCircle(resultWidget, expectedLabel, "—", "N/A");
    return;
  }

  const label = `${durationLabel(window.windowDurationMins)} LEFT`;
  const value = `${remainingPercent(window.usedPercent)}%`;
  const detail = isCached ? "CACHED" : formatCircleReset(window.resetsAt);
  renderCircle(resultWidget, label, value, detail);
}

function renderCombined(resultWidget, windows, isCached) {
  if (windows.length === 0) {
    addMessage(resultWidget, "ChatGPT Usage", "No rate-limit windows available");
    return;
  }

  if (windows.length === 1) {
    const window = windows[0];
    const title = resultWidget.addText(
      `${durationLabel(window.windowDurationMins)} REMAINING  ${remainingPercent(
        window.usedPercent
      )}%`
    );
    title.font = Font.semiboldSystemFont(13);
    title.lineLimit = 1;
    title.minimumScaleFactor = 0.65;

    resultWidget.addSpacer(2);

    const prefix = isCached ? "CACHED · " : "";
    const reset = resultWidget.addText(
      `${prefix}RESET ${formatReset(window.resetsAt)}`
    );
    reset.font = Font.systemFont(10);
    reset.lineLimit = 1;
    reset.minimumScaleFactor = 0.65;
    reset.textOpacity = 0.8;
    return;
  }

  windows.slice(0, 2).forEach((window, index) => {
    const row = resultWidget.addText(
      `${durationLabel(window.windowDurationMins)}  ${remainingPercent(
        window.usedPercent
      )}% LEFT  ·  ${formatReset(window.resetsAt)}`
    );
    row.font = Font.semiboldSystemFont(index === 0 ? 12 : 11);
    row.lineLimit = 1;
    row.minimumScaleFactor = 0.55;
    if (index === 1 && isCached) row.textOpacity = 0.75;
    if (index === 0) resultWidget.addSpacer(2);
  });
}

function renderCircle(resultWidget, labelText, valueText, detailText) {
  resultWidget.addSpacer();

  const label = resultWidget.addText(labelText);
  label.font = Font.semiboldSystemFont(9);
  label.lineLimit = 1;
  label.minimumScaleFactor = 0.7;
  label.centerAlignText();

  const value = resultWidget.addText(valueText);
  value.font = Font.boldSystemFont(18);
  value.lineLimit = 1;
  value.minimumScaleFactor = 0.65;
  value.centerAlignText();

  const detail = resultWidget.addText(detailText);
  detail.font = Font.semiboldSystemFont(8);
  detail.lineLimit = 1;
  detail.minimumScaleFactor = 0.7;
  detail.textOpacity = 0.78;
  detail.centerAlignText();

  resultWidget.addSpacer();
}

function renderStatus(resultWidget, currentMode, label, value, detail) {
  if (currentMode === "combined") {
    addMessage(resultWidget, label, `${value} ${detail}`);
  } else {
    renderCircle(resultWidget, label, value, detail);
  }
}

function addMessage(resultWidget, titleText, detailText) {
  const title = resultWidget.addText(titleText);
  title.font = Font.semiboldSystemFont(12);
  title.lineLimit = 1;
  resultWidget.addSpacer(2);
  const detail = resultWidget.addText(detailText);
  detail.font = Font.systemFont(9);
  detail.lineLimit = 1;
  detail.minimumScaleFactor = 0.6;
}

function widgetMode(parameter) {
  const value = String(parameter || "").trim().toLowerCase();
  if (["weekly", "week", "1w", "7d", "long"].includes(value)) {
    return "weekly";
  }
  if (["short", "5h"].includes(value)) {
    return "short";
  }
  if (!value && config.widgetFamily === "accessoryCircular") {
    return "weekly";
  }
  return "combined";
}

function sortedWindows(data) {
  return [data.primary, data.secondary]
    .filter(Boolean)
    .sort((a, b) => a.windowDurationMins - b.windowDurationMins);
}

function selectWindow(windows, currentMode) {
  if (windows.length === 0) return null;
  if (currentMode === "weekly") {
    return windows[windows.length - 1];
  }
  return windows.find((window) => window.windowDurationMins < 1440) || null;
}

function remainingPercent(usedPercent) {
  return Math.max(0, Math.min(100, Math.round(100 - Number(usedPercent))));
}

function durationLabel(minutes) {
  if (minutes % 10080 === 0) return `${minutes / 10080}W`;
  if (minutes % 1440 === 0) return `${minutes / 1440}D`;
  if (minutes % 60 === 0) return `${minutes / 60}H`;
  return `${minutes}M`;
}

function formatReset(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const formatter = new DateFormatter();
  const withinOneDay = date.getTime() - Date.now() < 24 * 60 * 60 * 1000;
  formatter.dateFormat = withinOneDay ? "HH:mm" : "E HH:mm";
  return formatter.string(date).toUpperCase();
}

function formatCircleReset(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const formatter = new DateFormatter();
  const withinOneDay = date.getTime() - Date.now() < 24 * 60 * 60 * 1000;
  formatter.dateFormat = withinOneDay ? "HH:mm" : "EEE";
  return formatter.string(date).toUpperCase();
}

function loadKeychainJSON(key) {
  if (!Keychain.contains(key)) return null;
  try {
    return JSON.parse(Keychain.get(key));
  } catch (_) {
    return null;
  }
}

function shortError(error) {
  const text = String(error);
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}
