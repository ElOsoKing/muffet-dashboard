// importer.js — Importa comandos y mensajes automáticos (timers) de otros bots al formato de SilklyBot.
// Traduce las variables de Nightbot, StreamElements y Streamlabs Chatbot (parcial) a las de SilklyBot, avisa de lo
// que no se puede traducir y valida todo otra vez antes de guardar. No toca la base de datos: eso lo hace server.js.
'use strict';

// Comandos propios del bot — mantener igual que RESERVED_COMMANDS de index.js
const RESERVED = new Set(['!8ball','!accept','!aceptar','!addcmd','!addcounter','!apostar','!ask','!bet','!bola8','!cancion','!canción','!canjear','!cerrarencuesta','!clip','!cmds','!cola','!comandos','!dado','!dar','!dbdle','!dbdleranking','!dbdletop','!decline','!delcmd','!delcounter','!donaciones','!donar','!duel','!duelo','!editcmd','!emoji','!emojigame','!emojihint','!emojiranking','!emojiskip','!emojitop','!helixcheck','!encuesta','!endpoll','!game','!give','!juego','!level','!modcheck','!muffethabla','!muffetoff','!muffeton','!muffetsilencio','!muffetsilent','!muffetspeak','!muffetstatus','!nivel','!paypal','!pokedle','!pokedleranking','!pokedletop','!poll','!pregunta','!puntos','!queue','!random','!ranking','!rechazar','!redeem','!redes','!ruleta','!skip','!slots','!song','!sorteo','!sr','!subathon','!subathonranking','!subathontop','!subaton','!subatontop','!tiempo','!tip','!title','!titulo','!top','!toprimerin','!tragaperras','!uptime','!vskip','!xp','!youtube','!yt','!ytactual','!ytcola','!ytnext','!ytnow','!ytqueue','!ytskip']);

const MAX_RESPONSE = 450;                  // límite de Twitch por mensaje
const PERMS_OK = ['everyone', 'sub', 'vip', 'mod', 'broadcaster'];
const PLAIN_TRIGGER = /^[\p{L}\p{N}\p{Extended_Pictographic} _-]{1,30}$/u;
const BANG_NAME = /^![^\s!{}<>"'`$\\]{1,30}$/;
const ZONE = /^[A-Za-z_\/+-]{1,40}$/;

// Variables que SilklyBot entiende (para detectar {cosas} que no existen)
const KNOWN_VAR = [
  /^user$/, /^touser$/, /^channel$/, /^redes$/, /^random$/, /^random:\d+$/, /^random:\d+-\d+$/, /^count:\w+$/,
  /^randomuser$/, /^randomlist\[[^\]]+\]$/, /^game$/, /^game:[^}]+$/, /^title$/, /^uptime$/, /^viewers$/,
  /^args$/, /^[1-9]$/, /^cmd$/, /^cmdcount$/, /^points$/, /^pointsname$/, /^time(:[A-Za-z_\/+-]+)?$/, /^date(:[A-Za-z_\/+-]+)?$/,
];
// Variables que NO tienen sentido en un mensaje automático (no hay un usuario ni un comando detrás)
const NOT_FOR_TIMERS = /^(user|touser|args|[1-9]|cmd|cmdcount|points|pointsname)$/;

// ───────────────────────── Traducción de variables ─────────────────────────

