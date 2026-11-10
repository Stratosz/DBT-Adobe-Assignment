import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, api, type FieldMatch, type IssueGroup, type Meta, type Partner, type RunDetail, type RunStatus, type RunSummary } from './api.ts';

const STATUS_TEXT: Record<RunStatus, string> = {
  RECEIVED: 'Received',
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
  const [meta, setMeta] = useState<Meta | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [p, r] = await Promise.all([api.partners(), api.runs()]);
    setPartners(p);
    setRuns(r);
  }, []);

  useEffect(() => {
    Promise.all([api.meta(), refresh()])
      .then(([m]) => setMeta(m))
      .catch(() => setLoadError('The ingestion API is not reachable. Start it with "npm run dev" and reload.'));
  }, [refresh]);

  const onRunChanged = useCallback(
    (run: RunDetail) => {
      setSelected(run.id);
      void refresh();
    },
    [refresh],
  );

  if (loadError) return <main className="boot-error" role="alert">{loadError}</main>;
  if (!meta) return <main className="boot">Loading…</main>;

  return (
    <div className="shell">
      <header className="masthead">
        <h1>Supplier feed intake</h1>
        <p>Check partner files before they reach the catalog.</p>
      </header>
      <aside className="sidebar">
        <UploadForm meta={meta} partners={partners} onDone={onRunChanged} />
        <RunList runs={runs} partners={partners} selected={selected} onSelect={setSelected} />
      </aside>
      <main className="detail">
        {selected ? (
          <RunView key={selected} id={selected} meta={meta} partners={partners} onChanged={onRunChanged} />
        ) : (
          <EmptyDetail />
        )}
      </main>
    </div>
  );
}

