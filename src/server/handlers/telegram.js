import { Hono } from 'hono';
import { jsonResponse, errorResponse, requireAdmin } from '../utils/auth.js';
import {
  answerTelegramCallback,
  editTelegramMemoNotification,
  getTelegramVisibilityLabel,
  parseTelegramMemoVisibilityCallbackData,
  sendAllNotifications,
  sendTelegramNotification,
} from '../utils/notifications.js';
import { callTelegramApi, sendTelegramText } from '../utils/telegram.js';
import { attachTagToMemo, extractTagNamesFromMemoContent } from '../utils/tags.js';

const app = new Hono();
const VALID_VISIBILITIES = ['PRIVATE', 'PROTECTED', 'PUBLIC'];

function buildSettingsMap(settings) {
  const settingsMap = {};
  (settings || []).forEach((setting) => {
    settingsMap[setting.key] = setting.value;
  });
  return settingsMap;
}

function buildBindingMessage(chatId, fromId, boundUser) {
  const lines = [
    'Telegram 已连接到 Memos。',
    `Chat ID: ${chatId}`,
    `User ID: ${fromId}`,
  ];

  if (boundUser) {
    lines.push(`当前绑定用户: ${boundUser.nickname || boundUser.username}`);
    lines.push('直接发送文本消息即可创建 memo。');
  } else {
    lines.push('请把上面的 User ID 填到 Memos 的 Telegram UserID 设置里。');
  }

  return lines.join('\n');
}

async function findUserByTelegramId(db, candidateIds) {
  const uniqueCandidateIds = [...new Set((candidateIds || [])
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => String(value)))];

  if (uniqueCandidateIds.length === 0) {
    return null;
  }

  const placeholders = uniqueCandidateIds.map(() => '?').join(', ');
  const stmt = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.nickname,
      COALESCE(us.memo_visibility, 'PRIVATE') AS memoVisibility,
      us.telegram_user_id AS telegramUserId
    FROM user_settings us
    INNER JOIN users u ON us.user_id = u.id
    WHERE us.telegram_user_id IN (${placeholders})
    LIMIT 1
  `);

  return stmt.bind(...uniqueCandidateIds).first();
}

async function ensureMemoTags(db, memoId, tagNames, creatorId) {
  for (const tagName of tagNames) {
    await attachTagToMemo(db, memoId, tagName, creatorId);
  }
}

async function createTelegramMemo(db, user, content) {
  const now = Math.floor(Date.now() / 1000);
  const visibility = user.memoVisibility || 'PRIVATE';
  const insertResult = await db.prepare(`
    INSERT INTO memos (creator_id, content, visibility, display_ts)
    VALUES (?, ?, ?, ?)
  `).bind(user.id, content, visibility, now).run();

  const memoId = insertResult.meta.last_row_id;
  const tagNames = extractTagNamesFromMemoContent(content);
  await ensureMemoTags(db, memoId, tagNames, user.id);

  return {
    memoId,
    createdTs: now,
    visibility,
    tagNames,
  };
}

async function getMemoNotificationData(db, memoId, userId) {
  const memoStmt = db.prepare(`
    SELECT
      m.id,
      m.content,
      m.visibility,
      m.creator_id as creatorId,
      m.created_ts as createdTs,
      u.username as creatorUsername,
      u.nickname as creatorName
    FROM memos m
    LEFT JOIN users u ON m.creator_id = u.id
    WHERE m.id = ? AND m.creator_id = ? AND m.row_status = 'NORMAL'
  `);
  const memo = await memoStmt.bind(memoId, userId).first();

  if (!memo) {
    return null;
  }

  const tagsStmt = db.prepare(`
    SELECT t.name
    FROM tags t
    INNER JOIN memo_tags mt ON mt.tag_id = t.id
    WHERE mt.memo_id = ?
    ORDER BY t.name ASC
  `);
  const resourcesStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM memo_resources
    WHERE memo_id = ?
  `);

  const [{ results: tags }, resourceCount] = await Promise.all([
    tagsStmt.bind(memoId).all(),
    resourcesStmt.bind(memoId).first(),
  ]);

  return {
    ...memo,
    creatorName: memo.creatorName || memo.creatorUsername,
    tags: (tags || []).map((tag) => tag.name),
    resourceCount: resourceCount?.count || 0,
  };
}

async function updateMemoVisibility(db, memoId, userId, visibility) {
  if (!VALID_VISIBILITIES.includes(visibility)) {
    return false;
  }

  const result = await db.prepare(`
    UPDATE memos
    SET visibility = ?, updated_ts = ?
    WHERE id = ? AND creator_id = ? AND row_status = 'NORMAL'
  `).bind(
    visibility,
    Math.floor(Date.now() / 1000),
    memoId,
    userId,
  ).run();

  return result.changes > 0;
}

