/**
 * Реле: страница «Отпечаток» → Telegram-бот.
 * Cloudflare Worker, зависимостей нет.
 *
 * ЧТО ЭТО НЕ ТАКОЕ. Воркер не собирает данные. Он ничего не знает о том,
 * кто открыл страницу, и сам ни к кому не стучится. Он принимает POST,
 * который ему прислали, и пересылает текст в чат. Всё, что происходит
 * до этого, — дело страницы: на otpechatok.html данные уходят только
 * после того, как человек нажал кнопку и ввёл свой ник.
 *
 * ЗАЧЕМ ОН НУЖЕН. Токен бота нельзя держать в JS на странице: любой,
 * кто откроет исходник, получит полный доступ к боту, в том числе
 * сможет дёрнуть getUpdates и прочитать всё, что боту присылали.
 * Здесь токен лежит в секретах воркера и в браузер не попадает никогда.
 *
 * УСТАНОВКА
 *   1. npx wrangler login
 *   2. npx wrangler secret put BOT_TOKEN    # токен от @BotFather
 *   3. npx wrangler secret put CHAT_ID      # кому слать (свой chat_id)
 *   4. npx wrangler deploy
 *   5. полученный адрес вписать в REPORT_URL на странице
 *
 * Проверка, что жив: открыть адрес воркера в браузере — ответит текстом.
 */

const MAX_TEXT = 3800;        // у Telegram лимит 4096, оставляем запас
const MAX_NICK = 32;
const MAX_LABEL = 80;
const MAX_VALUE = 400;
const MAX_CAT = 48;
const MAX_FIELDS = 120;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}

// Однострочное поле: убираем переводы строк и управляющие символы,
// чтобы никто не смог подделать вид сообщения в чате.
function oneLine(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Категория приходит третьим элементом и печатается заголовком один раз,
// а не приклеивается к каждой метке — иначе отчёт не влезает в одно сообщение.
function buildMessage({ nick, fpId, ts, fields }) {
  const out = [];
  out.push('🖐 Отчёт со страницы «Отпечаток»');
  out.push('Кто: ' + (nick || 'без ника'));
  out.push('Скан сделан: ' + (ts || new Date().toISOString()));
  if (fpId) out.push('Отпечаток: ' + fpId);

  let cat = '';
  for (const [label, value, c] of fields) {
    if (c && c !== cat) {
      cat = c;
      out.push('', '▸ ' + cat);
    }
    out.push(label + ': ' + value);
  }
  return out.join('\n');
}

// Телеграм не примет кусок длиннее 4096 — режем по границам строк
function chunk(text, size) {
  if (text.length <= size) return [text];
  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > size) {
      parts.push(buf);
      buf = '';
    }
    buf = buf ? buf + '\n' + line : line;
  }
  if (buf) parts.push(buf);
  return parts;
}

async function send(env, chatId, text) {
  const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      disable_notification: false,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.ok) {
    // Тело ошибки токен не содержит, поэтому его можно вернуть как есть
    throw new Error((body && body.description) || ('HTTP ' + r.status));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method === 'GET') {
      return new Response(
        'Реле живо. Принимает POST /report и пересылает текст в Telegram.\n' +
        'Токен бота лежит в секретах воркера и на страницу не отдаётся.\n',
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    if (request.method !== 'POST' || (url.pathname !== '/report' && url.pathname !== '/')) {
      return json({ ok: false, error: 'ожидается POST /report' }, 404, env);
    }

    if (!env.BOT_TOKEN || !env.CHAT_ID) {
      return json({ ok: false, error: 'не заданы BOT_TOKEN и CHAT_ID' }, 500, env);
    }

    let raw;
    try {
      raw = await request.json();
    } catch (e) {
      return json({ ok: false, error: 'тело запроса не JSON' }, 400, env);
    }
    if (!raw || typeof raw !== 'object') {
      return json({ ok: false, error: 'тело запроса не объект' }, 400, env);
    }
    if (!Array.isArray(raw.fields)) {
      return json({ ok: false, error: 'нет поля fields' }, 400, env);
    }

    const nick = oneLine(raw.nick, MAX_NICK);
    const fpId = oneLine(raw.fpId, 64);
    const ts = oneLine(raw.ts, 40);

    const fields = raw.fields
      .slice(0, MAX_FIELDS)
      .filter(f => Array.isArray(f))
      .map(f => [oneLine(f[0], MAX_LABEL), oneLine(f[1], MAX_VALUE), oneLine(f[2], MAX_CAT)])
      .filter(f => f[0] && f[1]);

    if (!fields.length) {
      return json({ ok: false, error: 'после чистки не осталось ни одного поля' }, 400, env);
    }

    const text = buildMessage({ nick, fpId, ts, fields });

    try {
      for (const part of chunk(text, MAX_TEXT)) {
        await send(env, env.CHAT_ID, part);
      }
    } catch (e) {
      return json({ ok: false, error: 'телеграм отказал: ' + e.message }, 502, env);
    }

    return json({ ok: true, fields: fields.length }, 200, env);
  },
};
