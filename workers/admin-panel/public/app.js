/**
 * jouska 管理面板前端——零构建 vanilla JS。
 *
 * 与 API 同源部署，Cookie 自动携带；非 GET 请求带 Origin（浏览器自动），
 * CSRF 由服务端的同源校验把关。发布是唯一的 KV 写入， UI 上永远二次确认。
 */

const $ = (sel) => document.querySelector(sel);

/** 所有非 GET 请求统一从这里走：同源 + JSON + 统一错误形状。 */
const api = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 404 静态页等非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
};

const setMsg = (el, text, cls = '') => {
  el.textContent = text;
  el.className = `msg ${cls}`;
};

/** 所有进入 innerHTML 的插值都过这里——路径等字段是自由文本。 */
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

/* ---------- 视图切换 ---------- */

const views = ['routes', 'preview', 'audit'];
const show = (name) => {
  for (const v of views) $(`#view-${v}`).hidden = v !== name;
  document
    .querySelectorAll('.navbtn')
    .forEach((b) => b.classList.toggle('primary', b.dataset.view === name));
};

/* ---------- 登录 / 引导 ---------- */

let me = null;

const enterApp = (user) => {
  me = user;
  $('#whoami').textContent = `${user.subject}（${user.role === 'admin' ? '管理员' : '观察者'}）`;
  $('#topbar').hidden = false;
  $('#view-auth').hidden = true;
  show('routes');
  loadRoutes();
};

const showAuth = (bootstrapable) => {
  me = null;
  $('#topbar').hidden = true;
  $('#view-auth').hidden = false;
  for (const v of views) $(`#view-${v}`).hidden = true;
  $('#bootstrapToggle').hidden = !bootstrapable;
  // 每次回到登录页都收起恢复框：它是例外路径，不该常驻。
  $('#recoverBox').hidden = true;
  setMsg($('#recoverMsg'), '');
  if (bootstrapable) {
    $('#authTitle').textContent = '首次部署';
    $('#authSubmit').textContent = '创建管理员';
  } else {
    $('#authTitle').textContent = '登录';
    $('#authSubmit').textContent = '登录';
  }
};

$('#bootstrapToggle').addEventListener('click', (e) => {
  e.preventDefault();
  // 引导和登录共用一个表单，开关只改文案与提交目标。
  const toBootstrap = $('#authSubmit').textContent === '登录';
  showAuth(toBootstrap);
});

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const payload = { subject: form.get('subject'), password: form.get('password') };
  const bootstrap = $('#authSubmit').textContent === '创建管理员';
  const msg = $('#authMsg');
  // 上一次尝试的提示必须先清掉，否则失败后重试成功时，旧文案还留在屏幕上。
  setMsg(msg, '');
  try {
    // 按当前模式分派：登录态下无条件先打 bootstrap 会拿到 409，
    // 常规登录就永远走不到 login 那一步。
    if (bootstrap) {
      await api('POST', '/api/auth/bootstrap', payload);
      setMsg(msg, '管理员已创建，正在登录…', 'ok');
    }
    const { user } = await api('POST', '/api/auth/login', payload);
    // 角色以服务端返回为准，不假设新建的一定是管理员。
    enterApp(user ?? { subject: payload.subject, role: 'admin' });
  } catch (err) {
    const hints = {
      invalid_credentials: '账号或密码不对。',
      locked: `试错太多次，账号锁定了，${Math.ceil((err.data?.retryAfterSeconds ?? 900) / 60)} 分钟后再来。`,
      already_bootstrapped: '已初始化过，请直接登录。',
      invalid_input: '密码至少 12 位。',
    };
    setMsg(msg, hints[err.message] ?? `失败：${err.message}`, 'err');
  }
});

/* ---------- 带外恢复 ---------- */

$('#recoverToggle').addEventListener('click', (e) => {
  e.preventDefault();
  const box = $('#recoverBox');
  box.hidden = !box.hidden;
});

$('#recoverForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const msg = $('#recoverMsg');
  setMsg(msg, '');
  try {
    await api('POST', '/api/auth/recover', {
      subject: form.get('subject'),
      token: form.get('token'),
      password: form.get('password'),
    });
    setMsg(msg, '密码已重置，正在登录…', 'ok');
    const { user } = await api('POST', '/api/auth/login', {
      subject: form.get('subject'),
      password: form.get('password'),
    });
    enterApp(user);
  } catch (err) {
    // 服务端刻意不区分"没开窗口/令牌不对/已过期"，前端也不能替它猜。
    const hints = {
      recovery_unavailable: '没能重置。检查令牌是否写对、是否已过期、账号名是否正确。',
      invalid_input: '新密码至少 12 位，令牌至少 16 位。',
    };
    setMsg(msg, hints[err.message] ?? `失败：${err.message}`, 'err');
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await api('POST', '/api/auth/logout');
  } catch {
    /* 会话已无效也无妨 */
  }
  showAuth(false);
});

/* ---------- 路由表 ---------- */

const routeCache = [];