function EmptyDetail() {
  return (
    <section className="empty">
      <h2>Upload a supplier file to inspect it</h2>
      <p>
        Files are checked against the product model first. Columns we cannot place with confidence wait for you, rows with bad data are set
        aside with the reason, and a file with too many bad rows is held instead of imported.
      </p>
      <p className="muted">Try the demo files in <code>fixtures/</code>: Nordwind weeks 1 to 3, then Peak's JSON catalog.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------- upload

function UploadForm({ meta, partners, onDone }: { meta: Meta; partners: Partner[]; onDone: (r: RunDetail) => void }) {
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
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label>
        What the file contains
        <select value={importType} onChange={(e) => setImportType(e.target.value)}>
          {meta.importTypes.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <span className="help">{type.description} Held if more than {pct(type.maxErrorRate)} of rows are bad.</span>
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
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </label>
        <label>
          Bad-row limit for this file (%)
          <input type="number" min={meta.overrideBounds.min * 100} max={meta.overrideBounds.max * 100} step="1" placeholder={String(type.maxErrorRate * 100)} value={override} onChange={(e) => setOverride(e.target.value)} />
        </label>
        {override && (
          <label>
            Why this file needs a different limit
            <input type="text" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Stored with the run" />
          </label>
        )}
      </details>
      <button type="submit" disabled={!file || busy}>{busy ? 'Checking…' : 'Check and import'}</button>
      {error && (
        <div className="form-error" role="alert">
          <strong>{error.message}</strong>
          {error.hint && <p>{error.hint}</p>}
          {error.code === 'DUPLICATE_FILE' && (
            <button type="button" className="secondary" onClick={() => void submit(true)}>Import it again anyway</button>
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
              <span className="run-meta">{name(r.partnerId)}, {time(r.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------- run detail

function RunView({ id, meta, partners, onChanged }: { id: string; meta: Meta; partners: Partner[]; onChanged: (r: RunDetail) => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.run(id).then(setRun).catch((e: Error) => setError(e.message));
  }, [id]);

  const update = (r: RunDetail) => {
    setRun(r);
    onChanged(r);
  };

  if (error) return <p role="alert">{error}</p>;
  if (!run) return <p className="muted">Loading run…</p>;
  const partner = partners.find((p) => p.id === run.partnerId);
  const importType = meta.importTypes.find((t) => t.id === run.importType);

  return (
    <article className="run">
      <header className="run-head">
        <div>
          <h2>{run.filename ?? run.id}</h2>
          <p className="run-sub">
            {partner?.name ?? run.partnerId}, {importType?.label.toLowerCase()}
            {run.analysis?.format && <>, read as {run.analysis.format.toUpperCase()}{run.analysis.encoding !== 'utf-8' && ` (${run.analysis.encoding})`}</>}
          </p>
        </div>
        <span className={`status-pill large s-${run.status}`}>{STATUS_TEXT[run.status]}</span>
      </header>

      <p className={`verdict v-${run.status}`}>{verdict(run)}</p>

      {run.fatal && (
        <section className="callout bad">
          <h3>{run.fatal.message}</h3>
          <p>{run.fatal.hint}</p>
        </section>
      )}

      {run.result && <Figures run={run} />}
      {run.status === 'HELD_FOR_REVIEW' && <ReviewActions run={run} onDone={update} />}
      {run.drift?.changed && <Drift drift={run.drift} />}
      {run.analysis?.proposal && <MappingTable run={run} meta={meta} onDone={update} />}
      {run.result && run.result.issueGroups.length > 0 && <Issues groups={run.result.issueGroups} runId={run.id} quarantined={run.result.counts.quarantined} />}
      <p className="run-id muted">Run {run.id}. Search the API logs for this id to trace it.</p>
    </article>
  );
}

function verdict(run: RunDetail): string {
  switch (run.status) {
    case 'AWAITING_MAPPING':
      return 'Some columns could not be matched with confidence. Confirm them below and the file will be imported. Your choices are remembered for this supplier.';
    case 'COMMITTED':
      if (run.commit) {
        const parts = [`${run.commit.inserted} new and ${run.commit.updated} updated products`];
        if (run.commit.unknownSkus) parts.push(`${run.commit.unknownSkus} rows skipped because the SKU is not in the catalog yet`);
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
        <div><dt>Rows read</dt><dd>{r.counts.total}</dd></div>
        <div><dt>Accepted</dt><dd>{r.counts.accepted}</dd></div>
        <div><dt>With warnings</dt><dd>{r.counts.acceptedWithWarnings}</dd></div>
        <div><dt>Set aside</dt><dd className={r.counts.quarantined ? 'bad-text' : ''}>{r.counts.quarantined}</dd></div>
      </dl>
      <div className="limit">
        <div className="limit-label">
          <span>Bad rows {pct(r.errorRate)}</span>
          <span>Limit {pct(r.maxErrorRate)}{run.policy.overridden && ` (changed for this file: ${run.policy.overrideReason})`}</span>
        </div>
        <div className="limit-track" role="img" aria-label={`${pct(r.errorRate)} bad rows against a ${pct(r.maxErrorRate)} limit`}>
          <div className={`limit-fill ${over ? 'over' : ''}`} style={{ width: `${Math.min(100, r.errorRate * 100)}%` }} />
          <div className="limit-mark" style={{ left: `${r.maxErrorRate * 100}%` }} />
        </div>
      </div>
    </section>
  );
}

function ReviewActions({ run, onDone }: { run: RunDetail; onDone: (r: RunDetail) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: typeof api.approve) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn(run.id, reason));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="callout warn">
      <h3>Nothing from this file is in the catalog yet</h3>
      <p>Download the set-aside rows to see what went wrong. Import the good rows only if you know why so many are bad; otherwise ask the supplier for a new file.</p>
      <label>
        Reason (kept with the run)
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Supplier confirmed only these prices changed" />
      </label>
      <div className="actions">
        <button disabled={busy || !reason.trim()} onClick={() => void act(api.approve)}>Import the {plural(run.result?.counts.accepted ?? 0, 'good row')}</button>
        <button className="secondary" disabled={busy} onClick={() => void act(api.reject)}>Reject the file</button>
        <a className="text-link" href={api.quarantineUrl(run.id)}>Download set-aside rows</a>
      </div>
      {error && <p className="bad-text" role="alert">{error}</p>}
    </section>
  );
}

function Drift({ drift }: { drift: NonNullable<RunDetail['drift']> }) {
  return (
    <section className="drift">
      <h3>The columns changed since this supplier's last file</h3>
      <div className="drift-cols">
        {!!drift.added?.length && (
          <div><h4>New</h4><ul>{drift.added.map((f) => <li key={f}>{f}</li>)}</ul></div>
        )}
        {!!drift.removed?.length && (
          <div><h4>Gone</h4><ul>{drift.removed.map((f) => <li key={f}>{f}</li>)}</ul></div>
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

const STATUS_WORD: Record<FieldMatch['status'] | 'confirmed', string> = { auto: 'Matched', needs_confirmation: 'Check', confirmed: 'Confirmed by you', unmapped: 'Not imported', ignored: 'Not imported' };

function MappingTable({ run, meta, onDone }: { run: RunDetail; meta: Meta; onDone: (r: RunDetail) => void }) {
  const proposal = run.analysis!.proposal!;
  const editable = run.status === 'AWAITING_MAPPING';
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
                    <select aria-label={`Product field for ${m.sourceField}`} value={target} onChange={(e) => setChoice({ ...choice, [m.sourceField]: e.target.value })}>
                      <option value="">Don't import</option>
                      {meta.fields.map((f) => (
                        <option key={f.name} value={f.name}>{f.name}{required.has(f.name) ? ' (required)' : ''}</option>
                      ))}
                    </select>
                  ) : (
                    <span>{target || <span className="muted">not imported</span>}</span>
                  )}
                  <span className="reason">{m.reason}</span>
                </td>
                <td><Confidence value={m.confidence} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editable && (
        <div className="actions">
          <button onClick={() => void confirm()} disabled={busy}>{busy ? 'Importing…' : 'Confirm mapping and import'}</button>
          <span className="muted">Saved for this supplier; the next file with these columns won't ask again.</span>
        </div>
      )}
      {problems.length > 0 && (
        <ul className="problems" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------- issues

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
        {quarantined > 0 && <a className="text-link" href={api.quarantineUrl(runId)}>Download {quarantined === 1 ? 'the set-aside row' : `the ${quarantined} set-aside rows`} with reasons</a>}
      </div>
      <ol>
        {visible.map((g) => (
          <li key={`${g.code}${g.sourceField}${g.severity}`} className={`issue sev-${g.severity}`}>
            <div className="issue-count">{g.count}</div>
            <div>
              <p className="issue-title">
                {g.title}
                {g.sourceField && <> in <q>{g.sourceField}</q></>}
                <span className="issue-effect">{g.severity === 'error' ? 'rows set aside' : g.severity === 'warning' ? 'imported, value adjusted or dropped' : 'for information'}</span>
              </p>
              <p className="issue-hint">{g.hint}</p>
              {g.locations.length > 0 && <p className="issue-where">At {g.locations.map(where).join(', ')}{g.count > g.locations.length ? ' and more' : ''}. Code {g.code}.</p>}
            </div>
          </li>
        ))}
      </ol>
      {infoCount > 0 && (
        <button className="link-button" onClick={() => setShowInfo(!showInfo)}>{showInfo ? 'Hide' : 'Show'} {plural(infoCount, 'informational note')}</button>
      )}
    </section>
  );
}
