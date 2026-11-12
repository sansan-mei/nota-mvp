const $ = (s) => document.querySelector(s);
const state = { user: localStorage.getItem('nota.user') || 'u_free_1', tab: 'todos', last: null, busy: false };

const TOOL_LABEL = {
  save_summary: '保存摘要',
  create_todo: '创建待办',
  create_reminder: '设置提醒',
  create_calendar_event: '创建日程',
  search_history: '检索历史便签',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function api(path, opts = {}) {
  return fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'x-user-id': state.user, ...(opts.headers || {}) } });
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function renderQuota(q) {
  const el = $('#quota');
  if (!q) return;
  if (q.plan === 'pro') {
    el.textContent = `Pro 不限次 · 今日已用 ${q.used}`;
    el.classList.remove('empty');
  } else {
    el.textContent = `今日剩余 ${q.remaining}/${q.limit}`;
    el.classList.toggle('empty', q.remaining === 0);
  }
}

async function loadMe() {
  const res = await api('/api/me');
  const me = await res.json();
  renderQuota(me.quota);
  $('#model').textContent = `模型：${me.model}`;
}

async function loadUsers() {
  const users = await (await fetch('/api/users')).json();
  $('#user').innerHTML = users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  $('#user').value = state.user;
}

/* ---------- Agent 过程 ---------- */
function stepsReset(info) {
  $('#steps').innerHTML = '';
  $('#reply').classList.add('hidden');
  $('#reqinfo').textContent = info || '';
}
function stepAdd(html, cls = '') {
  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = html;
  $('#steps').appendChild(li);
}
function renderStep(step) {
  if (step.kind === 'reply') {
    $('#reply').textContent = step.content;
    $('#reply').classList.remove('hidden');
    return;
  }
  const ok = step.result?.ok;
  const badge = ok ? '<span class="badge ok">成功</span>' : '<span class="badge err">失败，模型将修正</span>';
  stepAdd(
    `<div>${step.seq}. <span class="name">${esc(step.name)}</span> · ${esc(TOOL_LABEL[step.name] || '')}${badge}</div>
     <pre>参数 ${esc(JSON.stringify(step.args, null, 0))}\n结果 ${esc(JSON.stringify(step.result, null, 0))}</pre>`,
    `tool ${ok ? '' : 'fail'}`,
  );
}

/* ---------- 发送（NDJSON 流） ---------- */
async function submit(text, requestId) {
  if (state.busy) return;
  state.busy = true;
  $('#send').disabled = true;
  state.last = { text, requestId };
  $('#replay').disabled = false;
  stepsReset(`requestId: ${requestId.slice(0, 8)}…`);
  stepAdd('已发送，等待服务端…', 'sys');
  try {
    const res = await api('/api/notes', { method: 'POST', body: JSON.stringify({ requestId, text }) });
    if (res.headers.get('content-type')?.includes('application/json')) {
      const body = await res.json();
      $('#steps').innerHTML = '';
      stepAdd(`⚠️ ${esc(body.message || body.error)}（HTTP ${res.status}）`, 'fail');
      if (body.quota) renderQuota(body.quota);
      return;
    }
    $('#steps').innerHTML = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handleEvent(JSON.parse(line));
      }
    }
  } catch (e) {
    stepAdd(`网络错误：${esc(e.message)}。可以点“重发上一请求”，同一个 requestId 不会重复扣次。`, 'fail');
  } finally {
    state.busy = false;
    $('#send').disabled = false;
    refreshPanel();
  }
}

function handleEvent(ev) {
  if (ev.type === 'accepted') {
    stepAdd(ev.charged ? `已受理，扣除 1 次额度（第 ${ev.attempt} 次尝试）` : `已受理（Pro 不计次）`, 'sys');
    renderQuota(ev.quota);
  } else if (ev.type === 'step') {
    renderStep(ev.step);
  } else if (ev.type === 'done') {
    if (ev.replayed) {
      stepAdd('🔁 这个 requestId 已经处理过：直接返回原结果，<b>没有重复扣次</b>', 'sys');
      if (ev.note?.reply) {
        $('#reply').textContent = ev.note.reply;
        $('#reply').classList.remove('hidden');
      }
    }
    const n = ev.note;
    if (n) {
      const parts = [];
      if (n.summary) parts.push(`摘要：${n.summary}`);
      parts.push(`待办 ${n.todos.length} · 日程 ${n.events.length} · 提醒 ${n.reminders.length}`);
      stepAdd(`✅ 已保存（便签 #${n.id}）<pre>${esc(parts.join('\n'))}</pre>`, 'sys');
    }
    renderQuota(ev.quota);
  } else if (ev.type === 'error') {
    stepAdd(`❌ ${esc(ev.message)}${ev.refunded ? '，<b>额度已返还</b>' : ''}`, 'fail');
    renderQuota(ev.quota);
  }
}

