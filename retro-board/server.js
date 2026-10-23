import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'boards.json');
const BOARD_TTL_MS = 90 * 24 * 3600 * 1000;
const MAX_NOTES = 500;
const MAX_TEXT = 500;

export const TEMPLATES = {
  'went-well': ['Qué fue bien', 'Qué mejorar', 'Acciones'],
  'start-stop-continue': ['Empezar', 'Parar', 'Continuar'],
  'mad-sad-glad': ['Enfadado', 'Triste', 'Contento'],
  '4ls': ['Liked', 'Learned', 'Lacked', 'Longed for'],
};

const id = (n = 6) => crypto.randomBytes(n).toString('base64url');

// ---------- persistence ----------
let boards = {};
try {
  boards = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(boards));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  }, 200);
}
function sweep() {
  const now = Date.now();
  for (const [k, b] of Object.entries(boards)) if (b.expiresAt < now) delete boards[k];
  save();
}
setInterval(sweep, 3600 * 1000).unref();

// ---------- realtime ----------
const listeners = new Map(); // boardId -> Set<res>
function notify(boardId) {
  for (const res of listeners.get(boardId) || []) res.write('event: update\ndata: {}\n\n');
}

// ---------- rate limit (creación de tableros) ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 30;
}

// ---------- vistas ----------
function view(b, clientId, isAdmin) {
  const reveal = !b.hideUntilReveal || b.revealed;
  return {
    id: b.id,
    title: b.title,
    columns: b.columns,
    anonymous: b.anonymous,
    hideUntilReveal: b.hideUntilReveal,
    revealed: b.revealed,
    maxVotes: b.maxVotes,
    isAdmin,
    myVotesLeft: b.maxVotes - b.notes.filter((n) => n.votes.includes(clientId)).length,
    notes: b.notes.map((n) => {
      const mine = n.authorId === clientId;
      const visible = reveal || mine;
      return {
        id: n.id,
        column: n.column,
        text: visible ? n.text : null,
        hidden: !visible,
        mine,
        author: !b.anonymous && visible ? n.authorName : null,
        votes: n.votes.length,
        voted: n.votes.includes(clientId),
        createdAt: n.createdAt,
      };
    }),
  };
}

