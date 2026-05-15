export const config = { runtime: 'edge' };

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DAILY_LIMIT = 20;

export default async function handler(req) {
  // Только POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ── Rate limiting: 20 запросов в день на пользователя ─────────────────────
  const userId = req.headers.get('X-User-Id');

  if (userId && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    try {
      // Считаем сколько запросов сегодня
      const countRes = await fetch(
        `${SUPABASE_URL}/rest/v1/api_usage?user_id=eq.${userId}&date=eq.${today}&select=id`,
        {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Prefer': 'count=exact',
          },
        }
      );
      const range = countRes.headers.get('content-range') || '0/0';
      const usedToday = parseInt(range.split('/')[1] || '0', 10);

      if (usedToday >= DAILY_LIMIT) {
        return new Response(JSON.stringify({ error: `Daily limit of ${DAILY_LIMIT} requests reached. Try again tomorrow.` }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Записываем текущий запрос
      await fetch(`${SUPABASE_URL}/rest/v1/api_usage`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: userId, date: today }),
      });

    } catch {
      // Если Supabase недоступен — пропускаем rate limiting, не блокируем пользователя
    }
  }

  // ── Проксируем запрос к OpenAI (оригинальный код) ─────────────────────────
  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify(body)
  });

  const data = await openaiRes.json();

  return new Response(JSON.stringify(data), {
    status: openaiRes.status,
    headers: { 'Content-Type': 'application/json' }
  });
}