async function handleCallbackQuery(db, telegramBotToken, instanceUrl, update) {
  const callbackQuery = update?.callback_query;
  if (!callbackQuery) {
    return null;
  }

  const callbackQueryId = callbackQuery.id;
  const chatId = String(callbackQuery.message?.chat?.id ?? '');
  const messageId = callbackQuery.message?.message_id;
  const fromId = String(callbackQuery.from?.id ?? '');
  const parsedAction = parseTelegramMemoVisibilityCallbackData(callbackQuery.data);

  if (!callbackQueryId || !chatId || !fromId || !messageId) {
    return jsonResponse({ ok: true, ignored: 'invalid-callback-query' });
  }

  if (!parsedAction) {
    await answerTelegramCallback(telegramBotToken, callbackQueryId, '不支持的操作');
    return jsonResponse({ ok: true, ignored: 'unknown-callback-action' });
  }

  const boundUser = await findUserByTelegramId(db, [chatId, fromId]);
  if (!boundUser) {
    await answerTelegramCallback(telegramBotToken, callbackQueryId, '当前 Telegram 账号未绑定 Memos 用户', true);
    return jsonResponse({ ok: true, ignored: 'telegram user not bound' });
  }

  const currentMemo = await getMemoNotificationData(db, parsedAction.memoId, boundUser.id);
  if (!currentMemo) {
    await answerTelegramCallback(telegramBotToken, callbackQueryId, 'Memo 不存在或你没有权限修改', true);
    return jsonResponse({ ok: true, ignored: 'memo-not-found' });
  }

  if (currentMemo.visibility === parsedAction.visibility) {
    await answerTelegramCallback(
      telegramBotToken,
      callbackQueryId,
      `当前已是${getTelegramVisibilityLabel(currentMemo.visibility)}`,
    );
    return jsonResponse({
      ok: true,
      handled: 'memo-visibility-unchanged',
      memoId: currentMemo.id,
      visibility: currentMemo.visibility,
    });
  }

  const updated = await updateMemoVisibility(db, parsedAction.memoId, boundUser.id, parsedAction.visibility);
  if (!updated) {
    await answerTelegramCallback(telegramBotToken, callbackQueryId, '更新可见性失败', true);
    return jsonResponse({ ok: true, ignored: 'memo-visibility-update-failed' });
  }

  const refreshedMemo = await getMemoNotificationData(db, parsedAction.memoId, boundUser.id);
  if (!refreshedMemo) {
    await answerTelegramCallback(telegramBotToken, callbackQueryId, 'Memo 已不存在', true);
    return jsonResponse({ ok: true, ignored: 'memo-not-found-after-update' });
  }

  try {
    await editTelegramMemoNotification(telegramBotToken, chatId, messageId, refreshedMemo, instanceUrl);
  } catch (error) {
    if (!String(error?.message || error).includes('message is not modified')) {
      throw error;
    }
  }

  await answerTelegramCallback(
    telegramBotToken,
    callbackQueryId,
    `已切换为${getTelegramVisibilityLabel(refreshedMemo.visibility)}`,
  );

  return jsonResponse({
    ok: true,
    handled: 'memo-visibility-updated',
    memoId: refreshedMemo.id,
    visibility: refreshedMemo.visibility,
  });
}

async function getTelegramSettings(db) {
  const { results: settings } = await db.prepare(`
    SELECT key, value
    FROM settings
    WHERE key IN ('telegram-bot-token', 'instance-url')
  `).all();

  const settingsMap = buildSettingsMap(settings);
  return {
    telegramBotToken: settingsMap['telegram-bot-token'],
    instanceUrl: settingsMap['instance-url']?.replace(/\/+$/, ''),
  };
}

app.get('/webhook/info', async (c) => {
  const authError = await requireAdmin(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const { telegramBotToken } = await getTelegramSettings(db);

    if (!telegramBotToken) {
      return errorResponse('Telegram bot token is not configured', 400);
    }

    const result = await callTelegramApi(telegramBotToken, 'getWebhookInfo', {});
    return jsonResponse(result.result || {});
  } catch (error) {
    console.error('Error fetching Telegram webhook info:', error);
    return errorResponse(error.message || 'Failed to fetch Telegram webhook info', 500);
  }
});