function exportMarkdown(b) {
  const v = view(b, null, false);
  const lines = [`# ${b.title}`, ''];
  for (const col of v.columns) {
    lines.push(`## ${col.name}`, '');
    const notes = v.notes
      .filter((n) => n.column === col.id && !n.hidden)
      .sort((a, c) => c.votes - a.votes);
    if (!notes.length) lines.push('_(vacío)_');
    for (const n of notes) {
      lines.push(`- ${n.text}${n.votes ? ` (+${n.votes})` : ''}${n.author ? ` — ${n.author}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- http helpers ----------
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type + '; charset=utf-8' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 20_000) throw Object.assign(new Error('Body demasiado grande'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw Object.assign(new Error('JSON inválido'), { status: 400 });
  }
}
const fail = (status, msg) => Object.assign(new Error(msg), { status });

const STATIC = { '/app.js': 'application/javascript', '/style.css': 'text/css' };

// ---------- servidor ----------
export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const clientId = String(req.headers['x-client-id'] || url.searchParams.get('client') || 'anon').slice(0, 64);

    if (req.method === 'GET' && (p === '/' || p.startsWith('/b/'))) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), 'text/html');
    }
    if (req.method === 'GET' && STATIC[p]) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', p), 'utf8'), STATIC[p]);
    }
    if (!p.startsWith('/api/')) throw fail(404, 'No encontrado');

    if (req.method === 'GET' && p === '/api/config') {
      return send(res, 200, { requiresKey: !!API_KEY, templates: TEMPLATES });
    }

    if (req.method === 'POST' && p === '/api/boards') {
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (API_KEY && bearer !== API_KEY) throw fail(401, 'API key requerida');
      if (rateLimited(req.socket.remoteAddress)) throw fail(429, 'Demasiadas peticiones');
      const body = await readJson(req);
      const names = Array.isArray(body.columns) && body.columns.length
        ? body.columns.map(String)
        : TEMPLATES[body.template || 'went-well'];
      if (!names) throw fail(400, 'Plantilla desconocida');
      const b = {
        id: id(5),
        adminToken: id(12),
        title: String(body.title || 'Retro').slice(0, 120),
        columns: names.slice(0, 8).map((name) => ({ id: id(3), name: name.slice(0, 60) })),
        anonymous: body.anonymous !== false,
        hideUntilReveal: !!body.hideUntilReveal,
        revealed: false,
        maxVotes: Number(body.maxVotes) || 5,
        notes: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + BOARD_TTL_MS,
      };
      boards[b.id] = b;
      save();
      const origin = process.env.PUBLIC_URL || `http://${req.headers.host}`;
      return send(res, 201, {
        id: b.id,
        url: `${origin}/b/${b.id}`,
        adminUrl: `${origin}/b/${b.id}?admin=${b.adminToken}`,
        adminToken: b.adminToken,
        columns: b.columns,
      });
    }

    const m = p.match(/^\/api\/boards\/([\w-]+)(?:\/([\w-]+))?(?:\/([\w-]+))?$/);
    if (!m) throw fail(404, 'No encontrado');
    const b = boards[m[1]];
    if (!b) throw fail(404, 'Tablero no encontrado');
    const [, , sub, subId] = m;
    const adminToken = String(req.headers['x-admin-token'] || url.searchParams.get('admin') || '');
    const isAdmin = adminToken.length > 0 && adminToken === b.adminToken;
    const requireAdmin = () => {
      if (!isAdmin) throw fail(403, 'Solo el facilitador');
    };

    if (req.method === 'GET' && !sub) return send(res, 200, view(b, clientId, isAdmin));

    if (req.method === 'GET' && sub === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      if (!listeners.has(b.id)) listeners.set(b.id, new Set());
      listeners.get(b.id).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        listeners.get(b.id)?.delete(res);
      });
      return;
    }

    if (req.method === 'GET' && sub === 'export') {
      if (b.hideUntilReveal && !b.revealed) throw fail(403, 'Aún no se han revelado las tarjetas');
      return send(res, 200, exportMarkdown(b), 'text/markdown');
    }

    if (req.method === 'POST' && sub === 'notes' && !subId) {
      const body = await readJson(req);
      const text = String(body.text || '').trim().slice(0, MAX_TEXT);
      if (!text) throw fail(400, 'Texto vacío');
      if (!b.columns.some((c) => c.id === body.column)) throw fail(400, 'Columna inexistente');
      if (b.notes.length >= MAX_NOTES) throw fail(429, 'Tablero lleno');
      b.notes.push({
        id: id(4),
        column: body.column,
        text,
        authorId: clientId,
        authorName: String(body.author || 'Anónimo').slice(0, 40),
        votes: [],
        createdAt: Date.now(),
      });
      save();
      notify(b.id);
      return send(res, 201, view(b, clientId, isAdmin));
    }

    if (sub === 'notes' && subId) {
      const note = b.notes.find((n) => n.id === subId);
      if (!note) throw fail(404, 'Tarjeta no encontrada');
      if (req.method === 'DELETE') {
        if (note.authorId !== clientId && !isAdmin) throw fail(403, 'No es tu tarjeta');
        b.notes = b.notes.filter((n) => n !== note);
      } else if (req.method === 'POST') {
        // alterna el voto
        const visible = !b.hideUntilReveal || b.revealed || note.authorId === clientId;
        if (!visible) throw fail(403, 'Tarjeta oculta');
        if (note.votes.includes(clientId)) note.votes = note.votes.filter((v) => v !== clientId);
        else {
          const used = b.notes.filter((n) => n.votes.includes(clientId)).length;
          if (used >= b.maxVotes) throw fail(409, 'Sin votos disponibles');
          note.votes.push(clientId);
        }
      } else throw fail(405, 'Método no permitido');
      save();
      notify(b.id);
      return send(res, 200, view(b, clientId, isAdmin));
    }

    if (req.method === 'POST' && sub === 'reveal') {
      requireAdmin();
      const body = await readJson(req);
      b.revealed = body.revealed !== false;
      save();
      notify(b.id);
      return send(res, 200, view(b, clientId, isAdmin));
    }

    if (req.method === 'DELETE' && !sub) {
      requireAdmin();
      delete boards[b.id];
      save();
      notify(b.id);
      return send(res, 200, { ok: true });
    }

    throw fail(404, 'No encontrado');
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
    if (!e.status) console.error(e);
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Retro board en http://localhost:${PORT}`));
}