/* ---------- 右侧面板 ---------- */
async function refreshPanel() {
  const panel = $('#panel');
  if (state.tab === 'notes') {
    const notes = await (await api('/api/notes')).json();
    panel.innerHTML = notes.length
      ? notes
          .map(
            (n) => `<div class="item note"><div class="main">
              <div class="input">${esc(n.input)}</div>
              ${n.summary ? `<div class="summary">摘要：${esc(n.summary)}</div>` : ''}
              <div class="sub">${esc(n.created_local)} · 待办 ${n.todos.length} · 日程 ${n.events.length} · 提醒 ${n.reminders.length}</div>
            </div></div>`,
          )
          .join('')
      : '<p class="muted">还没有便签</p>';
    return;
  }
  const items = await (await api('/api/items')).json();
  const list = items[state.tab];
  if (!list.length) {
    panel.innerHTML = '<p class="muted">暂无</p>';
    return;
  }
  panel.innerHTML = list
    .map((x) => {
      if (state.tab === 'todos')
        return `<div class="item ${x.done ? 'done' : ''}"><input type="checkbox" data-todo="${x.id}" ${x.done ? 'checked' : ''}/>
          <div class="main"><div class="title">${esc(x.title)}</div><div class="sub">${x.due_date ? '截止 ' + esc(x.due_date) : '无截止日期'} · 来自便签 #${x.note_id}</div></div>
          <button class="x" data-del="todos/${x.id}" title="删除">✕</button></div>`;
      if (state.tab === 'events')
        return `<div class="item"><div class="main"><div class="title">📅 ${esc(x.title)}</div>
          <div class="sub">${esc(x.start_local)} – ${esc(x.end_local.slice(11))}${x.location ? ' · ' + esc(x.location) : ''}</div></div>
          <button class="x" data-del="events/${x.id}" title="撤销">✕</button></div>`;
      return `<div class="item"><div class="main"><div class="title">⏰ ${esc(x.title)}</div><div class="sub">${esc(x.remind_at_local)}</div></div>
          <button class="x" data-del="reminders/${x.id}" title="撤销">✕</button></div>`;
    })
    .join('');
}

$('#panel').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    await api(`/api/${del.dataset.del}`, { method: 'DELETE' });
    toast('已撤销');
    refreshPanel();
  }
});
$('#panel').addEventListener('change', async (e) => {
  const id = e.target.dataset.todo;
  if (id) {
    await api(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ done: e.target.checked }) });
    refreshPanel();
  }
});
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    state.tab = b.dataset.tab;
    refreshPanel();
  }),
);

/* ---------- 输入 ---------- */
$('#send').addEventListener('click', () => {
  const text = $('#text').value.trim();
  if (!text) return toast('先说点什么或输入一段话');
  submit(text, crypto.randomUUID());
});
$('#text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#send').click();
});
$('#replay').addEventListener('click', () => {
  if (state.last) submit(state.last.text, state.last.requestId);
});
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => ($('#text').value = c.textContent)));
$('#user').addEventListener('change', (e) => {
  state.user = e.target.value;
  localStorage.setItem('nota.user', state.user);
  state.last = null;
  $('#replay').disabled = true;
  stepsReset();
  loadMe();
  refreshPanel();
});

// 按住说话：浏览器自带语音识别（模拟硬件按键录音 + 云端转写）
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
  $('#mic').disabled = true;
  $('#mic').title = '当前浏览器不支持语音识别，请直接输入文字';
} else {
  let rec = null;
  let base = '';
  const start = (e) => {
    e.preventDefault();
    if (rec) return;
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = true;
    base = $('#text').value;
    rec.onresult = (ev) => {
      let s = '';
      for (const r of ev.results) s += r[0].transcript;
      $('#text').value = base + s;
    };
    rec.onerror = (ev) => toast(`语音识别失败：${ev.error}`);
    rec.onend = () => {
      rec = null;
      $('#mic').classList.remove('rec');
    };
    rec.start();
    $('#mic').classList.add('rec');
  };
  const stop = () => rec?.stop();
  $('#mic').addEventListener('pointerdown', start);
  $('#mic').addEventListener('pointerup', stop);
  $('#mic').addEventListener('pointerleave', stop);
}

await loadUsers();
await loadMe();
refreshPanel();
