const MAX_RECORD_BYTES = 240 * 1024;
const NOTES_COLLECTION = 'metrics';
const NOTE_PREFIX = 'note:';
const WINDOW_KEYS = ['5m', '1h', 'today', '7d', '30d'];

const DEFAULT_BUDGET = {
  schema_version: 1,
  monthly_tokens_m: 15,
  warn_pct: 70,
  critical_pct: 90,
  alert_note: '',
};

const r2 = n => Math.round(n * 100) / 100;
const r4 = n => Math.round(n * 10000) / 10000;

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function nullableInt(v) {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function nullableNum(v, max = Infinity) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const clamped = v > max ? max : v;
  return r4(clamped);
}

function nullableStr(v, maxLen) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  return v.slice(0, maxLen);
}

function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cached_input_tokens: null,
      cache_rate: null,
      tokens_per_second: null,
    };
  }
  return {
    input_tokens: nullableInt(raw.input_tokens),
    output_tokens: nullableInt(raw.output_tokens),
    total_tokens: nullableInt(raw.total_tokens),
    cached_input_tokens: nullableInt(raw.cached_input_tokens),
    cache_rate: nullableNum(raw.cache_rate, 100),
    tokens_per_second: nullableNum(raw.tokens_per_second),
  };
}

function normalizeUsage(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawWindows = src.windows && typeof src.windows === 'object' ? src.windows : {};
  const windows = {};
  for (const k of WINDOW_KEYS) {
    windows[k] = normalizeWindow(rawWindows[k]);
  }

  const by_day = Array.isArray(src.by_day)
    ? src.by_day
        .filter(d => d && typeof d === 'object' && typeof d.date === 'string' && d.date.length > 0)
        .map(d => ({
          date: d.date.slice(0, 32),
          input_tokens: nullableInt(d.input_tokens),
          output_tokens: nullableInt(d.output_tokens),
          total_tokens: nullableInt(d.total_tokens),
        }))
    : [];

  const rawModels = Array.isArray(src.by_model)
    ? src.by_model
        .filter(m => m && typeof m === 'object' && typeof m.model === 'string' && m.model.trim().length > 0)
        .map(m => ({
          model: m.model.trim().slice(0, 128),
          input_tokens: nullableInt(m.input_tokens),
          output_tokens: nullableInt(m.output_tokens),
          total_tokens: nullableInt(m.total_tokens),
        }))
    : [];

  let knownModelSum = 0;
  for (const m of rawModels) {
    if (m.total_tokens !== null) knownModelSum += m.total_tokens;
  }

  const by_model = rawModels
    .map(m => ({
      ...m,
      share_pct: m.total_tokens !== null && knownModelSum > 0 ? r2((m.total_tokens / knownModelSum) * 100) : null,
    }))
    .sort((a, b) => {
      if (a.total_tokens === null && b.total_tokens === null) return a.model.localeCompare(b.model);
      if (a.total_tokens === null) return 1;
      if (b.total_tokens === null) return -1;
      return b.total_tokens - a.total_tokens;
    });

  return {
    as_of: typeof src.as_of === 'string' && src.as_of ? src.as_of.slice(0, 64) : new Date().toISOString(),
    timezone: typeof src.timezone === 'string' && src.timezone ? src.timezone.slice(0, 64) : 'UTC',
    models_truncated: Boolean(src.models_truncated),
    windows,
    by_day,
    by_model,
  };
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id.slice(0, 128),
    title: nullableStr(raw.title, 200),
    status: nullableStr(raw.status, 64),
    created_at: nullableStr(raw.created_at, 64),
    is_archived: Boolean(raw.is_archived),
  };
}

function normalizeSessionsPage(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(src.items) ? src.items.map(normalizeSession).filter(Boolean) : [];
  return {
    items,
    next_offset: nullableInt(src.next_offset),
  };
}

function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id.slice(0, 128),
    name: nullableStr(raw.name, 200),
    status: nullableStr(raw.status, 64),
  };
}

function normalizeProjectsPage(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(src.items) ? src.items.map(normalizeProject).filter(Boolean) : [];
  return {
    items,
    next_offset: nullableInt(src.next_offset),
  };
}

function normalizeBudgetConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const monthly_tokens_m =
    typeof src.monthly_tokens_m === 'number' && Number.isFinite(src.monthly_tokens_m) && src.monthly_tokens_m >= 0.1
      ? r2(Math.min(10000, src.monthly_tokens_m))
      : DEFAULT_BUDGET.monthly_tokens_m;
  const warn_pct =
    Number.isInteger(src.warn_pct) && src.warn_pct >= 1 && src.warn_pct <= 99
      ? src.warn_pct
      : DEFAULT_BUDGET.warn_pct;
  const rawCritical =
    Number.isInteger(src.critical_pct) && src.critical_pct >= 2 && src.critical_pct <= 100
      ? src.critical_pct
      : DEFAULT_BUDGET.critical_pct;
  const critical_pct = rawCritical > warn_pct ? rawCritical : Math.min(100, warn_pct + 1);
  const alert_note = typeof src.alert_note === 'string' ? src.alert_note.trim().slice(0, 400) : '';
  return {
    schema_version: 1,
    monthly_tokens_m,
    warn_pct,
    critical_pct,
    alert_note,
  };
}

function computeBudgetStatus(config, usage30dWindow) {
  const used_tokens_30d = usage30dWindow ? usage30dWindow.total_tokens : null;
  if (used_tokens_30d === null) {
    return {
      monthly_tokens_m: config.monthly_tokens_m,
      warn_pct: config.warn_pct,
      critical_pct: config.critical_pct,
      used_tokens_30d: null,
      token_used_pct: null,
      alert_level: 'unknown',
      alert_note: config.alert_note,
    };
  }
  const quotaTokens = Math.max(1, config.monthly_tokens_m * 1_000_000);
  const token_used_pct = r2((used_tokens_30d / quotaTokens) * 100);
  const alert_level =
    token_used_pct >= config.critical_pct
      ? 'critical'
      : token_used_pct >= config.warn_pct
        ? 'warn'
        : 'ok';
  return {
    monthly_tokens_m: config.monthly_tokens_m,
    warn_pct: config.warn_pct,
    critical_pct: config.critical_pct,
    used_tokens_30d,
    token_used_pct,
    alert_level,
    alert_note: config.alert_note,
  };
}

async function readKey(collection, key, fallback) {
  const res = await globalThis.nmas.data.read({ collection, key });
  return { revision: res.revision, value: res.value === null ? fallback : res.value };
}

async function writeKey(collection, key, expectedRevision, value) {
  if (jsonBytes(value) > MAX_RECORD_BYTES) return { status: 'limit', revision: expectedRevision };
  try {
    const res = await globalThis.nmas.data.write({
      collection,
      key,
      expected_revision: expectedRevision,
      value,
    });
    return { status: 'saved', revision: res.revision };
  } catch (e) {
    if (e?.code === 'conflict' && e.outcome_unknown === false) {
      return { status: 'conflict', revision: expectedRevision };
    }
    throw e;
  }
}

