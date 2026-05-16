export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { telegram_id, meal, photo_base64 } = await req.json();

  if (!telegram_id || !meal) {
    return new Response(JSON.stringify({ error: 'Missing params' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
  };

  // 1. Получаем user_id по telegram_id
  const userRes = await fetch(
    `${supabaseUrl}/rest/v1/users?telegram_id=eq.${telegram_id}&select=id`,
    { headers }
  );
  const users = await userRes.json();
  if (!users || users.length === 0) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  }
  const userId = users[0].id;

  // 2. Загружаем фото в Storage если есть
  let photo_url = '';
  if (photo_base64) {
    try {
      // Декодируем base64
      const base64Data = photo_base64.replace(/^data:image\/\w+;base64,/, '');
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const fileName = `${userId}/${Date.now()}_tg.jpg`;
      const uploadRes = await fetch(
        `${supabaseUrl}/storage/v1/object/meal-photos/${fileName}`,
        {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'image/jpeg',
            'x-upsert': 'true',
          },
          body: bytes,
        }
      );

      if (uploadRes.ok) {
        photo_url = `${supabaseUrl}/storage/v1/object/public/meal-photos/${fileName}`;
      }
    } catch (e) {
      console.error('Photo upload error:', e);
    }
  }

  // 3. Вставляем запись в meals
  const mealRes = await fetch(`${supabaseUrl}/rest/v1/meals`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      photo_url,
      verdict: meal.verdict,
      score: meal.score,
      title: meal.title || '',
      vision: meal.vision || '',
      summary: meal.summary || '',
      education: meal.education || '',
      nuances: meal.nuances || '',
      upgrade: meal.upgrade || '',
      factors: meal.factors || [],
      created_at: meal.at || new Date().toISOString(),
    }),
  });

  const inserted = await mealRes.json();
  const mealId = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;

  return new Response(JSON.stringify({ ok: true, id: mealId, photo_url }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