const matchText = (definition) => {
  const m = definition?.match ?? {};
  return [m.host ?? '*', m.path ?? '(任何路径)'].join(' ');
};

const loadRoutes = async () => {
  const msg = $('#routesMsg');
  try {
    const { routes } = await api('GET', '/api/routes');
    routeCache.length = 0;
    routeCache.push(...routes);
    $('#routeCount').textContent = `共 ${routes.length} 条`;
    const tbody = $('#routeRows');
    tbody.innerHTML = '';
    routes.forEach((r, i) => {
      const d = r.definition ?? {};
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td><code>${esc(r.id)}</code></td>
        <td><code>${esc(matchText(d))}</code></td>
        <td><code>${esc(d.upstream ?? '?')}</code></td>
        <td><span class="badge ${r.enabled ? 'on' : 'off'}">${r.enabled ? '启用' : '停用'}</span></td>
        <td class="row">
          <button class="ghost" data-act="up" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
          <button class="ghost" data-act="down" ${i === routes.length - 1 ? 'disabled' : ''} title="下移">↓</button>
          <button class="ghost" data-act="edit">编辑</button>
          <button class="ghost" data-act="del">删除</button>
        </td>`;
      tbody.appendChild(tr);
    });
    setMsg(msg, me?.role === 'viewer' ? '观察者：只读' : '');
  } catch (err) {
    setMsg(msg, `加载失败：${err.message}`, 'err');
  }
};

$('#routeRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (btn === null || me?.role !== 'admin') return;
  const tr = btn.closest('tr');
  const index = [...$('#routeRows').children].indexOf(tr);
  const route = routeCache[index];
  const act = btn.dataset.act;

  if (act === 'edit') {
    openEditor(route.id, route.definition, route.enabled);
  } else if (act === 'up' || act === 'down') {
    const ids = routeCache.map((r) => r.id);
    const j = act === 'up' ? index - 1 : index + 1;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    try {
      await api('PUT', '/api/routes-order', { ids });
      loadRoutes();
    } catch (err) {
      setMsg($('#routesMsg'), `排序失败：${err.message}`, 'err');
    }
  } else if (act === 'del') {
    if (!confirm(`删除路由 "${route.id}"？不影响已发布配置，直到下次发布。`)) return;
    try {
      await api('DELETE', `/api/routes/${route.id}`);
      loadRoutes();
    } catch (err) {
      setMsg($('#routesMsg'), `删除失败：${err.message}`, 'err');
    }
  }
});

$('#newRouteBtn').addEventListener('click', () => {
  if (me?.role !== 'admin') return;
  openEditor(
    '',
    {
      match: { host: 'app.example.com', path: '/' },
      upstream: 'app.internal.example.com',
      timeoutMs: 5000,
    },
    true,
  );
});

$('#saveDefaultsBtn').addEventListener('click', async () => {
  if (me?.role !== 'admin') return;
  const msg = $('#defaultsMsg');
  try {
    const value =
      $('#defaultsJson').value.trim() === '' ? {} : JSON.parse($('#defaultsJson').value);
    await api('PUT', '/api/defaults', { defaults: value });
    setMsg(msg, '已保存（发布后生效）', 'ok');
  } catch (err) {
    setMsg(msg, err instanceof SyntaxError ? 'JSON 格式不对' : `保存失败：${err.message}`, 'err');
  }
});

/* ---------- 路由编辑器 ---------- */

let editingId = null;

const openEditor = (id, definition, enabled) => {
  editingId = id === '' ? null : id;
  $('#editorTitle').textContent = editingId === null ? '新建路由' : `编辑路由 ${editingId}`;
  $('#editorId').value = editingId ?? '';
  $('#editorId').disabled = editingId !== null;
  $('#editorEnabled').checked = enabled;
  $('#editorJson').value = JSON.stringify(definition, null, 2);
  setMsg($('#editorMsg'), '');
  $('#editorOverlay').hidden = false;
};

$('#editorCancel').addEventListener('click', () => {
  $('#editorOverlay').hidden = true;
});

$('#editorSave').addEventListener('click', async () => {
  const msg = $('#editorMsg');
  let definition;
  try {
    definition = JSON.parse($('#editorJson').value);
  } catch {
    return setMsg(msg, 'JSON 格式不对', 'err');
  }
  const id = editingId ?? $('#editorId').value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))
    return setMsg(msg, 'ID：字母开头，可含数字 . _ -，最长 64', 'err');
  try {
    await api('PUT', `/api/routes/${id}`, { definition, enabled: $('#editorEnabled').checked });
    $('#editorOverlay').hidden = true;
    loadRoutes();
  } catch (err) {
    setMsg(
      msg,
      `保存失败：${err.message}${err.data?.detail ? `（${err.data.detail}）` : ''}`,
      'err',
    );
  }
});

/* ---------- 预览 + 发布 ---------- */

/** keepMsg：发布成功后刷新预览时保留刚写的提示，否则它会被清空。 */
const loadPreview = async (keepMsg = false) => {
  const box = $('#previewBody');
  const msg = $('#publishMsg');
  try {
    const p = await api('GET', '/api/preview');
    // 空表不是故障，是还没开始：刚部署完就说"配置有错"只会吓人。
    if (p.empty === true) {
      box.innerHTML = `<p class="muted">还没有路由。到「路由」页新建一条，再回来发布给反代。</p>`;
      $('#publishBtn').disabled = true;
      if (!keepMsg) setMsg(msg, '');
      return;
    }
    if (!p.ok) {
      box.innerHTML =
        `<p>当前配置有错，不能发布：</p>` +
        (p.issues ?? [])
          .map(
            (i) =>
              `<div class="issue"><b>${esc(i.routeId ?? '(表)')}</b> <code>${esc(i.path)}</code> — ${esc(i.message)}</div>`,
          )
          .join('');
      $('#publishBtn').disabled = true;
      return;
    }
    let html = `<p><span class="badge on">${p.routeCount} 条路由</span>`;
    const shadows = p.shadowWarnings ?? [];
    if (shadows.length > 0) {
      html +=
        ` <span class="badge warn">${shadows.length} 条被遮蔽</span></p>` +
        shadows
          .map(
            (s) =>
              `<div class="shadow">⚠ <b>${esc(s.shadowedId)}</b> 被 <b>${esc(s.byId)}</b> 完全遮蔽（试探路径 <code>${esc(s.probe)}</code>）</div>`,
          )
          .join('');
    } else {
      html += `</p>`;
    }
    const dangerIds = Object.keys(p.dangers ?? {});
    if (dangerIds.length > 0) {
      html +=
        `<p>以下路由带危险开关，发布时需要确认：</p>` +
        dangerIds
          .map((id) =>
            p.dangers[id]
              .map(
                (r) =>
                  `<div class="danger"><b>${esc(id)}</b> — <code>${esc(r.path)}</code>（${esc(r.level)}）：${esc(r.reason)}</div>`,
              )
              .join(''),
          )
          .join('');
    }
    html += `<details><summary>生成的文档（写入 KV 的就是它）</summary><pre>${esc(JSON.stringify(p.document, null, 2))}</pre></details>`;
    box.innerHTML = html;
    $('#publishBtn').disabled = false;
    if (!keepMsg) setMsg(msg, '');
  } catch (err) {
    setMsg(msg, `预览失败：${err.message}`, 'err');
  }
};

/** 发布一次；confirm 为 true 时表示用户已在弹窗里认过危险开关。 */
const publish = async (confirmed) => {
  const msg = $('#publishMsg');
  const note = $('#publishNote').value.trim();
  try {
    const res = await api('POST', '/api/publish', {
      ...(note === '' ? {} : { note }),
      ...(confirmed ? { confirm: true } : {}),
    });
    setMsg(msg, `已发布，revision ${res.revision}`, 'ok');
    await loadPreview(true);
  } catch (err) {
    // 服务端要求确认：列出到底哪几项危险，认下了才真正重发一次。
    // 先前这里第一次就带 confirm: true，等于把二次确认绕过去了。
    if (err.data?.error === 'confirmation_required') {
      const lines = Object.entries(err.data.dangers ?? {})
        .flatMap(([id, risks]) => risks.map((r) => `· ${id} — ${r.path}（${r.level}）`))
        .join('\n');
      if (confirm(`该配置含危险开关：\n\n${lines}\n\n确认发布？`)) {
        await publish(true);
      } else {
        setMsg(msg, '已取消，未发布。');
      }
      return;
    }
    if (err.data?.empty === true) {
      setMsg(msg, '还没有路由可发布。', 'err');
      return;
    }
    setMsg(msg, `发布失败：${err.message}`, 'err');
  }
};

$('#publishBtn').addEventListener('click', () => publish(false));

/* ---------- 审计 ---------- */

const loadAudit = async () => {
  try {
    const { entries } = await api('GET', '/api/audit?limit=100');
    $('#auditRows').innerHTML = entries
      .map(
        (e) => `
      <tr>
        <td>${new Date(e.at * 1000).toLocaleString()}</td>
        <td>${esc(e.actor)}</td>
        <td><code>${esc(e.action)}</code></td>
        <td>${esc(e.target ?? '')}</td>
      </tr>`,
      )
      .join('');
  } catch (err) {
    setMsg($('#routesMsg'), `审计加载失败：${err.message}`, 'err');
  }
};

$('#refreshAuditBtn').addEventListener('click', loadAudit);
$('#refreshPreviewBtn').addEventListener('click', loadPreview);

/* ---------- 启动：探测登录态 ---------- */

document.querySelectorAll('.navbtn').forEach((b) =>
  b.addEventListener('click', () => {
    show(b.dataset.view);
    if (b.dataset.view === 'preview') loadPreview();
    if (b.dataset.view === 'audit') loadAudit();
  }),
);

(async () => {
  try {
    const { user, bootstrapable } = await api('GET', '/api/auth/me');
    if (user !== null && user !== undefined) return enterApp(user);
    showAuth(bootstrapable === true);
    return;
  } catch {
    /* /me 不可达也落到登录页 */
  }
  showAuth(false);
})();