// Recorre el texto buscando tokens con apertura/cierre balanceados, p. ej. $( ... ) o ${ ... }
function rewriteTokens(text, openSeq, openCh, closeCh, fn) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(openSeq, i)) {
      let depth = 1;
      let j = i + openSeq.length;
      while (j < text.length && depth > 0) {
        if (text[j] === openCh) depth++;
        else if (text[j] === closeCh) depth--;
        j++;
      }
      if (depth === 0) {
        const raw = text.slice(i, j);
        const inner = text.slice(i + openSeq.length, j - 1);
        const rep = fn(inner, raw);
        out += rep === null || rep === undefined ? raw : rep;
        i = j;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

function nightbotVar(inner, ctx) {
  const t = inner.trim();
  const l = t.toLowerCase();
  if (l === 'user' || l === 'user.name' || l === 'sender') return '{user}';
  if (l === 'touser' || l === 'touser.name') return '{touser}';
  if (l === 'channel' || l === 'channel.name' || l === 'channel.display_name') return '{channel}';
  if (l === 'query' || l === 'query.noescape') return '{args}';
  if (/^[1-9]$/.test(l)) return '{' + l + '}';
  if (l === '1:') return '{args}';
  if (l === 'count') { ctx.info.push('$(count) pasa a {cmdcount}: cuenta desde que se importa, no desde el total que tenías'); return '{cmdcount}'; }
  if (l === 'game') return '{game}';
  if (l === 'status') return '{title}';
  if (l === 'uptime') return '{uptime}';
  let m = t.match(/^time\s+(\S+)$/i);
  if (m && ZONE.test(m[1])) { ctx.info.push('La hora se muestra como HH:MM (formato distinto al de Nightbot)'); return '{time:' + m[1] + '}'; }
  return null;
}

function streamelementsVar(inner, ctx) {
  const t = inner.trim();
  const l = t.toLowerCase();
  if (l === 'user' || l === 'sender' || l === 'user.name') return '{user}';
  if (l === 'touser') return '{touser}';
  if (l === 'channel' || l === 'channel.display_name') return '{channel}';
  if (/^[1-9]$/.test(l)) return '{' + l + '}';
  if (l === '1:') return '{args}';
  if (l === 'count') { ctx.info.push('${count} pasa a {cmdcount}: cuenta desde que se importa, no desde el total que tenías'); return '{cmdcount}'; }
  if (l === 'game' || l === 'channel.game') return '{game}';
  if (l === 'title' || l === 'channel.title') return '{title}';
  if (l === 'uptime') return '{uptime}';
  if (l === 'channel.viewers') return '{viewers}';
  if (l === 'random.chatter') return '{randomuser}';
  let m = t.match(/^random\.pick\s+(.+)$/i);
  if (m) {
    const opts = [];
    const re = /'([^']*)'|"([^"]*)"/g;
    let q;
    while ((q = re.exec(m[1]))) opts.push((q[1] !== undefined ? q[1] : q[2]).trim());
    if (opts.length && opts.every(o => o && !/[;\]\[}{]/.test(o))) return '{randomlist[' + opts.join(';') + ']}';
    return null;
  }
  m = t.match(/^random[.\s](\d+)-(\d+)$/i);
  if (m) return '{random:' + m[1] + '-' + m[2] + '}';
  return null;
}

// Streamlabs Chatbot: solo lo básico y seguro
function streamlabsBasic(text) {
  return text
    .replace(/\$(username|user)\b/gi, '{user}')
    .replace(/\$(touser|targetname|target)\b/gi, '{touser}');
}

// Traduce un texto. Devuelve { text, info:[], warn:[], unsupported:[] }
function translateText(input, opts = {}) {
  const ctx = { info: [], warn: [] };
  const unsupported = [];
  let text = String(input === undefined || input === null ? '' : input).replace(/[\u0000-\u001f]+/g, ' ').trim();

  text = rewriteTokens(text, '$(', '(', ')', (inner, raw) => {
    const r = nightbotVar(inner, ctx);
    if (r === null) unsupported.push(raw);
    return r;
  });
  text = rewriteTokens(text, '${', '{', '}', (inner, raw) => {
    const r = streamelementsVar(inner, ctx);
    if (r === null) unsupported.push(raw);
    return r;
  });
  text = streamlabsBasic(text);
  text = text.replace(/\s{2,}/g, ' ').trim();

  // {variables} que SilklyBot no conoce (o que no sirven en un mensaje automático)
  const braces = text.match(/\{[^{}]*(?:\[[^\]]*\])?[^{}]*\}/g) || [];
  for (const b of braces) {
    const name = b.slice(1, -1);
    if (!KNOWN_VAR.some(re => re.test(name))) ctx.warn.push(b + ' no es una variable de SilklyBot');
    else if (opts.timer && NOT_FOR_TIMERS.test(name)) ctx.warn.push(b + ' no tiene sentido en un mensaje automático (no hay usuario ni comando)');
  }
  if (text.length > MAX_RESPONSE) ctx.warn.push('Tiene ' + text.length + ' caracteres y Twitch acepta máx. ' + MAX_RESPONSE);
  if (/^[\/.]/.test(text)) ctx.warn.push('Empieza con / o . y Twitch puede no mostrarlo');
  if (unsupported.length) ctx.warn.push('No se puede traducir: ' + unsupported.slice(0, 3).join(' ') + (unsupported.length > 3 ? '…' : ''));

  return { text, info: ctx.info, warn: ctx.warn, unsupported };
}

