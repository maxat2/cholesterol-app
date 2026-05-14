/**
 * api/daily-cron.js
 * Vercel Cron Function — запускается каждый день в 22:00 UTC+3 (19:00 UTC)
 *
 * Что делает:
 * 1. Находит всех пользователей у кого есть 2+ блюда за сегодня
 * 2. Генерирует итог дня через OpenAI (тот же промпт что на клиенте)
 * 3. Сохраняет в таблицу meals (is_daily_summary = true)
 * 4. Отправляет Web Push уведомление на все устройства пользователя
 *
 * Переменные окружения (Vercel → Settings → Environment Variables):
 *   OPENAI_API_KEY       — OpenAI API ключ
 *   SUPABASE_URL         — URL проекта Supabase
 *   SUPABASE_SERVICE_KEY — Service Role Key (не anon!) из Supabase → Settings → API
 *   VAPID_PUBLIC_KEY     — публичный VAPID ключ (генерация: см. README)
 *   VAPID_PRIVATE_KEY    — приватный VAPID ключ
 *   VAPID_SUBJECT        — mailto:твой@email.com
 */

export const config = {
  runtime: 'nodejs20.x',
  maxDuration: 60, // секунд — крон может работать дольше обычного запроса
};

// ── Зависимости (устанавливаются через npm install web-push @supabase/supabase-js) ──
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Service Role — обходит RLS
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const VAPID_PUBLIC_KEY    = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY   = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT       = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const CRON_SECRET         = process.env.CRON_SECRET; // защита от случайных вызовов

