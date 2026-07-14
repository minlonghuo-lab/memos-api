export function buildTelegramApiUrl(botTokenOrBaseUrl, method) {
  const rawValue = typeof botTokenOrBaseUrl === 'string' ? botTokenOrBaseUrl.trim() : '';
  if (!rawValue) {
    return null;
  }

  const normalizedMethod = typeof method === 'string' ? method.trim().replace(/^\/+/, '') : '';
  if (!normalizedMethod) {
    return null;
  }

  if (/^https?:\/\//i.test(rawValue)) {
    return `${rawValue.replace(/\/+$/, '')}/${normalizedMethod}`;
  }

  const normalizedToken = rawValue.startsWith('bot') ? rawValue.slice(3) : rawValue;
  return `https://api.telegram.org/bot${normalizedToken}/${normalizedMethod}`;
}

export async function callTelegramApi(botTokenOrBaseUrl, method, payload) {
  const telegramApiUrl = buildTelegramApiUrl(botTokenOrBaseUrl, method);
  if (!telegramApiUrl) {
    throw new Error('Telegram bot token is not configured');
  }

  const response = await fetch(telegramApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  let result = null;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error(`Telegram API ${method} returned a non-JSON response`);
  }

  if (!response.ok || result?.ok === false) {
    const description = result?.description || `${response.status} ${response.statusText}`;
    throw new Error(`Telegram API ${method} failed: ${description}`);
  }

  return result;
}

export async function sendTelegramText(botTokenOrBaseUrl, chatId, text, extraPayload = {}) {
  return callTelegramApi(botTokenOrBaseUrl, 'sendMessage', {
    chat_id: chatId,
    text,
    ...extraPayload,
  });
}