// ───────────────────────── Permisos y esperas ─────────────────────────

function mapNightbotLevel(level, info, warn) {
  const l = String(level === undefined || level === null || level === '' ? 'everyone' : level).toLowerCase().replace(/\s+/g, '_');
  if (l === 'everyone') return ['everyone'];
  if (l === 'regular') { info.push('Nivel "regular" pasa a Subs (no existe "regular")'); return ['sub']; }
  if (l === 'subscriber') return ['sub'];
  if (l === 'twitch_vip' || l === 'vip') return ['vip'];
  if (l === 'moderator' || l === 'mod' || l === 'super_moderator' || l === 'editor') return ['mod'];
  if (l === 'owner' || l === 'broadcaster') return ['broadcaster'];
  warn.push('Nivel de usuario desconocido ("' + level + '"): se dejó solo para mods');
  return ['mod'];
}

function mapStreamElementsLevel(n, info) {
  const v = Number(n);
  if (!Number.isFinite(v)) return ['everyone'];
  if (v >= 1500) return ['broadcaster'];
  if (v >= 500) return ['mod'];
  if (v >= 400) return ['vip'];
  if (v >= 300) return ['sub'];
  if (v >= 250) { info.push('Nivel "regular" pasa a Subs (no existe "regular")'); return ['sub']; }
  return ['everyone'];
}

function cleanCooldown(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 3600);
}

// ───────────────────────── Nombres ─────────────────────────

function normalizeName(raw, keepPlain) {
  let n = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!n) return '';
  if (keepPlain && !n.startsWith('!')) return n;
  if (!n.startsWith('!')) n = '!' + n;
  return n;
}

function nameProblem(name) {
  if (!name) return 'Sin nombre';
  if (name.startsWith('!')) {
    if (/\s/.test(name)) return 'El nombre tiene espacios';
    if (!BANG_NAME.test(name)) return 'Nombre no válido (usa letras y números, máx. 30)';
    return null;
  }
  if (!PLAIN_TRIGGER.test(name)) return 'Palabra suelta no válida (solo letras, números, emojis; máx. 30)';
  return null;
}

// ───────────────────────── Lectura de lo que pega el usuario ─────────────────────────