export default async function handler(req, res) {
  // ── Защита: только Vercel Cron или запрос с секретом ──────────────────────
  const authHeader = req.headers['authorization'];
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const hasSecret = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  // ── Настройка VAPID для Web Push ──────────────────────────────────────────
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Сегодняшняя дата в формате YYYY-MM-DD (UTC+3, Москва)
  const now = new Date();
  const moscowOffset = 3 * 60; // UTC+3 в минутах
  const moscowNow = new Date(now.getTime() + (moscowOffset - now.getTimezoneOffset()) * 60000);
  const todayStr = moscowNow.toISOString().slice(0, 10);

  console.log(`[cron] Запуск для даты: ${todayStr}`);

  const results = { processed: 0, skipped: 0, errors: 0, pushed: 0 };

  try {
    // ── 1. Найти всех пользователей у кого уже есть сегодняшние блюда ──────
    const { data: mealUsers, error: mealErr } = await supabase
      .from('meals')
      .select('user_id')
      .eq('is_daily_summary', false)
      .gte('eaten_at', `${todayStr}T00:00:00`)
      .lt('eaten_at', `${todayStr}T23:59:59`);

    if (mealErr) throw mealErr;

    // Уникальные user_id у кого есть блюда сегодня
    const userIds = [...new Set((mealUsers || []).map(m => m.user_id))];
    console.log(`[cron] Пользователей с блюдами сегодня: ${userIds.length}`);

    for (const userId of userIds) {
      try {
        // ── 2. Проверить что отчёт за сегодня ещё не создан ───────────────
        const { data: existing } = await supabase
          .from('meals')
          .select('id')
          .eq('user_id', userId)
          .eq('is_daily_summary', true)
          .eq('summary_date', todayStr)
          .maybeSingle();

        if (existing) {
          console.log(`[cron] ${userId}: отчёт уже есть, пропускаем`);
          results.skipped++;
          continue;
        }

        // ── 3. Загрузить блюда пользователя за сегодня ────────────────────
        const { data: meals } = await supabase
          .from('meals')
          .select('title, score, vision, summary')
          .eq('user_id', userId)
          .eq('is_daily_summary', false)
          .gte('eaten_at', `${todayStr}T00:00:00`)
          .lt('eaten_at', `${todayStr}T23:59:59`)
          .order('eaten_at', { ascending: true })
          .limit(10); // максимум 10 блюд в промпте

        if (!meals || meals.length < 2) {
          results.skipped++;
          continue;
        }

        // ── 4. Загрузить профиль пользователя ─────────────────────────────
        const { data: userRow } = await supabase
          .from('users')
          .select('ldl, hdl, cholesterol, triglycerides, sex, age, language')
          .eq('id', userId)
          .maybeSingle();

        const lang = userRow?.language || 'ru';
        const langName = lang === 'ru' ? 'русском' : lang === 'de' ? 'Deutsch' : 'English';

        // ── 5. Строим промпт (идентично клиентскому buildDailySummaryPrompt) ─
        const mealsList = meals.map((m, i) =>
          `${i + 1}. ${m.title || 'Без названия'} — ${m.score ?? '?'}/10\n` +
          `   Состав: ${m.vision || '—'}\n` +
          `   Резюме: ${m.summary || '—'}`
        ).join('\n\n');

        const p = userRow || {};
        const prompt = `Ты AI-ассистент по питанию для людей с повышенным LDL и ApoB.

Составь короткий итог питания за день. Пользователь уже получил разбор каждого блюда — не повторяй его. Твоя задача: найти перекосы, которые видны только при взгляде на весь день целиком.

ПРОФИЛЬ:
- LDL: ${p.ldl ?? '?'} ммоль/л, Общий ХС: ${p.cholesterol ?? '?'} ммоль/л
- Пол: ${p.sex ?? '?'}, возраст: ${p.age ?? '?'} лет

БЛЮДА ЗА ДЕНЬ:
${mealsList}

ЗАДАЧА:
1. skew_text — 2-3 предложения о суммарных перекосах дня в сочетании блюд
2. alerts — только реальные нарушения (0-2 штуки)
3. tip — один конкретный совет на завтра

ОТВЕЧАЙ ТОЛЬКО ВАЛИДНЫМ JSON:
{
  "score": 7.4,
  "meals_line": "названия блюд через запятую",
  "skew_text": "2-3 предложения о перекосах",
  "alerts": [{ "label": "Насыщенных жиров — много", "level": "bad" }],
  "tip": "Конкретный совет на завтра"
}

Все текстовые поля на языке: ${langName}.`;

        // ── 6. Вызов OpenAI ────────────────────────────────────────────────
        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o',
            max_tokens: 800,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        const openaiBody = await openaiRes.json();
        const raw = openaiBody.choices?.[0]?.message?.content;
        if (!raw) throw new Error('Пустой ответ OpenAI');

        let parsed;
        try {
          parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        } catch {
          throw new Error(`Не удалось распарсить JSON: ${raw.slice(0, 100)}`);
        }

        // ── 7. Сохранить отчёт в Supabase ─────────────────────────────────
        const { error: insertErr } = await supabase.from('meals').insert({
          user_id: userId,
          is_daily_summary: true,
          summary_date: todayStr,
          eaten_at: new Date(`${todayStr}T22:00:00+03:00`).toISOString(),
          verdict: 'summary',
          score: parsed.score,
          title: parsed.meals_line || '',
          summary: JSON.stringify(parsed),
          vision: parsed.skew_text || '',
        });

        if (insertErr) throw insertErr;
        results.processed++;
        console.log(`[cron] ${userId}: отчёт сохранён, score=${parsed.score}`);

        // ── 8. Web Push уведомление ────────────────────────────────────────
        if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
          const { data: subs } = await supabase
            .from('push_subscriptions')
            .select('subscription')
            .eq('user_id', userId);

          const pushPayload = JSON.stringify({
            title: lang === 'ru' ? '📋 Отчёт за день готов' :
                   lang === 'de' ? '📋 Tagesbericht ist fertig' :
                   '📋 Daily report is ready',
            body: lang === 'ru' ? `Оценка дня: ${parsed.score}/10` :
                  lang === 'de' ? `Tagesbewertung: ${parsed.score}/10` :
                  `Day score: ${parsed.score}/10`,
            url: '/',
          });

          for (const sub of subs || []) {
            try {
              await webpush.sendNotification(sub.subscription, pushPayload);
              results.pushed++;
            } catch (pushErr) {
              // 410 = подписка устарела — удаляем
              if (pushErr.statusCode === 410) {
                await supabase.from('push_subscriptions')
                  .delete()
                  .eq('user_id', userId)
                  .eq('subscription', sub.subscription);
              }
              console.warn(`[cron] push error for ${userId}:`, pushErr.message);
            }
          }
        }

      } catch (userErr) {
        console.error(`[cron] Ошибка для ${userId}:`, userErr.message);
        results.errors++;
      }
    }

  } catch (globalErr) {
    console.error('[cron] Глобальная ошибка:', globalErr.message);
    return res.status(500).json({ error: globalErr.message, results });
  }

  console.log('[cron] Итог:', results);
  return res.status(200).json({ date: todayStr, ...results });
}
