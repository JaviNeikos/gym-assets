const app = document.getElementById('app');
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
let clientId = store.get('retro-client');
if (!clientId) {
  clientId = crypto.randomUUID();
  store.set('retro-client', clientId);
}

const boardId = location.pathname.match(/^\/b\/([\w-]+)/)?.[1];
const adminParam = new URLSearchParams(location.search).get('admin');
if (boardId && adminParam) store.set('admin-' + boardId, adminParam);
const adminToken = boardId ? store.get('admin-' + boardId) : null;

function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', 'x-client-id': clientId, ...opts.headers };
  if (adminToken) headers['x-admin-token'] = adminToken;
  return fetch('/api' + path, { ...opts, headers }).then(async (r) => {
    const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  });
}

const h = (tag, props = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) el.append(k);
  return el;
};

// ---------- home ----------
async function home() {
  const cfg = await api('/config');
  const title = h('input', { placeholder: 'Título (p. ej. Retro sprint 42)', value: 'Retro' });
  const tpl = h('select', {}, ...Object.entries(cfg.templates).map(([k, cols]) => h('option', { value: k, textContent: `${k} — ${cols.join(' / ')}` })));
  const hide = h('input', { type: 'checkbox', checked: true });
  const anon = h('input', { type: 'checkbox', checked: true });
  const key = h('input', { type: 'password', placeholder: 'API key', value: store.get('retro-key') || '' });
  const err = h('p', { className: 'err' });
  const go = h('button', { className: 'primary', textContent: 'Crear tablero' });
  go.onclick = async () => {
    try {
      store.set('retro-key', key.value);
      const r = await api('/boards', {
        method: 'POST',
        headers: cfg.requiresKey ? { authorization: 'Bearer ' + key.value } : {},
        body: JSON.stringify({ title: title.value, template: tpl.value, hideUntilReveal: hide.checked, anonymous: anon.checked }),
      });
      location.href = r.adminUrl;
    } catch (e) { err.textContent = e.message; }
  };
  app.replaceChildren(h('div', { className: 'card' },
    h('h1', { textContent: 'Retro Board' }),
    h('p', { className: 'muted', textContent: 'Tableros de retrospectiva sin registro ni captchas. Comparte el enlace con tu equipo.' }),
    title, h('br'), tpl,
    h('label', {}, hide, 'Ocultar tarjetas hasta que el facilitador las revele'),
    h('label', {}, anon, 'Tarjetas anónimas'),
    cfg.requiresKey ? key : null,
    go, err));
}

// ---------- board ----------
let state;
function render() {
  const b = state;
  const name = store.get('retro-name') || '';
  const bar = h('div', { className: 'bar' },
    h('div', {}, h('h1', { textContent: b.title }),
      h('span', { className: 'muted', textContent: `Votos disponibles: ${b.myVotesLeft}/${b.maxVotes}` + (b.hideUntilReveal && !b.revealed ? ' · tarjetas ocultas hasta revelar' : '') })),
    h('div', { className: 'actions' },
      h('button', { textContent: 'Copiar enlace', onclick: () => navigator.clipboard?.writeText(location.origin + '/b/' + b.id) }),
      b.hideUntilReveal && b.isAdmin ? h('button', { className: 'primary', textContent: b.revealed ? 'Ocultar' : 'Revelar tarjetas', onclick: () => act('/boards/' + b.id + '/reveal', 'POST', { revealed: !b.revealed }) }) : null,
      h('button', { textContent: 'Exportar .md', onclick: exportMd }),
      b.isAdmin ? h('button', { className: 'danger', textContent: 'Borrar tablero', onclick: del }) : null));

  const cols = b.columns.map((c) => {
    const notes = b.notes.filter((n) => n.column === c.id).sort((a, z) => z.votes - a.votes || a.createdAt - z.createdAt);
    const input = h('input', { placeholder: 'Añadir tarjeta…', maxLength: 500 });
    const add = async () => {
      if (!input.value.trim()) return;
      await act('/boards/' + b.id + '/notes', 'POST', { column: c.id, text: input.value, author: store.get('retro-name') || 'Anónimo' });
    };
    input.onkeydown = (e) => e.key === 'Enter' && add();
    return h('section', { className: 'col' }, h('h2', { textContent: c.name }),
      notes.map((n) => h('div', { className: 'note' + (n.hidden ? ' hidden' : '') },
        h('div', { className: 'text', textContent: n.hidden ? 'Tarjeta oculta de otra persona' : n.text }),
        h('div', { className: 'meta' }, h('span', { textContent: n.author || '' }),
          h('span', {},
            n.hidden ? null : h('button', { className: n.voted ? 'voted' : '', textContent: '👍 ' + n.votes, onclick: () => act('/boards/' + b.id + '/notes/' + n.id, 'POST') }),
            n.mine || b.isAdmin ? h('button', { textContent: '✕', title: 'Borrar', onclick: () => act('/boards/' + b.id + '/notes/' + n.id, 'DELETE') }) : null)))),
      h('div', { className: 'add' }, input, h('button', { textContent: '+', onclick: add })));
  });

  const nameInput = !b.anonymous ? h('input', { placeholder: 'Tu nombre', value: name, oninput: (e) => store.set('retro-name', e.target.value) }) : null;
  const err = h('p', { className: 'err', id: 'err' });
  app.replaceChildren(bar, nameInput, err, h('div', { className: 'cols' }, cols));
}

async function act(path, method, body) {
  try {
    state = await api(path, { method, body: body && JSON.stringify(body) });
    render();
  } catch (e) {
    const el = document.getElementById('err');
    if (el) el.textContent = e.message;
  }
}
async function exportMd() {
  try {
    const md = await api(`/boards/${boardId}/export`);
    const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `${state.title}.md` });
    a.click();
  } catch (e) { document.getElementById('err').textContent = e.message; }
}
async function del() {
  if (!confirm('¿Borrar el tablero para todos?')) return;
  await api('/boards/' + boardId, { method: 'DELETE' });
  location.href = '/';
}

async function board() {
  try {
    state = await api('/boards/' + boardId);
  } catch (e) {
    app.replaceChildren(h('div', { className: 'card' }, h('h1', { textContent: 'Tablero no encontrado' }), h('a', { href: '/', textContent: 'Crear uno nuevo' })));
    return;
  }
  render();
  const es = new EventSource(`/api/boards/${boardId}/events`);
  es.addEventListener('update', async () => {
    try { state = await api('/boards/' + boardId); render(); } catch { location.href = '/'; }
  });
}

boardId ? board() : home();
