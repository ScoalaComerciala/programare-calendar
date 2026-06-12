// Cloudflare Worker — deploy la https://workers.cloudflare.com
// Variabile de setat in Settings > Variables & Secrets:
//   CLICKUP_API_KEY  — token-ul tau personal din ClickUp
//   CLICKUP_LIST_ID  — ID-ul listei din Space-ul tau

export default {
  async fetch(request, env) {
    // CORS — permite requesturi de la GitHub Pages
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204);
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

    // construieste timestamp-urile pentru ClickUp (milliseconds)
    const startTs = new Date(`${date}T${time}:00`).getTime();
    const dueTs   = startTs + 60 * 60 * 1000; // +1 ora implicit

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

    // verifica suprapuneri: cauta taskuri care incep in aceeasi ora
    const checkUrl = new URL(`https://api.clickup.com/api/v2/list/${env.CLICKUP_LIST_ID}/task`);
    checkUrl.searchParams.set('start_date', startTs);
    checkUrl.searchParams.set('start_date_gt', startTs - 1);
    checkUrl.searchParams.set('due_date_lt', dueTs + 1);
    checkUrl.searchParams.set('include_closed', 'false');

    const existingRes = await fetch(checkUrl.toString(), {
      headers: { 'Authorization': env.CLICKUP_API_KEY },
    });

    if (existingRes.ok) {
      const existingJson = await existingRes.json();
      const tasks = existingJson.tasks || [];

      // considera suprapunere daca alt task incepe sau e activ in acelasi interval
      const conflict = tasks.find(t => {
        const tStart = Number(t.start_date);
        const tDue   = Number(t.due_date);
        // suprapunere daca intervalele se intersecteaza
        return tStart < dueTs && tDue > startTs;
      });

      if (conflict) {
        return corsResponse(
          JSON.stringify({ error: `Ora ${time} este deja ocupata. Te rugam alege alta ora.` }),
          409
        );
      }
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

function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
