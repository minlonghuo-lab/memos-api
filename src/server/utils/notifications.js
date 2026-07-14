import { callTelegramApi } from './telegram.js';

const TELEGRAM_MEMO_PREVIEW_LIMIT = 3800;

export const TELEGRAM_VISIBILITY_OPTIONS = ['PRIVATE', 'PROTECTED', 'PUBLIC'];

const TELEGRAM_VISIBILITY_LABELS = {
  PRIVATE: '私密',
  PROTECTED: '受保护',
  PUBLIC: '公开',
};

function truncateTelegramText(text) {
  if (text.length <= TELEGRAM_MEMO_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, TELEGRAM_MEMO_PREVIEW_LIMIT)}\n...`;
}

function getTelegramMemoContent(memoData) {
  const content = typeof memoData?.content === 'string' ? memoData.content.trim() : '';
  if (content) {
    return truncateTelegramText(content);
  }

  if ((memoData?.resourceCount || 0) > 0) {
    return `📎 此 memo 仅包含 ${memoData.resourceCount} 个附件`;
  }

  return '（无文本内容）';
}

export function getTelegramVisibilityLabel(visibility) {
  return TELEGRAM_VISIBILITY_LABELS[visibility] || visibility || '未知';
}

export function buildTelegramMemoVisibilityCallbackData(memoId, visibility) {
  return `memo_visibility:${memoId}:${visibility}`;
}

export function parseTelegramMemoVisibilityCallbackData(data) {
  if (typeof data !== 'string') {
    return null;
  }

  const matched = data.match(/^memo_visibility:(\d+):(PRIVATE|PROTECTED|PUBLIC)$/);
  if (!matched) {
    return null;
  }

  return {
    memoId: Number.parseInt(matched[1], 10),
    visibility: matched[2],
  };
}

export function buildTelegramMemoNotificationText(memoData) {
  return getTelegramMemoContent(memoData);
}

export function buildTelegramMemoReplyMarkup(memoData, instanceUrl) {
  const inlineKeyboard = [
    TELEGRAM_VISIBILITY_OPTIONS.map((visibility) => ({
      text: memoData.visibility === visibility ? `● ${getTelegramVisibilityLabel(visibility)}` : getTelegramVisibilityLabel(visibility),
      callback_data: buildTelegramMemoVisibilityCallbackData(memoData.id, visibility),
    })),
  ];

  if (instanceUrl) {
    inlineKeyboard.push([
      {
        text: '打开 Memo',
        url: `${instanceUrl}/m/${memoData.id}`,
      },
    ]);
  }

  return {
    inline_keyboard: inlineKeyboard,
  };
}

/**
 * 发送 Webhook 通知
 * @param {string} webhookUrl - Webhook URL
 * @param {object} memoData - Memo 数据
 */
export async function sendWebhook(webhookUrl, memoData) {
  if (!webhookUrl || webhookUrl.trim() === '') {
    return;
  }

  try {
    const payload = {
      event: 'memo.created',
      timestamp: Date.now(),
      data: {
        id: memoData.id,
        content: memoData.content,
        visibility: memoData.visibility,
        creator: {
          id: memoData.creatorId,
          username: memoData.creatorUsername,
          name: memoData.creatorName,
        },
        createdTs: memoData.createdTs,
        tags: memoData.tags || [],
        resourceCount: memoData.resourceCount || 0,
      }
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Cloudflare-Memos-Webhook/1.0',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`Webhook failed: ${response.status} ${response.statusText}`);
    } else {
      console.log('Webhook sent successfully');
    }
  } catch (error) {
    console.error('Error sending webhook:', error);
  }
}

/**
 * 发送 Telegram 通知
 * @param {string} botToken - Telegram Bot Token
 * @param {string} chatId - Telegram Chat ID
 * @param {object} memoData - Memo 数据
 * @param {string} instanceUrl - 实例 URL
 */
export async function sendTelegramNotification(botToken, chatId, memoData, instanceUrl) {
  if (!botToken || botToken.trim() === '' || !chatId || chatId.trim() === '') {
    return;
  }

  try {
    const message = buildTelegramMemoNotificationText(memoData);

    const result = await callTelegramApi(botToken, 'sendMessage', {
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
      reply_markup: buildTelegramMemoReplyMarkup(memoData, instanceUrl),
    });

    if (!result.ok) {
      console.error('Telegram notification failed:', result);
    } else {
      console.log('Telegram notification sent successfully');
    }
  } catch (error) {
    console.error('Error sending Telegram notification:', error);
  }
}

export async function editTelegramMemoNotification(botToken, chatId, messageId, memoData, instanceUrl) {
  if (!botToken || !chatId || !messageId) {
    return;
  }

  return callTelegramApi(botToken, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: buildTelegramMemoNotificationText(memoData),
    disable_web_page_preview: true,
    reply_markup: buildTelegramMemoReplyMarkup(memoData, instanceUrl),
  });
}

export async function answerTelegramCallback(botToken, callbackQueryId, text, showAlert = false) {
  if (!botToken || !callbackQueryId) {
    return;
  }

  return callTelegramApi(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

/**
 * 发送所有配置的通知
 * @param {object} db - 数据库连接
 * @param {object} memoData - Memo 数据
 */
export async function sendAllNotifications(db, memoData, options = {}) {
  console.log('🔔 sendAllNotifications called for memo:', memoData.id);

  try {
    // 获取创建者的用户设置（获取 telegram_user_id）
    const userSettingStmt = db.prepare(`
      SELECT telegram_user_id
      FROM user_settings
      WHERE user_id = ?
    `);
    const userSetting = await userSettingStmt.bind(memoData.creatorId).first();
    console.log('👤 User settings:', { userId: memoData.creatorId, telegramUserId: userSetting?.telegram_user_id });

    // 获取创建者的所有 webhooks
    const webhooksStmt = db.prepare(`
      SELECT url
      FROM webhooks
      WHERE user_id = ?
    `);
    const { results: webhooks } = await webhooksStmt.bind(memoData.creatorId).all();
    console.log('🔗 Webhooks found:', webhooks?.length || 0);

    // 获取系统设置（用于 Instance URL 和 Telegram Bot Token）
    const settingsStmt = db.prepare(`
      SELECT key, value
      FROM settings
      WHERE key IN ('telegram-bot-token', 'instance-url')
    `);
    const { results: settings } = await settingsStmt.all();

    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.key] = s.value;
    });

    const telegramBotToken = settingsMap['telegram-bot-token'];
    const instanceUrl = settingsMap['instance-url'];

    console.log('⚙️  System settings:', {
      hasBotToken: !!telegramBotToken,
      botTokenPrefix: telegramBotToken?.substring(0, 10) + '...',
      instanceUrl
    });

    // 从用户设置中读取 telegram_user_id
    const telegramUserId = userSetting?.telegram_user_id;

    // 并行发送通知
    const promises = [];

    // 发送到所有配置的 webhooks
    if (webhooks && webhooks.length > 0) {
      webhooks.forEach(webhook => {
        if (webhook.url) {
          console.log('📤 Adding webhook to queue:', webhook.url);
          promises.push(sendWebhook(webhook.url, memoData));
        }
      });
    }

    // 发送 Telegram 通知
    if (!options.skipTelegram && telegramBotToken && telegramUserId) {
      console.log('📱 Adding Telegram notification to queue for user:', telegramUserId);
      promises.push(sendTelegramNotification(telegramBotToken, telegramUserId, memoData, instanceUrl));
    } else {
      console.log('⚠️  Telegram notification not queued:', {
        skipTelegram: Boolean(options.skipTelegram),
        hasBotToken: !!telegramBotToken,
        hasTelegramUserId: !!telegramUserId
      });
    }

    if (promises.length > 0) {
      console.log(`🚀 Sending ${promises.length} notification(s)...`);
      const results = await Promise.allSettled(promises);
      console.log('✅ All notifications processed:', results.map(r => r.status));
    } else {
      console.log('⚠️  No notification endpoints configured for this user');
    }
  } catch (error) {
    console.error('Error in sendAllNotifications:', error);
  }
}