function tryJson(raw) {
  const t = raw.trim();
  if (!/^[\[{]/.test(t)) return undefined;
  try { return JSON.parse(t); } catch (e) { return undefined; }
}

function buildCommandItem(name, response, perms, cooldown, source, extraInfo, extraWarn, opts = {}) {
  const info = [...(extraInfo || [])];
  const warn = [...(extraWarn || [])];
  const tr = translateText(response);
  info.push(...tr.info);
  warn.push(...tr.warn.filter(w => !tr.unsupported.length || !w.startsWith('No se puede traducir')));
  const nameErr = nameProblem(name);
  let status = 'ok';
  if (nameErr || !tr.text) status = 'no';
  else if (tr.unsupported.length) status = 'no';
  else if (warn.length) status = 'revisar';
  const notes = [];
  if (nameErr) notes.push(nameErr);
  if (!tr.text) notes.push('La respuesta está vacía');
  if (tr.unsupported.length) notes.push('No se puede traducir: ' + tr.unsupported.slice(0, 3).join(' ') + (tr.unsupported.length > 3 ? '…' : ''));
  notes.push(...warn, ...info);
  return {
    name, response: tr.text, original: String(response === undefined || response === null ? '' : response),
    perms, cooldown, source, status, notes, unsupported: tr.unsupported,
  };
}

function parseCommands(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw);
  const items = [];
  const errors = [];
  const json = tryJson(text);

  if (json !== undefined) {
    let list = Array.isArray(json) ? json : (Array.isArray(json.commands) ? json.commands : (Array.isArray(json.data) ? json.data : null));
    if (!list) { errors.push('No encontré una lista de comandos en ese JSON'); return { items, errors }; }
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      if (c.enabled === false) continue;
      const info = [], warn = [];
      if (c.message !== undefined && c.name !== undefined) {                       // Nightbot
        items.push(buildCommandItem(normalizeName(c.name), c.message, mapNightbotLevel(c.userLevel, info, warn),
          cleanCooldown(c.coolDown), 'nightbot', info, warn));
      } else if (c.reply !== undefined && c.command !== undefined) {               // StreamElements
        const cd = c.cooldown && typeof c.cooldown === 'object' ? (c.cooldown.global || c.cooldown.user) : c.cooldown;
        items.push(buildCommandItem(normalizeName(c.command), c.reply, mapStreamElementsLevel(c.accessLevel, info),
          cleanCooldown(cd), 'streamelements', info, warn));
      } else {                                                                     // genérico
        const nm = c.name || c.command || c.trigger;
        const resp = c.response !== undefined ? c.response : (c.message !== undefined ? c.message : (c.reply !== undefined ? c.reply : c.text));
        if (nm !== undefined && resp !== undefined) items.push(buildCommandItem(normalizeName(nm), resp, ['everyone'], cleanCooldown(c.cooldown), 'texto', info, warn));
      }
    }
    if (!items.length) errors.push('No encontré comandos que se puedan leer en ese JSON');
  } else {
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const m = line.match(/^([^\s|;,:→]+)\s*(?:=>|→|[|;,:\t])?\s*(.*)$/u);
      if (!m || !m[2]) { errors.push('Línea sin respuesta: "' + line.slice(0, 40) + '"'); continue; }
      items.push(buildCommandItem(normalizeName(m[1]), m[2], ['everyone'], null, 'texto', [], []));
    }
    if (!items.length && !errors.length) errors.push('No encontré comandos. Escribe uno por línea: !comando respuesta');
  }

  // Si un nombre aparece dos veces, se queda el último
  const byName = new Map();
  for (const it of items) {
    if (byName.has(it.name)) { const prev = byName.get(it.name); it.notes.push('Estaba repetido: se usó la última versión'); void prev; }
    byName.set(it.name, it);
  }
  return { items: Array.from(byName.values()), errors };
}

function parseIntervalMinutes(v, info) {
  let min = null;
  if (typeof v === 'number' && Number.isFinite(v)) min = v;
  else if (typeof v === 'string') {
    const s = v.trim();
    let m;
    if (/^\d+$/.test(s)) min = Number(s);
    else if ((m = s.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/))) min = Number(m[1]);
    else if ((m = s.match(/^\d+\s+\*\/(\d+)\s+\*\s+\*\s+\*$/))) min = Number(m[1]) * 60;
    else if (/^\d+\s+\*\s+\*\s+\*\s+\*$/.test(s)) min = 60;
    else if ((m = s.match(/^(\d+)\s*(?:m|min|minutos?)$/i))) min = Number(m[1]);
  }
  if (min === null || !Number.isFinite(min) || min <= 0) { info.push('No pude leer el intervalo: se puso 20 minutos'); return 20; }
  if (min < 5) { info.push('El mínimo en SilklyBot es 5 minutos'); return 5; }
  if (min > 1440) { info.push('El máximo es 1440 minutos (24 h)'); return 1440; }
  return Math.round(min);
}

function buildTimerItem(message, interval, source, info) {
  const tr = translateText(message, { timer: true });
  const notes = [...tr.info, ...info];
  let status = 'ok';
  if (!tr.text) { status = 'no'; notes.unshift('El mensaje está vacío'); }
  else if (tr.unsupported.length) { status = 'no'; notes.unshift('No se puede traducir: ' + tr.unsupported.slice(0, 3).join(' ')); }
  else if (tr.warn.length) { status = 'revisar'; notes.unshift(...tr.warn); }
  return { text: tr.text, original: String(message === undefined || message === null ? '' : message), interval, source, status, notes, unsupported: tr.unsupported };
}