async function listNotesPage({ prefix = NOTE_PREFIX, limit = 20, cursor } = {}) {
  const safePrefix = typeof prefix === 'string' && prefix.startsWith(NOTE_PREFIX)
    ? prefix.slice(0, 64)
    : `${NOTE_PREFIX}${typeof prefix === 'string' ? prefix.slice(0, 48) : ''}`;
  const req = { collection: NOTES_COLLECTION, prefix: safePrefix, limit };
  if (typeof cursor === 'string' && cursor.length > 0) req.cursor = cursor;
  const listed = await globalThis.nmas.data.list(req);
  let latestRevision = listed.revision;
  const items = [];
  for (const key of listed.keys || []) {
    const row = await globalThis.nmas.data.read({ collection: NOTES_COLLECTION, key });
    if (row.revision > latestRevision) latestRevision = row.revision;
    if (row.value && typeof row.value === 'object') {
      const v = row.value;
      items.push({
        key,
        id: typeof v.id === 'string' && v.id ? v.id.slice(0, 64) : key.slice(NOTE_PREFIX.length),
        title: typeof v.title === 'string' && v.title ? v.title.slice(0, 100) : '未命名复盘',
        range_days: v.range_days === 7 ? 7 : 30,
        tags: typeof v.tags === 'string' ? v.tags.slice(0, 120) : '',
        body: typeof v.body === 'string' ? v.body.slice(0, 4000) : '',
        updated_at: typeof v.updated_at === 'string' ? v.updated_at.slice(0, 64) : '',
      });
    }
  }
  items.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return {
    revision: latestRevision,
    items,
    next_cursor: typeof listed.next_cursor === 'string' ? listed.next_cursor : null,
  };
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};
  const args = input && typeof input === 'object' ? input : {};

  if (kind === 'action') {
    if (contribution === 'usage.dashboard') {
      const days = args.days === 7 ? 7 : 30;
      const rawUsage = await globalThis.nmas.host.usageSummary({ days });
      const usage = normalizeUsage(rawUsage);

      const sessReq = { offset: 0, limit: 20 };
      if (typeof args.include_archived === 'boolean') {
        sessReq.is_archived = args.include_archived;
      }
      const rawSessions = await globalThis.nmas.host.listSessions(sessReq);
      const sessions = normalizeSessionsPage(rawSessions);

      const rawProjects = await globalThis.nmas.host.listProjects({ offset: 0, limit: 20 });
      const projects = normalizeProjectsPage(rawProjects);

      const budgetRes = await readKey('goals', 'budget', DEFAULT_BUDGET);
      const budgetConfig = normalizeBudgetConfig(budgetRes.value);
      const budget = computeBudgetStatus(budgetConfig, usage.windows['30d']);

      const notesPage = await listNotesPage({ prefix: NOTE_PREFIX, limit: 20 });
      const revision = Math.max(budgetRes.revision, notesPage.revision);

      return {
        revision,
        days,
        as_of: usage.as_of,
        timezone: usage.timezone,
        models_truncated: usage.models_truncated,
        windows: usage.windows,
        by_day: usage.by_day,
        by_model: usage.by_model,
        budget,
        sessions,
        projects,
        notes: {
          items: notesPage.items,
          next_cursor: notesPage.next_cursor,
        },
      };
    }

    if (contribution === 'usage.host.sessions') {
      const req = {
        offset: Number.isInteger(args.offset) ? args.offset : 0,
        limit: Number.isInteger(args.limit) ? args.limit : 20,
      };
      if (typeof args.is_archived === 'boolean') req.is_archived = args.is_archived;
      const rawSessions = await globalThis.nmas.host.listSessions(req);
      return normalizeSessionsPage(rawSessions);
    }

    if (contribution === 'usage.host.session_detail') {
      try {
        // 严禁传 includeMessages: true，仅读取会话元数据
        const raw = await globalThis.nmas.host.getSession({ sessionId: args.session_id });
        const session = normalizeSession(raw);
        return { found: Boolean(session), session };
      } catch (e) {
        if (e?.code === 'not_found') return { found: false, session: null };
        throw e;
      }
    }

    if (contribution === 'usage.host.projects') {
      const req = {
        offset: Number.isInteger(args.offset) ? args.offset : 0,
        limit: Number.isInteger(args.limit) ? args.limit : 20,
      };
      const rawProjects = await globalThis.nmas.host.listProjects(req);
      return normalizeProjectsPage(rawProjects);
    }

    if (contribution === 'usage.budget.save') {
      const cur = await readKey('goals', 'budget', DEFAULT_BUDGET);
      if (cur.revision !== args.expected_revision) {
        return { status: 'conflict', revision: cur.revision };
      }
      if (args.warn_pct >= args.critical_pct) {
        return { status: 'invalid_input', revision: cur.revision };
      }
      const next = normalizeBudgetConfig({
        monthly_tokens_m: args.monthly_tokens_m,
        warn_pct: args.warn_pct,
        critical_pct: args.critical_pct,
        alert_note: args.alert_note !== undefined ? args.alert_note : cur.value?.alert_note,
      });
      return writeKey('goals', 'budget', args.expected_revision, next);
    }

    if (contribution === 'usage.note.save') {
      const title = typeof args.title === 'string' ? args.title.trim().slice(0, 100) : '';
      const body = typeof args.body === 'string' ? args.body.trim().slice(0, 4000) : '';
      const rawId = typeof args.id === 'string' && /^[a-zA-Z0-9._-]+$/.test(args.id)
        ? args.id.slice(0, 64)
        : `rev-${Date.now().toString(36)}`;
      const key = `${NOTE_PREFIX}${rawId}`;
      const existing = await readKey(NOTES_COLLECTION, key, null);
      if (!title || !body) {
        return { status: 'invalid_input', revision: existing.revision, key, id: rawId };
      }
      if (existing.revision !== args.expected_revision) {
        return { status: 'conflict', revision: existing.revision, key, id: rawId };
      }
      const record = {
        schema_version: 1,
        id: rawId,
        title,
        range_days: args.range_days === 7 ? 7 : 30,
        tags: typeof args.tags === 'string' ? args.tags.trim().slice(0, 120) : '',
        body,
        updated_at: new Date().toISOString(),
      };
      const w = await writeKey(NOTES_COLLECTION, key, args.expected_revision, record);
      return { status: w.status, revision: w.revision, key, id: rawId };
    }

    if (contribution === 'usage.note.list') {
      const limit = Number.isInteger(args.limit) ? args.limit : 20;
      const prefix = typeof args.prefix === 'string' ? args.prefix : NOTE_PREFIX;
      return listNotesPage({ prefix, limit, cursor: args.cursor });
    }

    if (contribution === 'usage.note.delete') {
      const key = typeof args.key === 'string' ? args.key : '';
      if (!key.startsWith(NOTE_PREFIX) || key.length <= NOTE_PREFIX.length) {
        const cur = await readKey('goals', 'budget', DEFAULT_BUDGET);
        return { status: 'invalid_input', revision: cur.revision };
      }
      const existing = await readKey(NOTES_COLLECTION, key, null);
      if (existing.revision !== args.expected_revision) {
        return { status: 'conflict', revision: existing.revision };
      }
      if (existing.value === null) {
        return { status: 'not_found', revision: existing.revision };
      }
      try {
        const del = await globalThis.nmas.data.delete({
          collection: NOTES_COLLECTION,
          key,
          expected_revision: args.expected_revision,
        });
        return { status: 'deleted', revision: del.revision };
      } catch (e) {
        if (e?.code === 'conflict' && e.outcome_unknown === false) {
          return { status: 'conflict', revision: existing.revision };
        }
        throw e;
      }
    }
  }

  if (kind === 'tool') {
    if (contribution === 'usage.get_host_summary') {
      const days = args.days === 7 ? 7 : 30;
      const rawUsage = await globalThis.nmas.host.usageSummary({ days });
      const usage = normalizeUsage(rawUsage);
      const budgetRes = await readKey('goals', 'budget', DEFAULT_BUDGET);
      const budgetConfig = normalizeBudgetConfig(budgetRes.value);
      const budget = computeBudgetStatus(budgetConfig, usage.windows['30d']);
      const targetWin = days === 7 ? usage.windows['7d'] : usage.windows['30d'];
      const hasTokens = targetWin.total_tokens !== null;

      return {
        success: true,
        status: hasTokens ? 'ready' : 'missing_metrics',
        days,
        as_of: usage.as_of,
        timezone: usage.timezone,
        window_total_tokens: targetWin.total_tokens,
        window_input_tokens: targetWin.input_tokens,
        window_output_tokens: targetWin.output_tokens,
        window_cached_tokens: targetWin.cached_input_tokens,
        cache_rate: targetWin.cache_rate,
        tokens_per_second: targetWin.tokens_per_second,
        budget_monthly_tokens_m: budget.monthly_tokens_m,
        token_used_pct: budget.token_used_pct,
        budget_alert_level: budget.alert_level,
        top_model: usage.by_model.length ? usage.by_model[0].model : null,
        models_truncated: usage.models_truncated,
        by_model_count: usage.by_model.length,
      };
    }

    if (contribution === 'usage.list_host_sessions') {
      const sessReq = {
        offset: Number.isInteger(args.offset) ? args.offset : 0,
        limit: Number.isInteger(args.limit) ? args.limit : 20,
      };
      if (typeof args.is_archived === 'boolean') sessReq.is_archived = args.is_archived;
      const sessions = normalizeSessionsPage(await globalThis.nmas.host.listSessions(sessReq));

      let projects = { items: [], next_offset: null };
      if (args.include_projects !== false) {
        projects = normalizeProjectsPage(await globalThis.nmas.host.listProjects({ offset: 0, limit: 20 }));
      }
      return {
        success: true,
        status: sessions.items.length || projects.items.length ? 'ready' : 'empty',
        sessions: sessions.items,
        next_offset: sessions.next_offset,
        projects: projects.items,
        projects_next_offset: projects.next_offset,
      };
    }

    if (contribution === 'usage.update_budget_alert') {
      const cur = await readKey('goals', 'budget', DEFAULT_BUDGET);
      const prev = normalizeBudgetConfig(cur.value);
      const warn_pct = Number.isInteger(args.warn_pct) ? args.warn_pct : prev.warn_pct;
      const critical_pct = Number.isInteger(args.critical_pct) ? args.critical_pct : prev.critical_pct;
      if (warn_pct >= critical_pct) {
        return {
          success: false,
          status: 'invalid_input',
          revision: cur.revision,
          monthly_tokens_m: prev.monthly_tokens_m,
          warn_pct: prev.warn_pct,
          critical_pct: prev.critical_pct,
          alert_note: prev.alert_note,
        };
      }
      const next = normalizeBudgetConfig({
        monthly_tokens_m: args.monthly_tokens_m,
        warn_pct,
        critical_pct,
        alert_note: args.alert_note !== undefined ? args.alert_note : prev.alert_note,
      });
      const w = await writeKey('goals', 'budget', cur.revision, next);
      return {
        success: w.status === 'saved',
        status: w.status,
        revision: w.revision,
        monthly_tokens_m: next.monthly_tokens_m,
        warn_pct: next.warn_pct,
        critical_pct: next.critical_pct,
        alert_note: next.alert_note,
      };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
