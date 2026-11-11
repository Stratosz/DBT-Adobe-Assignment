import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ApiError,
  IN_FLIGHT,
  api,
  can,
  session,
  setUnauthorizedHandler,
  type AuditEvent,
  type FieldMatch,
  type IssueGroup,
  type Me,
  type Meta,
  type Partner,
  type RunDetail,
  type RunStatus,
  type RunSummary,
  type SavedMappingRow,
} from './api.ts';

const STATUS_TEXT: Record<RunStatus, string> = {
  RECEIVED: 'Queued',
  QUEUED: 'Queued',
  AWAITING_MAPPING: 'Needs mapping',
  PROCESSING: 'Processing',
  COMMITTED: 'Imported',
  HELD_FOR_REVIEW: 'Held for review',
  REJECTED: 'Rejected',
  FAILED: 'Failed',
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'files' | 'suppliers'>('files');
  const [loadError, setLoadError] = useState<string | null>(null);

  const signOut = useCallback(() => {
    session.set(null);
    setMe(null);
    setMeta(null);
  }, []);
  useEffect(() => setUnauthorizedHandler(signOut), [signOut]);

  const refresh = useCallback(async () => {
    const [p, r] = await Promise.all([api.partners(), api.runs()]);
    setPartners(p);
    setRuns(r);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    if (!session.get()) return setChecked(true);
    try {
      const user = await api.me();
      const [m] = await Promise.all([api.meta(), refresh()]);
      setMe(user);
      setMeta(m);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setLoadError('The ingestion API is not reachable. Start it with "npm run dev" and reload.');
    } finally {
      setChecked(true);
    }
  }, [refresh]);
  useEffect(() => void load(), [load]);

  // Keep the history fresh while anything is still being processed.
  useEffect(() => {
    if (!me || !runs.some((r) => IN_FLIGHT.includes(r.status))) return;
    const t = setInterval(() => void refresh().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [me, runs, refresh]);

  const onRunChanged = useCallback(
    (run: RunDetail) => {
      setSelected(run.id);
      setView('files');
      void refresh();
    },
    [refresh],
  );

  if (loadError)
    return (
      <main className="boot-error" role="alert">
        {loadError}
      </main>
    );
  if (!checked) return <main className="boot">Loading…</main>;
  if (!me || !meta) return <SignIn onSignedIn={() => void load()} />;

  return (
    <div className="shell">
      <header className="masthead">
        <h1>Supplier feed intake</h1>
        <nav className="tabs" aria-label="Sections">
          <button className={view === 'files' ? 'is-active' : ''} aria-current={view === 'files'} onClick={() => setView('files')}>
            Files
          </button>
          <button className={view === 'suppliers' ? 'is-active' : ''} aria-current={view === 'suppliers'} onClick={() => setView('suppliers')}>
            Suppliers
          </button>
        </nav>
        <div className="whoami">
          <span>
            {me.name}, {me.role}
          </span>
          <button className="link-button on-dark" onClick={signOut}>
            Switch user
          </button>
        </div>
      </header>
      {view === 'files' ? (
        <>
          <aside className="sidebar">
            <UploadForm meta={meta} partners={partners} me={me} onDone={onRunChanged} />
            <RunList runs={runs} partners={partners} selected={selected} onSelect={setSelected} />
          </aside>
          <main className="detail">
            {selected ? <RunView key={selected} id={selected} meta={meta} partners={partners} me={me} onChanged={onRunChanged} /> : <EmptyDetail />}
          </main>
        </>
      ) : (
        <main className="detail wide">
          <SuppliersView partners={partners} meta={meta} me={me} />
        </main>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------- sign in

const DEMO_KEYS = [
  { key: 'demo-uploader-key', who: 'Andrei', role: 'uploader', does: 'uploads files' },
  { key: 'demo-reviewer-key', who: 'Bogdan', role: 'reviewer', does: 'confirms mappings, approves held files' },
  { key: 'demo-admin-key', who: 'Marius', role: 'admin', does: 'manages supplier mappings, sees metrics' },
];
const SHOW_DEMO_KEYS = import.meta.env.DEV || import.meta.env.VITE_DEMO_KEYS === 'true';

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function signIn(value: string) {
    setError(null);
    session.set(value.trim());
    try {
      await api.me();
      onSignedIn();
    } catch (e) {
      session.set(null);
      setError(e instanceof ApiError && e.status === 401 ? 'That key was not accepted.' : 'The ingestion API is not reachable.');
    }
  }
  return (
    <main className="signin">
      <h1>Supplier feed intake</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void signIn(key);
        }}
      >
        <label>
          API key
          <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <button type="submit" disabled={!key.trim()}>
          Sign in
        </button>
        {error && (
          <p className="bad-text" role="alert">
            {error}
          </p>
        )}
      </form>
      {SHOW_DEMO_KEYS && (
        <section className="demo-keys">
          <h2>Demo users</h2>
          <p className="muted">Public keys from the README. They only work while the server uses the demo key file.</p>
          <ul>
            {DEMO_KEYS.map((d) => (
              <li key={d.key}>
                <button className="secondary" onClick={() => void signIn(d.key)}>
                  Sign in as {d.who}
                </button>
                <span>
                  {d.role}: {d.does}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function EmptyDetail() {
  return (
    <section className="empty">
      <h2>Upload a supplier file to inspect it</h2>
      <p>
        Files are checked against the product model first. Columns we cannot place with confidence wait for you, rows with bad data are set aside with the
        reason, and a file with too many bad rows is held instead of imported.
      </p>
      <p className="muted">
        Try the demo files in <code>fixtures/</code>: Nordwind weeks 1 to 3, then Peak's JSON catalog.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------- upload

function UploadForm({ meta, partners, me, onDone }: { meta: Meta; partners: Partner[]; me: Me; onDone: (r: RunDetail) => void }) {
  const [partnerId, setPartnerId] = useState('');
  const [importType, setImportType] = useState(meta.importTypes[0]!.id);
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState('');
  const [override, setOverride] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const type = meta.importTypes.find((t) => t.id === importType)!;
  const partner = partnerId || partners[0]?.id || '';

  async function submit(force = false) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('partnerId', partner);
    form.set('importType', importType);
    if (format) form.set('format', format);
    if (override) {
      form.set('maxErrorRate', String(Number(override) / 100));
      form.set('overrideReason', reason);
    }
    if (force) form.set('force', 'true');
    form.set('file', file);
    try {
      onDone(await api.upload(form));
      setFile(null);
      (document.getElementById('file') as HTMLInputElement).value = '';
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Upload failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="upload"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>New file</h2>
      <label>
        Supplier
        <select value={partner} onChange={(e) => setPartnerId(e.target.value)}>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        What the file contains
        <select value={importType} onChange={(e) => setImportType(e.target.value)}>
          {meta.importTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="help">
          {type.description} Held if more than {pct(type.maxErrorRate)} of rows are bad.
        </span>
      </label>
      <label>
        File
        <input id="file" type="file" accept=".csv,.tsv,.txt,.json,.ndjson,.jsonl" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <details>
        <summary>Format and limits</summary>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="">Detect from the file</option>
            {meta.formats.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {can(me, 'reviewer') && (
          <>
            <label>
              Bad-row limit for this file (%)
              <input
                type="number"
                min={meta.overrideBounds.min * 100}
                max={meta.overrideBounds.max * 100}
                step="1"
                placeholder={String(type.maxErrorRate * 100)}
                value={override}
                onChange={(e) => setOverride(e.target.value)}
              />
            </label>
            {override && (
              <label>
                Why this file needs a different limit
                <input type="text" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Stored with the run" />
              </label>
            )}
          </>
        )}
      </details>
      <button type="submit" disabled={!file || busy}>
        {busy ? 'Uploading…' : 'Check and import'}
      </button>
      {error && (
        <div className="form-error" role="alert">
          <strong>{error.message}</strong>
          {error.hint && <p>{error.hint}</p>}
          {error.code === 'DUPLICATE_FILE' && (
            <button type="button" className="secondary" onClick={() => void submit(true)}>
              Import it again anyway
            </button>
          )}
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------------------- history

function RunList({ runs, partners, selected, onSelect }: { runs: RunSummary[]; partners: Partner[]; selected: string | null; onSelect: (id: string) => void }) {
  const name = (id: string) => partners.find((p) => p.id === id)?.name ?? id;
  return (
    <nav className="history" aria-label="Recent files">
      <h2>Recent files</h2>
      {runs.length === 0 && <p className="muted">Nothing uploaded yet.</p>}
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <button className={`run-link ${r.id === selected ? 'is-selected' : ''}`} onClick={() => onSelect(r.id)} aria-current={r.id === selected}>
              <span className={`status-pill s-${r.status}`}>{STATUS_TEXT[r.status]}</span>
              <span className="run-file">{r.filename ?? r.id}</span>
              <span className="run-meta">
                {name(r.partnerId)}, {time(r.createdAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------- run detail

function RunView({ id, meta, partners, me, onChanged }: { id: string; meta: Meta; partners: Partner[]; me: Me; onChanged: (r: RunDetail) => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .run(id)
      .then(setRun)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  // Processing happens in the background: poll until the run settles.
  const inFlight = !!run && IN_FLIGHT.includes(run.status);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      api
        .run(id)
        .then((r) => {
          setRun(r);
          if (!IN_FLIGHT.includes(r.status)) onChanged(r);
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(t);
  }, [id, inFlight, onChanged]);

  const update = (r: RunDetail) => {
    setRun(r);
    onChanged(r);
  };

  if (error) return <p role="alert">{error}</p>;
  if (!run) return <p className="muted">Loading run…</p>;
  const partner = partners.find((p) => p.id === run.partnerId);
  const importType = meta.importTypes.find((t) => t.id === run.importType);

  return (
    <article className="run" aria-busy={inFlight}>
      <header className="run-head">
        <div>
          <h2>{run.filename ?? run.id}</h2>
          <p className="run-sub">
            {partner?.name ?? run.partnerId}, {importType?.label.toLowerCase()}
            {run.analysis?.format && (
              <>
                , read as {run.analysis.format.toUpperCase()}
                {run.analysis.encoding !== 'utf-8' && ` (${run.analysis.encoding})`}
              </>
            )}
          </p>
        </div>
        <span className={`status-pill large s-${run.status}`}>{STATUS_TEXT[run.status]}</span>
      </header>

      <p className={`verdict v-${run.status}`} aria-live="polite">
        {verdict(run)}
      </p>

      {run.fatal && (
        <section className="callout bad">
          <h3>{run.fatal.message}</h3>
          <p>{run.fatal.hint}</p>
        </section>
      )}

      {run.result && <Figures run={run} />}
      {run.status === 'HELD_FOR_REVIEW' && <ReviewActions run={run} me={me} onDone={update} />}
      {run.drift?.changed && <Drift drift={run.drift} />}
      {run.analysis?.proposal && <MappingTable run={run} meta={meta} me={me} onDone={update} />}
      {run.result && run.result.issueGroups.length > 0 && <Issues groups={run.result.issueGroups} runId={run.id} quarantined={run.result.counts.quarantined} />}
      {run.audit.length > 0 && <History events={run.audit} />}
      <p className="run-id muted">Run {run.id}. Search the API logs for this id to trace it.</p>
    </article>
  );
}

function verdict(run: RunDetail): string {
  switch (run.status) {
    case 'RECEIVED':
      return 'Uploaded. Waiting for the file to be read; this page updates by itself.';
    case 'QUEUED':
      return 'Mapping confirmed. Waiting to import; this page updates by itself.';
    case 'PROCESSING':
      return 'Reading and checking every row…';
    case 'AWAITING_MAPPING':
      return 'Some columns could not be matched with confidence. Confirm them below and the file will be imported. Your choices are remembered for this supplier.';
    case 'COMMITTED':
      if (run.commit) {
        const parts = [`${run.commit.inserted} new and ${run.commit.updated} updated products`];
        if (run.commit.unknownSkus) parts.push(`${run.commit.unknownSkus} rows skipped because the SKU is not in the catalog yet`);
        const stale = (run.result?.counts.skippedStale ?? 0) + (run.commit.skippedStale ?? 0);
        if (stale) parts.push(`${plural(stale, 'row')} skipped because the catalog already has newer data`);
        return `Imported: ${parts.join('; ')}. ${run.statusReason ?? ''}`;
      }
      return run.statusReason ?? 'Imported.';
    default:
      return run.statusReason ?? '';
  }
}

function Figures({ run }: { run: RunDetail }) {
  const r = run.result!;
  const over = r.errorRate > r.maxErrorRate;
  return (
    <section className="figures" aria-label="Row counts">
      <dl>
        <div>
          <dt>Rows read</dt>
          <dd>{r.counts.total}</dd>
        </div>
        <div>
          <dt>Accepted</dt>
          <dd>{r.counts.accepted}</dd>
        </div>
        <div>
          <dt>With warnings</dt>
          <dd>{r.counts.acceptedWithWarnings}</dd>
        </div>
        <div>
          <dt>Set aside</dt>
          <dd className={r.counts.quarantined ? 'bad-text' : ''}>{r.counts.quarantined}</dd>
        </div>
      </dl>
      {(!!r.counts.skippedStale || !!r.counts.flaggedForReview) && (
        <p className="figures-note">
          {!!r.counts.flaggedForReview && <span className="warn-text">{plural(r.counts.flaggedForReview, 'price')} to review against the catalog. </span>}
          {!!r.counts.skippedStale && <span>{plural(r.counts.skippedStale, 'row')} older than the catalog, not applied.</span>}
        </p>
      )}
      <div className="limit">
        <div className="limit-label">
          <span>Bad rows {pct(r.errorRate)}</span>
          <span>
            Limit {pct(r.maxErrorRate)}
            {run.policy.overridden && ` (changed for this file: ${run.policy.overrideReason})`}
          </span>
        </div>
        <div className="limit-track" role="img" aria-label={`${pct(r.errorRate)} bad rows against a ${pct(r.maxErrorRate)} limit`}>
          <div className={`limit-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, r.errorRate * 100)}%` }} />
          <div className="limit-mark" style={{ left: `${r.maxErrorRate * 100}%` }} />
        </div>
      </div>
    </section>
  );
}

function ReviewActions({ run, me, onDone }: { run: RunDetail; me: Me; onDone: (r: RunDetail) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: typeof api.approve) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn(run.id, reason));
    } catch (e) {
      setError(e instanceof ApiError && e.hint ? `${e.message}. ${e.hint}` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reasons = run.result?.holdReasons ?? [];
  const ownUpload = run.createdBy === me.id && me.role !== 'admin';
  return (
    <section className="callout warn">
      <h3>Nothing from this file is in the catalog yet</h3>
      {reasons.length > 0 && (
        <ul className="hold-reasons">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <p>Check the list below and the set-aside rows. Import only if you know why; otherwise reject the file and ask the supplier for a corrected one.</p>
      {!can(me, 'reviewer') ? (
        <p className="muted">A reviewer decides what happens to held files.</p>
      ) : ownUpload ? (
        <p className="muted">You uploaded this file, so another reviewer has to decide.</p>
      ) : (
        <>
          <label>
            Reason (kept in the history)
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Clearance sale confirmed by the supplier" />
          </label>
          <div className="actions">
            <button disabled={busy || !reason.trim()} onClick={() => void act(api.approve)}>
              Import the {plural(run.result?.counts.accepted ?? 0, 'good row')}
            </button>
            <button className="secondary" disabled={busy} onClick={() => void act(api.reject)}>
              Reject the file
            </button>
          </div>
        </>
      )}
      {!!run.result?.counts.quarantined && <DownloadButton runId={run.id} label="Download set-aside rows" />}
      {error && (
        <p className="bad-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function DownloadButton({ runId, label }: { runId: string; label: string }) {
  const [error, setError] = useState(false);
  return (
    <span>
      <button className="link-button" onClick={() => api.downloadQuarantine(runId).catch(() => setError(true))}>
        {label}
      </button>
      {error && <span className="bad-text"> Download failed.</span>}
    </span>
  );
}

function Drift({ drift }: { drift: NonNullable<RunDetail['drift']> }) {
  return (
    <section className="drift">
      <h3>The columns changed since this supplier's last file</h3>
      <div className="drift-cols">
        {!!drift.added?.length && (
          <div>
            <h4>New</h4>
            <ul>
              {drift.added.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}
        {!!drift.removed?.length && (
          <div>
            <h4>Gone</h4>
            <ul>
              {drift.removed.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------- mapping

function Confidence({ value }: { value: number }) {
  // Band marks at the thresholds the mapper uses: below 0.65 unmapped, 0.65-0.90 ask, above auto.
  return (
    <div className="conf" role="img" aria-label={`Confidence ${Math.round(value * 100)}%`}>
      <div className="conf-track">
        <span className="conf-band ask" />
        <div className="conf-fill" style={{ width: `${value * 100}%` }} />
      </div>
      <span className="conf-num">{Math.round(value * 100)}</span>
    </div>
  );
}

const STATUS_WORD: Record<FieldMatch['status'] | 'confirmed', string> = {
  auto: 'Matched',
  needs_confirmation: 'Check',
  confirmed: 'Confirmed by you',
  unmapped: 'Not imported',
  ignored: 'Not imported',
};

function MappingTable({ run, meta, me, onDone }: { run: RunDetail; meta: Meta; me: Me; onDone: (r: RunDetail) => void }) {
  const proposal = run.analysis!.proposal!;
  const waiting = run.status === 'AWAITING_MAPPING';
  const editable = waiting && can(me, 'reviewer');
  const initial = useMemo(() => {
    const d: Record<string, string> = {};
    for (const m of proposal.matches) d[m.sourceField] = m.target ?? '';
    return d;
  }, [proposal]);
  const [choice, setChoice] = useState(initial);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const required = new Set(meta.importTypes.find((t) => t.id === run.importType)?.requiredFields ?? []);
  const final = run.mapping ?? {};
  // After a human confirmed the mapping, show what they decided rather than the original question.
  const shownStatus = (m: FieldMatch): keyof typeof STATUS_WORD => {
    if (editable || m.status !== 'needs_confirmation') return m.status;
    return final[m.sourceField] ? 'confirmed' : 'unmapped';
  };

  async function confirm() {
    setBusy(true);
    setProblems([]);
    const decisions: Record<string, string | null> = {};
    for (const m of proposal.matches) {
      const c = choice[m.sourceField] ?? '';
      const changed = c !== initial[m.sourceField];
      if (m.status === 'needs_confirmation' || changed || (m.status === 'unmapped' && c)) {
        decisions[m.sourceField] = c === '' ? null : c;
      }
    }
    try {
      onDone(await api.confirmMapping(run.id, decisions));
    } catch (e) {
      setProblems(e instanceof ApiError ? (e.details?.problems ?? [e.message]) : [(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mapping">
      <h3>{editable ? 'Confirm how the columns map to product fields' : 'How the columns were read'}</h3>
      {waiting && !editable && <p className="muted">A reviewer needs to confirm the highlighted columns before this file is imported.</p>}
      {proposal.missingRequired.length > 0 && editable && (
        <p className="bad-text">No column was found for {proposal.missingRequired.join(', ')}. Pick one below.</p>
      )}
      <table>
        <thead>
          <tr>
            <th scope="col">Supplier column</th>
            <th scope="col">Example values</th>
            <th scope="col">Product field</th>
            <th scope="col">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {proposal.matches.map((m) => {
            const ask = editable && m.status === 'needs_confirmation';
            const target = editable ? choice[m.sourceField] : (final[m.sourceField] ?? '');
            return (
              <tr key={m.sourceField} className={ask ? 'ask' : ''}>
                <th scope="row">
                  {m.sourceField}
                  <span className={`match-word mw-${shownStatus(m)}`}>{STATUS_WORD[shownStatus(m)]}</span>
                </th>
                <td className="samples">{m.samples.slice(0, 3).join(', ') || <span className="muted">empty</span>}</td>
                <td>
                  {editable ? (
                    <select
                      aria-label={`Product field for ${m.sourceField}`}
                      value={target}
                      onChange={(e) => setChoice({ ...choice, [m.sourceField]: e.target.value })}
                    >
                      <option value="">Don't import</option>
                      {meta.fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.name}
                          {required.has(f.name) ? ' (required)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>{target || <span className="muted">not imported</span>}</span>
                  )}
                  <span className="reason">{m.reason}</span>
                </td>
                <td>
                  <Confidence value={m.confidence} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable && (
        <div className="actions">
          <button onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Importing…' : 'Confirm mapping and import'}
          </button>
          <span className="muted">Saved for this supplier; the next file with these columns won't ask again.</span>
        </div>
      )}
      {problems.length > 0 && (
        <ul className="problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------- issues

/** What the issue did to the rows, in plain words. */
function issueEffect(g: IssueGroup): string {
  if (g.code === 'PRICE_SWING') return 'imported only if a reviewer approves';
  if (g.code === 'STALE_RECORD') return 'not applied, catalog is newer';
  if (g.code === 'DUPLICATE_SKU') return 'last row kept';
  if (g.severity === 'error') return 'rows set aside';
  if (g.severity === 'warning') return 'imported, value adjusted or dropped';
  return 'for information';
}

function where(loc: IssueGroup['locations'][number]) {
  return loc.line !== undefined ? `line ${loc.line}` : (loc.pointer ?? `row ${loc.index + 1}`);
}

function Issues({ groups, runId, quarantined }: { groups: IssueGroup[]; runId: string; quarantined: number }) {
  const [showInfo, setShowInfo] = useState(false);
  const visible = groups.filter((g) => showInfo || g.severity !== 'info');
  const infoCount = groups.filter((g) => g.severity === 'info').length;
  return (
    <section className="issues">
      <div className="issues-head">
        <h3>What to fix</h3>
        {quarantined > 0 && (
          <DownloadButton runId={runId} label={`Download ${quarantined === 1 ? 'the set-aside row' : `the ${quarantined} set-aside rows`} with reasons`} />
        )}
      </div>
      <ol>
        {visible.map((g) => (
          <li key={`${g.code}${g.sourceField}${g.severity}`} className={`issue sev-${g.severity}`}>
            <div className="issue-count">{g.count}</div>
            <div>
              <p className="issue-title">
                {g.title}
                {g.sourceField && (
                  <>
                    {' '}
                    in <q>{g.sourceField}</q>
                  </>
                )}
                <span className="issue-effect">{issueEffect(g)}</span>
              </p>
              <p className="issue-hint">{g.hint}</p>
              {g.locations.length > 0 && (
                <p className="issue-where">
                  At {g.locations.map(where).join(', ')}
                  {g.count > g.locations.length ? ' and more' : ''}. Code {g.code}.
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {infoCount > 0 && (
        <button className="link-button" onClick={() => setShowInfo(!showInfo)}>
          {showInfo ? 'Hide' : 'Show'} {plural(infoCount, 'informational note')}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------- history

const ACTION_TEXT: Record<string, string> = {
  'run.uploaded': 'uploaded the file',
  'run.limit_overridden': 'changed the bad-row limit',
  'run.mapping_confirmed': 'confirmed the column mapping',
  'run.approved': 'approved the import',
  'run.rejected': 'rejected the file',
  'mapping.updated': 'changed a saved mapping',
  'mapping.deleted': 'removed a saved mapping',
};

function describeEvent(e: AuditEvent): string {
  const d = e.details ?? {};
  const base = ACTION_TEXT[e.action] ?? e.action;
  if (e.action === 'run.limit_overridden') return `${base} to ${pct(Number(d.maxErrorRate))}: ${String(d.reason)}`;
  if ((e.action === 'run.approved' || e.action === 'run.rejected') && d.reason) return `${base}: ${String(d.reason)}`;
  if (e.action === 'mapping.updated') return `${base}: "${String(d.sourceField)}" from ${String(d.from ?? 'none')} to ${String(d.to ?? "don't import")}`;
  if (e.action === 'mapping.deleted') return `${base}: "${String(d.sourceField)}" (was ${String(d.was ?? "don't import")})`;
  return base;
}

function History({ events }: { events: AuditEvent[] }) {
  return (
    <section className="history-log">
      <h3>History</h3>
      <ol>
        {events.map((e) => (
          <li key={e.id}>
            <time dateTime={e.at}>{time(e.at)}</time> <strong>{e.actorId}</strong> ({e.actorRole}) {describeEvent(e)}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------------------- suppliers

function SuppliersView({ partners, meta, me }: { partners: Partner[]; meta: Meta; me: Me }) {
  const [partnerId, setPartnerId] = useState(partners[0]?.id ?? '');
  const [rows, setRows] = useState<SavedMappingRow[] | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const partner = partners.find((p) => p.id === partnerId);
  const isAdmin = can(me, 'admin');

  useEffect(() => {
    if (!partnerId) return;
    setRows(null);
    api
      .mappings(partnerId)
      .then(setRows)
      .catch((e: Error) => setError(e.message));
    if (can(me, 'reviewer'))
      api
        .audit(partnerId)
        .then((a) => setEvents(a.filter((e) => e.action.startsWith('mapping.'))))
        .catch(() => {});
  }, [partnerId, me]);

  async function change(fn: () => Promise<SavedMappingRow[]>) {
    setError(null);
    try {
      setRows(await fn());
      if (can(me, 'reviewer')) setEvents((await api.audit(partnerId)).filter((e) => e.action.startsWith('mapping.')));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="suppliers">
      <div className="suppliers-head">
        <h2>Saved column mappings</h2>
        <label className="inline">
          Supplier
          <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {partner && (
        <p className="muted">
          {partner.description} Numbers use &ldquo;{partner.locale.decimalSeparator}&rdquo; as the decimal separator, dates are read{' '}
          {partner.locale.dateOrder === 'DMY' ? 'day first' : 'month first'}, default currency {partner.locale.defaultCurrency}. {partner.productCount} products
          in the catalog.
        </p>
      )}
      <p>
        These are decisions people made when confirming a file. They apply to every future file from this supplier.
        {isAdmin ? ' Change a field, or remove the decision so the column is suggested again next time.' : ' Only admins can change them.'}
      </p>
      {error && (
        <p className="bad-text" role="alert">
          {error}
        </p>
      )}
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No saved decisions yet. They appear after someone confirms a mapping for this supplier.</p>
      ) : (
        <table className="plain">
          <thead>
            <tr>
              <th scope="col">Supplier column</th>
              <th scope="col">Product field</th>
              <th scope="col">Decided by</th>
              {isAdmin && (
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sourceField}>
                <th scope="row">{r.sourceField}</th>
                <td>
                  {isAdmin ? (
                    <select
                      aria-label={`Product field for ${r.sourceField}`}
                      value={r.target ?? ''}
                      onChange={(e) => void change(() => api.setMapping(partnerId, r.sourceField, e.target.value || null))}
                    >
                      <option value="">Don't import</option>
                      {meta.fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    (r.target ?? <span className="muted">not imported</span>)
                  )}
                </td>
                <td>
                  {r.decidedBy ?? 'unknown'}, {time(r.decidedAt)}
                </td>
                {isAdmin && (
                  <td>
                    <button className="link-button" onClick={() => void change(() => api.deleteMapping(partnerId, r.sourceField))}>
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {events.length > 0 && <History events={[...events].reverse()} />}
    </section>
  );
}