function parseTimers(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw);
  const items = [];
  const errors = [];
  const json = tryJson(text);
  if (json !== undefined) {
    const list = Array.isArray(json) ? json : (Array.isArray(json.timers) ? json.timers : null);
    if (!list) { errors.push('No encontré una lista de timers en ese JSON'); return { items, errors }; }
    for (const t of list) {
      if (!t || typeof t !== 'object' || t.enabled === false) continue;
      const msgs = Array.isArray(t.messages) ? t.messages : [t.message !== undefined ? t.message : t.text];
      const source = Array.isArray(t.messages) ? 'streamelements' : 'nightbot';
      for (const msg of msgs) {
        if (msg === undefined || msg === null) continue;
        const info = [];
        const interval = parseIntervalMinutes(t.interval, info);
        if (t.lines || t.chatLines) info.push('Pedía un mínimo de líneas de chat; SilklyBot ya espera a que haya actividad');
        items.push(buildTimerItem(msg, interval, source, info));
      }
    }
    if (!items.length) errors.push('No encontré timers que se puedan leer en ese JSON');
  } else {
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line || line.startsWith('#')) continue;
      const info = [];
      const m = line.match(/^(\d{1,4})\s*(?:m|min|minutos?)?\s*[|:]\s*(.+)$/i);
      const interval = m ? parseIntervalMinutes(Number(m[1]), info) : 20;
      items.push(buildTimerItem(m ? m[2] : line, interval, 'texto', info));
    }
    if (!items.length) errors.push('No encontré mensajes. Escribe uno por línea (opcional: "15 | mensaje" para elegir los minutos)');
  }
  return { items, errors };
}

// Marca choques con comandos propios del bot y con los que ya existen en el canal
function annotateConflicts(items, existing) {
  const have = new Set(Object.keys(existing || {}));
  for (const it of items) {
    it.conflict = RESERVED.has(it.name) ? 'reserved' : (have.has(it.name) ? 'exists' : null);
    it.selected = (it.status === 'ok' || it.status === 'revisar') && !it.conflict;
    if (it.conflict === 'reserved') it.notes.unshift(it.name + ' ya es un comando propio de SilklyBot: cámbiale el nombre');
    if (it.conflict === 'exists') it.notes.unshift('Ya tienes ' + it.name + ': marca para reemplazarlo');
  }
  return items;
}

// ───────────────────────── Validación final (lo que de verdad se guarda) ─────────────────────────

function sanitizeCommand(c) {
  if (!c || typeof c !== 'object') return { ok: false, error: 'Dato inválido' };
  const name = normalizeName(c.name, true);
  const prob = nameProblem(name);
  if (prob) return { ok: false, error: (name || '(sin nombre)') + ': ' + prob };
  if (RESERVED.has(name)) return { ok: false, error: name + ' es un comando propio de SilklyBot' };
  const response = String(c.response === undefined || c.response === null ? '' : c.response).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!response) return { ok: false, error: name + ': la respuesta está vacía' };
  if (response.length > MAX_RESPONSE) return { ok: false, error: name + ': la respuesta pasa de ' + MAX_RESPONSE + ' caracteres' };
  let perms = Array.isArray(c.perms) ? c.perms.filter(p => PERMS_OK.includes(p)) : [];
  if (!perms.length) perms = ['everyone'];
  const value = { response, perms };
  const cd = cleanCooldown(c.cooldown);
  if (cd !== null) value.cooldown = cd;
  return { ok: true, name, value };
}

function sanitizeTimer(t) {
  if (!t || typeof t !== 'object') return { ok: false, error: 'Dato inválido' };
  const text = String(t.text === undefined || t.text === null ? '' : t.text).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!text) return { ok: false, error: 'Hay un mensaje vacío' };
  if (text.length > MAX_RESPONSE) return { ok: false, error: 'Un mensaje pasa de ' + MAX_RESPONSE + ' caracteres' };
  const n = Math.round(Number(t.interval));
  const interval = Number.isFinite(n) ? Math.min(Math.max(n, 5), 1440) : 20;
  return { ok: true, value: { text, type: 'fixed', interval } };
}

module.exports = { parseCommands, parseTimers, translateText, annotateConflicts, sanitizeCommand, sanitizeTimer, RESERVED, MAX_RESPONSE };