app.post('/webhook/sync', async (c) => {
  const authError = await requireAdmin(c);
  if (authError) return authError;

  try {
    const db = c.env.DB;
    const body = await c.req.json().catch(() => ({}));
    const { telegramBotToken } = await getTelegramSettings(db);

    if (!telegramBotToken) {
      return errorResponse('Telegram bot token is not configured', 400);
    }

    const defaultWebhookUrl = `${new URL(c.req.url).origin}/api/v1/telegram/webhook`;
    const webhookUrl = (body.webhookUrl || defaultWebhookUrl).trim();
    const payload = {
      url: webhookUrl,
      drop_pending_updates: Boolean(body.dropPendingUpdates),
    };

    if (c.env.TELEGRAM_WEBHOOK_SECRET) {
      payload.secret_token = c.env.TELEGRAM_WEBHOOK_SECRET;
    }

    const setWebhookResult = await callTelegramApi(telegramBotToken, 'setWebhook', payload);
    const webhookInfoResult = await callTelegramApi(telegramBotToken, 'getWebhookInfo', {});

    return jsonResponse({
      message: setWebhookResult.description || 'Webhook updated',
      webhookUrl,
      webhookInfo: webhookInfoResult.result || {},
    });
  } catch (error) {
    console.error('Error syncing Telegram webhook:', error);
    return errorResponse(error.message || 'Failed to sync Telegram webhook', 500);
  }
});

app.post('/webhook', async (c) => {
  try {
    const db = c.env.DB;
    const expectedSecret = c.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const providedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
      if (providedSecret !== expectedSecret) {
        return errorResponse('Forbidden', 403);
      }
    }

    let update;
    try {
      update = await c.req.json();
    } catch (error) {
      return errorResponse('Invalid Telegram update payload', 400);
    }

    const { telegramBotToken, instanceUrl } = await getTelegramSettings(db);

    if (!telegramBotToken) {
      console.warn('Telegram webhook called without telegram-bot-token configured');
      return jsonResponse({ ok: true, ignored: 'telegram bot token not configured' });
    }

    const callbackResult = await handleCallbackQuery(db, telegramBotToken, instanceUrl, update);
    if (callbackResult) {
      return callbackResult;
    }

    const message = update?.message || update?.edited_message;
    if (!message) {
      return jsonResponse({ ok: true, ignored: 'unsupported update type' });
    }

    const chatId = String(message.chat?.id ?? '');
    const fromId = String(message.from?.id ?? '');
    const chatType = message.chat?.type;
    const content = (message.text ?? message.caption ?? '').trim();
    const normalizedContent = content.toLowerCase();

    if (!chatId || !fromId) {
      return jsonResponse({ ok: true, ignored: 'missing chat context' });
    }

    if (chatType !== 'private') {
      await sendTelegramText(
        telegramBotToken,
        chatId,
        '当前只支持通过和机器人私聊发送文本 memo。'
      );
      return jsonResponse({ ok: true, ignored: 'non-private chat' });
    }

    const boundUser = await findUserByTelegramId(db, [chatId, fromId]);
    const isStartCommand = normalizedContent.startsWith('/start');
    const isIdCommand = normalizedContent === '/id' || normalizedContent.startsWith('/id@');

    if (isStartCommand || isIdCommand) {
      await sendTelegramText(
        telegramBotToken,
        chatId,
        buildBindingMessage(chatId, fromId, boundUser)
      );
      return jsonResponse({ ok: true, handled: 'binding-info' });
    }

    if (!boundUser) {
      await sendTelegramText(
        telegramBotToken,
        chatId,
        buildBindingMessage(chatId, fromId, null)
      );
      return jsonResponse({ ok: true, ignored: 'telegram user not bound' });
    }

    if (!content) {
      await sendTelegramText(
        telegramBotToken,
        chatId,
        '当前只支持发送文本消息创建 memo。'
      );
      return jsonResponse({ ok: true, ignored: 'empty message' });
    }

    const memo = await createTelegramMemo(db, boundUser, content);
    const notificationMemoData = {
      id: memo.memoId,
      content,
      visibility: memo.visibility,
      creatorId: boundUser.id,
      creatorUsername: boundUser.username,
      creatorName: boundUser.nickname || boundUser.username,
      createdTs: memo.createdTs,
      tags: memo.tagNames,
      resourceCount: 0,
    };

    c.executionCtx.waitUntil(
      sendAllNotifications(db, notificationMemoData, {
        skipTelegram: true,
      }).catch((error) => {
        console.error('Error sending notifications for Telegram memo:', error);
      })
    );

    await sendTelegramNotification(telegramBotToken, chatId, notificationMemoData, instanceUrl);

    return jsonResponse({
      ok: true,
      memoId: memo.memoId,
    });
  } catch (error) {
    console.error('Error handling Telegram webhook:', error);
    return errorResponse('Failed to handle Telegram webhook', 500);
  }
});

export default app;
