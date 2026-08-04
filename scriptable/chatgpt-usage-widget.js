// iOS Lockscreen ChatGPT Usage
// Run this script once inside Scriptable to save the API URL and token.

const SETTINGS_KEY = "ios-lockscreen-chatgpt-usage.settings.v1";
const CACHE_KEY = "ios-lockscreen-chatgpt-usage.cache.v1";
const REFRESH_MINUTES = 15;

let settings = loadKeychainJSON(SETTINGS_KEY);
if (config.runsInApp) {
  settings = await prepareSettings(settings);
}

const widget = await buildWidget(settings);
widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
widget.addAccessoryWidgetBackground = true;
widget.setPadding(4, 8, 4, 8);

Script.setWidget(widget);
if (config.runsInApp) {
  await widget.presentAccessoryRectangular();
}
Script.complete();

async function prepareSettings(existing) {
  if (!existing) {
    return await configure(existing);
  }

  const menu = new Alert();
  menu.title = "ChatGPT Usage";
  menu.message = "Preview the widget or update the server connection.";
  menu.addAction("Preview");
  menu.addAction("Edit Configuration");
  menu.addCancelAction("Cancel");
  const choice = await menu.presentSheet();
  if (choice === 1) {
    return await configure(existing);
  }
  return existing;
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

async function buildWidget(currentSettings) {
  const resultWidget = new ListWidget();
  if (!currentSettings) {
    addMessage(
      resultWidget,
      "ChatGPT Usage",
      "Run this script in Scriptable to complete setup"
    );
    return resultWidget;
  }

  try {
    const data = await fetchUsage(currentSettings);
    Keychain.set(CACHE_KEY, JSON.stringify(data));
    renderUsage(resultWidget, data, false);
  } catch (error) {
    const cached = loadKeychainJSON(CACHE_KEY);
    if (cached) {
      renderUsage(resultWidget, cached, true);
    } else {
      addMessage(resultWidget, "ChatGPT Usage Unavailable", shortError(error));
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

function renderUsage(resultWidget, data, fromPhoneCache) {
  const windows = [data.primary, data.secondary]
    .filter(Boolean)
    .map((window) => ({ label: durationLabel(window.windowDurationMins), window }));

  const usage = windows
    .map(({ label, window }) => `${label} ${Math.round(window.usedPercent)}%`)
    .join(" · ");
  const title = resultWidget.addText(`ChatGPT ${usage}`);
  title.font = Font.semiboldSystemFont(13);
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.55;

  resultWidget.addSpacer(2);

  const resetParts = windows.map(
    ({ label, window }) => `${label} ${formatReset(window.resetsAt)}`
  );
  let detail = resetParts.join(" · ");
  if (fromPhoneCache || data.stale) {
    detail = `Cached · ${detail}`;
  }
  const reset = resultWidget.addText(detail);
  reset.font = Font.systemFont(10);
  reset.lineLimit = 1;
  reset.minimumScaleFactor = 0.55;
  reset.textOpacity = 0.8;
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

function durationLabel(minutes) {
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatReset(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const formatter = new DateFormatter();
  const withinOneDay = date.getTime() - Date.now() < 24 * 60 * 60 * 1000;
  formatter.dateFormat = withinOneDay ? "HH:mm" : "E HH:mm";
  return formatter.string(date);
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
