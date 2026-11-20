/**
 * The annual council review and the end-of-tenure legacy report.
 */
import type { GameSession } from '../app/session.ts';
import { FACTIONS, FACTION_NAMES } from '../sim/types.ts';
import { approvalColor, money, yearOfDay } from './format.ts';
import { objectives } from '../sim/objectives.ts';

const VERDICTS: Record<string, [string, string]> = {
  praise: ['The council is pleased.', 'Your stewardship has earned real confidence. Keep it.'],
  ok: ['The council renews your mandate.', 'Not everyone is happy — no one ever is — but the work goes on.'],
  warning: ['A formal warning.', 'Trust has fallen below 30. Another year like this and the council will replace you.'],
  dismissed: ['You have been dismissed.', 'The council has lost faith in your stewardship.'],
  bankrupt: ['Receivership.', 'The Service is too deep in debt. The council has taken control of its finances — and replaced its warden.'],
  tenure: ['Your tenure is complete.', 'You have served the full term. It is time to see what you leave behind.'],
};

export function ReviewModal({ s }: { s: GameSession }) {
  const w = s.world;
  const r = w.review;
  const [head, sub] = VERDICTS[r.verdict] ?? VERDICTS.ok;
  // year-end entries are filed under the closing year (World.record), so they show in its review
  const highlights = w.chronicle.filter((c) => yearOfDay(w, c.day) === r.year && c.importance >= 2).slice(-6);
  const ends = r.verdict === 'dismissed' || r.verdict === 'bankrupt' || r.verdict === 'tenure';
  const reserve = 0.35 * r.budgetNext;
  const returned = Math.max(0, w.economy.funds - reserve);
  return (
    <div class="modal-back">
      <div class="modal">
        <div class="faint" style={{ fontSize: '12px', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          {w.valleyName} · end of year {r.year}
        </div>
        <h1>The Council Review</h1>
        <div class="card" style={{ marginTop: '12px', borderColor: r.verdict === 'warning' || ends ? 'rgba(226,85,63,0.55)' : r.verdict === 'praise' ? 'rgba(111,191,115,0.5)' : undefined }}>
          <h3>{head}</h3>
          <div class="dim">{sub}</div>
        </div>
        <div class="grid2" style={{ marginTop: '14px' }}>
          <div>
            <h4>The year in numbers</h4>
            <div class="kv" style={{ marginTop: '6px' }}>
              {r.report.map(([k, v]) => (
                <>
                  <span class="k">{k}</span>
                  <span class="v">{v}</span>
                </>
              ))}
              {!ends && returned > 0 ? (
                <>
                  <span class="k">Returned to county</span>
                  <span class="v" style={{ color: 'var(--gold)' }}>
                    {money(returned)}
                  </span>
                </>
              ) : null}
            </div>
            <h4 style={{ marginTop: '14px' }}>Your charge</h4>
            {objectives(w).map((o) => (
              <div class="row" style={{ fontSize: '12.5px', marginTop: '4px', alignItems: 'baseline' }} key={o.id}>
                <span style={{ color: o.state === 'failed' ? 'var(--red)' : o.state === 'behind' ? 'var(--gold)' : 'var(--green)', width: '14px' }}>{o.state === 'failed' ? '✗' : o.state === 'behind' ? '…' : '✓'}</span>
                <span class="grow">
                  {o.title} <span class="faint">· {o.reading}</span>
                </span>
              </div>
            ))}
            {highlights.length ? (
              <>
                <h4 style={{ marginTop: '14px' }}>Remembered</h4>
                {highlights.map((c, k) => (
                  <div class="dim" style={{ fontSize: '12.5px', marginTop: '4px' }} key={k}>
                    • {c.text}
                  </div>
                ))}
              </>
            ) : null}
          </div>
          <div>
            <h4>Where they stand</h4>
            {FACTIONS.map((f) => {
              const st = w.factions[f];
              const top = st.factors[0];
              return (
                <div style={{ marginTop: '7px' }} key={f}>
                  <div class="row">
                    <span class="grow">{FACTION_NAMES[f]}</span>
                    <b class="num" style={{ color: approvalColor(st.approval) }}>
                      {Math.round(st.approval)}
                    </b>
                  </div>
                  <div class="bar" style={{ marginTop: '3px' }}>
                    <i style={{ width: `${st.approval}%`, background: approvalColor(st.approval) }} />
                  </div>
                  {top ? (
                    <div class="faint" style={{ fontSize: '11.5px', marginTop: '2px' }}>
                      {top[0]} ({top[1] >= 0 ? '+' : ''}
                      {top[1].toFixed(0)})
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
        {r.petitions.length && !ends ? (
          <>
            <h4 style={{ marginTop: '18px' }}>Petitions before the council</h4>
            <div class="col" style={{ marginTop: '8px', gap: '8px' }}>
              {r.petitions.map((p) => (
                <div class={'petition' + (p.resolved ? ' resolved' : '')} key={p.id}>
                  <div class="row">
                    <span class="tag">{FACTION_NAMES[p.faction]}</span>
                    <b class="grow">{p.title}</b>
                    {p.resolved ? (
                      <span class="tag" style={{ color: p.accepted ? 'var(--green)' : 'var(--red)' }}>
                        {p.accepted ? 'granted' : 'refused'}
                      </span>
                    ) : (
                      <>
                        <button class="btn small" onClick={() => s.command({ t: 'petition', id: p.id, accept: false })}>
                          Refuse
                        </button>
                        <button class="btn small primary" onClick={() => s.command({ t: 'petition', id: p.id, accept: true })}>
                          Grant
                        </button>
                      </>
                    )}
                  </div>
                  <div class="dim" style={{ fontSize: '12.5px', marginTop: '5px' }}>
                    {p.text}
                  </div>
                  <div class="faint" style={{ fontSize: '11.5px', marginTop: '4px' }}>
                    Grant: {FACTION_NAMES[p.faction]} +{p.acceptDelta}
                    {p.sideEffects.map(([f, d]) => `, ${FACTION_NAMES[f]} ${d > 0 ? '+' : ''}${d}`).join('')} · Refuse: {FACTION_NAMES[p.faction]} {p.declineDelta}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
        <div class="row" style={{ marginTop: '18px' }}>
          <span class="faint grow" style={{ fontSize: '12px' }}>
            {ends ? '' : 'Unanswered petitions count as refused, though less sharply.'}
          </span>
          <button class="btn primary" onClick={() => s.command({ t: 'closeReview' })}>
            {ends ? 'See your legacy' : `Begin year ${r.year + 1}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EndModal({ s, onNew, onTitle, onContinue }: { s: GameSession; onNew: () => void; onTitle: () => void; onContinue: () => void }) {
  const o = s.world.outcome;
  const max: Record<string, number> = {
    'Homes kept safe': 15,
    'A living community': 10,
    'Fire doing its work': 8,
    'Safer around homes': 7,
    'A resilient forest': 7, // v1.0 saves that ended before v1.1
    'Wild things': 9,
    'A diverse landscape': 6,
    'Clean water': 10,
    'Sound finances': 10,
    'The council’s trust': 25,
  };
  return (
    <div class="modal-back">
      <div class="modal">
        <div class="faint" style={{ fontSize: '12px', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          {s.world.valleyName} · year {o.year}
        </div>
        <div class="row" style={{ alignItems: 'flex-end', gap: '20px', marginTop: '6px' }}>
          <div>
            <h1>Your legacy</h1>
            <div class="dim" style={{ fontFamily: 'var(--serif)', fontSize: '18px', fontStyle: 'italic' }}>
              {o.grade.split(' — ')[1]}
            </div>
          </div>
          <span class="grow" />
          <div style={{ textAlign: 'right' }}>
            <div class="grade">{o.score}</div>
            <div class="faint">of 100 · grade {o.grade.split(' — ')[0]}</div>
          </div>
        </div>
        <div class="grid2" style={{ marginTop: '16px' }}>
          <div>
            {o.breakdown.map(([k, v, d]) => (
              <div style={{ marginBottom: '9px' }} key={k}>
                <div class="row">
                  <span class="grow">{k}</span>
                  <b class="num">
                    {v.toFixed(1)} <span class="faint">/ {max[k] ?? '—'}</span>
                  </b>
                </div>
                <div class="bar" style={{ marginTop: '3px' }}>
                  <i style={{ width: `${(100 * v) / (max[k] ?? 10)}%`, background: 'var(--ember)' }} />
                </div>
                <div class="faint" style={{ fontSize: '11.5px' }}>
                  {d}
                </div>
              </div>
            ))}
          </div>
          <div>
            <h4>The valley remembers</h4>
            {o.epilogue.map((p, k) => (
              <p class="dim" style={{ fontSize: '13px', margin: '8px 0 0', fontFamily: 'var(--serif)' }} key={k}>
                {p}
              </p>
            ))}
          </div>
        </div>
        <div class="row" style={{ marginTop: '18px', justifyContent: 'flex-end' }}>
          <button class="btn" onClick={onTitle}>
            Title screen
          </button>
          <button class="btn" onClick={onContinue}>
            Keep playing (sandbox)
          </button>
          <button class="btn primary" onClick={onNew}>
            New valley
          </button>
        </div>
      </div>
    </div>
  );
}
