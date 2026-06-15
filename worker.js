// Cloudflare Worker — deploy la https://workers.cloudflare.com
// Variabile de setat in Settings > Variables & Secrets:
//   CLICKUP_API_KEY  — token-ul tau personal din ClickUp
//   CLICKUP_LIST_ID  — ID-ul listei din Space-ul tau
//   ADMIN_PASSWORD   — parola pentru panoul de setari (in wrangler.toml [vars])
// KV: SETTINGS — pastreaza zilele/orele disponibile

const DEFAULT_SETTINGS = {
  // 0 = Duminica ... 6 = Sambata
  days: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
  slotMinutes: 60,
  dateFrom: null,  // 'YYYY-MM-DD' sau null = fara limita
  dateTo: null,
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204);
    }

    const url = new URL(request.url);

    if (url.pathname === '/settings') {
      if (request.method === 'GET') {
        const settings = await getSettings(env);
        return corsResponse(JSON.stringify(settings), 200);
      }
      if (request.method === 'POST') {
        if (request.headers.get('X-Admin-Password') !== (env.ADMIN_PASSWORD || '').trim()) {
          return corsResponse(JSON.stringify({ error: 'Parola gresita' }), 401);
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return corsResponse(JSON.stringify({ error: 'JSON invalid' }), 400);
        }
        const settings = sanitizeSettings(body);
        if (!settings) {
          return corsResponse(JSON.stringify({ error: 'Setari invalide' }), 400);
        }
        await env.SETTINGS.put('availability', JSON.stringify(settings));
        return corsResponse(JSON.stringify({ ok: true, settings }), 200);
      }
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }

    // sloturile deja ocupate intr-o zi — ca pagina sa le arate dezactivate
    if (url.pathname === '/slots' && request.method === 'GET') {
      const date = url.searchParams.get('date');
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return corsResponse(JSON.stringify({ error: 'Data invalida' }), 400);
      }
      const taken = await getTakenSlots(env, date);
      return corsResponse(JSON.stringify({ taken }), 200);
    }

    if (request.method !== 'POST') {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse(JSON.stringify({ error: 'JSON invalid' }), 400);
    }

    const { name, phone, email, date, time, service, notes } = body;

    if (!name || !phone || !date || !time) {
      return corsResponse(JSON.stringify({ error: 'Campuri obligatorii lipsa' }), 400);
    }

    // valideaza fata de setarile de disponibilitate
    const settings = await getSettings(env);
    const reqDay = new Date(`${date}T00:00:00`).getDay();
    if (!settings.days.includes(reqDay)) {
      return corsResponse(JSON.stringify({ error: 'Ziua aleasa nu este disponibila pentru programari.' }), 400);
    }
    const slotMs = settings.slotMinutes * 60 * 1000;
    const reqMin = toMinutes(time);
    if (reqMin < toMinutes(settings.startTime) || reqMin + settings.slotMinutes > toMinutes(settings.endTime)) {
      return corsResponse(JSON.stringify({ error: 'Ora aleasa este in afara programului disponibil.' }), 400);
    }
    if (settings.dateFrom && date < settings.dateFrom) {
      return corsResponse(JSON.stringify({ error: `Programarile sunt disponibile incepand cu ${settings.dateFrom}.` }), 400);
    }
    if (settings.dateTo && date > settings.dateTo) {
      return corsResponse(JSON.stringify({ error: `Programarile sunt disponibile doar pana la ${settings.dateTo}.` }), 400);
    }

    // construieste timestamp-urile pentru ClickUp (milliseconds)
    const startTs = new Date(`${date}T${time}:00`).getTime();
    const dueTs   = startTs + slotMs;

    if (startTs < Date.now()) {
      return corsResponse(JSON.stringify({ error: 'Nu se pot face programari in trecut.' }), 400);
    }

    const taskName = `${service} — ${name} — ${date} ${time}`;

    const description = [
      `Nume: ${name}`,
      `Telefon: ${phone}`,
      email ? `Email: ${email}` : null,
      `Data: ${date} ora ${time}`,
      `Serviciu: ${service}`,
      notes ? `Mentiuni: ${notes}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    // verifica suprapuneri cu programarile existente
    const conflict = await hasConflict(env, startTs, dueTs);
    if (conflict) {
      return corsResponse(
        JSON.stringify({ error: `Ora ${time} este deja ocupata. Te rugam alege alta ora.` }),
        409
      );
    }

    const clickupRes = await fetch(
      `https://api.clickup.com/api/v2/list/${env.CLICKUP_LIST_ID}/task`,
      {
        method: 'POST',
        headers: {
          'Authorization': env.CLICKUP_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: taskName,
          description,
          due_date: dueTs,
          due_date_time: true,
          start_date: startTs,
          start_date_time: true,
          priority: 3,
          notify_all: false,
        }),
      }
    );

    const clickupJson = await clickupRes.json();

    if (!clickupRes.ok) {
      console.error('ClickUp error:', JSON.stringify(clickupJson));
      return corsResponse(
        JSON.stringify({ error: 'Eroare ClickUp: ' + (clickupJson.err || 'unknown') }),
        500
      );
    }

    return corsResponse(
      JSON.stringify({ ok: true, taskId: clickupJson.id }),
      200
    );
  },
};

async function getSettings(env) {
  const raw = await env.SETTINGS.get('availability');
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function sanitizeSettings(body) {
  const days = Array.isArray(body.days)
    ? [...new Set(body.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))]
    : null;
  const timeRe = /^\d{2}:\d{2}$/;
  const startTime = timeRe.test(body.startTime) ? body.startTime : null;
  const endTime = timeRe.test(body.endTime) ? body.endTime : null;
  const slotMinutes = [15, 30, 45, 60, 90, 120].includes(Number(body.slotMinutes))
    ? Number(body.slotMinutes) : null;

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const dateFrom = body.dateFrom && dateRe.test(body.dateFrom) ? body.dateFrom : null;
  const dateTo   = body.dateTo   && dateRe.test(body.dateTo)   ? body.dateTo   : null;
  if (dateFrom && dateTo && dateFrom > dateTo) return null;

  if (!days || !days.length || !startTime || !endTime || !slotMinutes) return null;
  if (toMinutes(startTime) >= toMinutes(endTime)) return null;
  return { days, startTime, endTime, slotMinutes, dateFrom, dateTo };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

async function fetchDayTasks(env, date) {
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const url = new URL(`https://api.clickup.com/api/v2/list/${env.CLICKUP_LIST_ID}/task`);
  url.searchParams.set('due_date_gt', dayStart);
  url.searchParams.set('start_date_lt', dayEnd);
  url.searchParams.set('include_closed', 'false');

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': env.CLICKUP_API_KEY },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.tasks || []).filter(t => t.start_date && t.due_date);
}

async function getTakenSlots(env, date) {
  const tasks = await fetchDayTasks(env, date);
  return tasks.map(t => ({
    start: Number(t.start_date),
    end: Number(t.due_date),
  }));
}

async function hasConflict(env, startTs, dueTs) {
  const date = new Date(startTs).toISOString().split('T')[0];
  const tasks = await fetchDayTasks(env, date);
  return tasks.some(t => Number(t.start_date) < dueTs && Number(t.due_date) > startTs);
}

function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    },
  });
}
