import {
  analyseBuiltTactic,
  defaultOption,
  defaultOOPPos,
  normalizePi,
  piChoice,
  piLabel,
  piOptions,
  piStale,
  setPi,
  piKeyGroup,
  zonePos,
  builtFromGame,
  gameInstructions,
  FORMATIONS,
  MENTALITIES_FM27,
  newBuiltTactic,
  optimiseTactic,
  parseTacticFile,
  tacticQuality,
  parseBuiltTactics,
  POS_LABEL,
  POS_ORDER,
  rolesAt,
  spreadXY,
  styleInstructions,
  tacticSlots,
  TEAM_INSTRUCTIONS_FM27,
  unavailable,
  type Area,
  type BuiltTactic,
  type Finding,
  type FmPlayer,
  type FmSnapshot,
  type Phase,
  type PosCode,
} from '@fm-immersion/module-fm';
import { invoke } from '@tauri-apps/api/core';
import { Fragment, useContext, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { readScoped, useFmSaveScope, writeScoped } from '../lib/save-store';
import { ReserveContext, useTacticEngine } from './FmTactic';
import { Empty, Fit, More, Panel, useNames } from './FmUi';

/*
 * Construire une tactique de zéro : onze postes et rôles avec et sans ballon, mentalité et consignes d'équipe,
 * puis forces et faiblesses calculées par FM Immersion. Consultatif : le joueur reporte lui-même sa tactique
 * dans FM27, rien n'est écrit dans le jeu. Les tactiques sont retenues sur ce PC, par partie.
 */

const KEY = 'fmi.builder.v1';

/** Tactiques construites de la partie (lues aussi par « Le onze », qui permet de les choisir). */
export function readBuiltTactics(scope: Parameters<typeof readScoped>[1]) {
  return parseBuiltTactics(readScoped<{ list: unknown[] }>(KEY, { ...scope, inheritsLegacy: false }, { list: [] }).list);
}
interface Stored {
  list: unknown[];
  current?: string;
}

/** Range une tactique dans l'éditeur de la partie et l'y ouvre (depuis « Ma tactique idéale »). */
export function addBuiltTactic(scope: Parameters<typeof readScoped>[1], tactic: BuiltTactic) {
  const s = readScoped<Stored>(KEY, { ...scope, inheritsLegacy: false }, { list: [] });
  writeScoped(KEY, scope, { list: [...parseBuiltTactics(s.list), { ...tactic, updatedAt: new Date().toISOString() }], current: tactic.id });
}

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `t${Date.now()}`);
const TONE_DOT = { good: 'bg-eau', warn: 'bg-ambre', bad: 'bg-corail' } as const;
const AREAS: Area[] = ['roles', 'lanes', 'centre', 'rest', 'attack', 'transition', 'press', 'coherence', 'squad'];
const STAGES = ['ip', 'transition', 'oop'] as const;

/** Poste de la zone visée, ou null dans la surface de son propre gardien (le gardien ne se déplace pas). */
const dropPos = (x: number, y: number): PosCode | null => (y >= 86 ? null : zonePos(x, y));

/** Zones du terrain et leur poste (mêmes bornes que zonePos), affichées pendant un déplacement. */
const DROP_ZONES: { pos: PosCode; x0: number; x1: number; y0: number; y1: number }[] = (() => {
  const cols: [number, number, 'G' | 'C' | 'D'][] = [[3, 27, 'G'], [27, 73, 'C'], [73, 97, 'D']];
  const rows: [number, number][] = [[18, 36], [36, 55], [55, 68], [68, 86]];
  const out: { pos: PosCode; x0: number; x1: number; y0: number; y1: number }[] = [{ pos: 'BT', x0: 3, x1: 97, y0: 2, y1: 18 }];
  for (const [y0, y1] of rows) for (const [x0, x1] of cols) out.push({ pos: zonePos((x0 + x1) / 2, (y0 + y1) / 2), x0, x1, y0, y1 });
  return out;
})();

export function FmBuilder({ snap, players, folder }: { snap?: FmSnapshot; players: FmPlayer[]; folder: string }) {
  const { t, i18n } = useTranslation();
  const en = i18n.resolvedLanguage === 'en';
  const names = useNames();
  const scope = useFmSaveScope();
  const { engine } = useTacticEngine(folder, players);
  const avail = useMemo(() => players.filter((p) => !unavailable(p) && Object.keys(p.attributes).length > 0), [players]);
  // Réserve et jeunes : ils dépannent un poste que l'équipe première ne couvre pas, comme dans « Le onze ».
  const reserveAll = useContext(ReserveContext);
  const reserve = useMemo(() => reserveAll.filter((p) => !unavailable(p) && Object.keys(p.attributes).length > 0), [reserveAll]);
  const game = useMemo(() => tacticSlots(snap?.tactic), [snap]);
  const gameName = typeof snap?.tactic?.name === 'string' ? snap.tactic.name : null;

  const [store, setStore] = useState<{ list: BuiltTactic[]; current?: string }>(() => {
    const s = readScoped<Stored>(KEY, { ...scope, inheritsLegacy: false }, { list: [] });
    return { list: parseBuiltTactics(s.list), current: s.current };
  });
  const save = (list: BuiltTactic[], current?: string) => {
    const next = { list, current };
    setStore(next);
    writeScoped(KEY, scope, next);
  };
  const cur = store.list.find((x) => x.id === store.current) ?? store.list[0] ?? null;
  const put = (x: BuiltTactic) => save(store.list.some((y) => y.id === x.id) ? store.list.map((y) => (y.id === x.id ? { ...x, updatedAt: new Date().toISOString() } : y)) : [...store.list, x], x.id);

  const [form, setForm] = useState('4-3-3');
  const [phase, setPhase] = useState<Phase>('ip');
  const [hover, setHover] = useState<number[] | null>(null);
  // Glisser-déposer sur le terrain : le créneau déplacé et sa position en % du terrain.
  const pitchRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ i: number; x: number; y: number } | null>(null);
  // Créneau dont les consignes individuelles sont ouvertes dans le tableau.
  const [openPi, setOpenPi] = useState<number | null>(null);
  const analysis = useMemo(() => (cur ? analyseBuiltTactic(engine, cur, avail, reserve) : null), [engine, cur, avail, reserve]);

  // Réglage automatique : rôles et consignes ajustés pour monter la note de qualité, dans une copie (l'original reste).
  const [improved, setImproved] = useState<{ before: number; after: number; roles: number; instructions: number } | null>(null);
  const improve = () => {
    if (!cur) return;
    const o = optimiseTactic(engine, cur, avail, { reserve });
    setImproved({ before: o.before, after: o.after, roles: o.roles, instructions: o.instructions });
    if (o.after > o.before) put({ ...o.tactic, id: newId(), name: t('fm.builder.improvedName', { name: cur.name }) });
  };
  const create = () => put(newBuiltTactic(engine, form, newId(), t('fm.builder.defaultName', { form })));
  const fromGame = () => {
    const mentality = typeof snap?.tactic?.mentality === 'string' ? snap.tactic.mentality : null;
    const x = game && builtFromGame(engine, game, newId(), gameName ?? t('fm.builder.gameName'), gameInstructions(snap), mentality);
    if (x) put(x);
  };

  // Import d'une tactique exportée dans le dossier `tactics` de FM27 (lecture seule du fichier .fmf).
  const [files, setFiles] = useState<{ name: string }[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const openImport = async () => {
    setImportMsg(null);
    const list = await invoke<{ name: string }[]>('fm_list_tactic_files', { folder }).catch(() => []);
    setFiles(list);
    setFileName(list[0]?.name ?? '');
    if (!list.length) setImportMsg({ ok: false, text: t('fm.builder.importNone') });
  };
  const importFile = async () => {
    if (!fileName) return;
    try {
      const bytes = await invoke<number[]>('fm_read_tactic_file', { folder, name: fileName });
      const f = parseTacticFile(bytes);
      const x = f && builtFromGame(engine, f.slots, newId(), f.name || fileName.replace(/\.fmf$/i, ''), { ti: {}, pi: f.pi, imposed: [] }, f.mentality);
      if (!x) throw new Error('format');
      put(x);
      setFiles(null);
      setImportMsg({ ok: true, text: t('fm.builder.importDone', { name: x.name }) });
    } catch {
      setImportMsg({ ok: false, text: t('fm.builder.importFailed', { name: fileName }) });
    }
  };

  const starters = (
    <div className="flex flex-wrap items-center gap-2">
      <select className="input w-auto py-1.5" value={form} onChange={(e) => setForm(e.target.value)} aria-label={t('fm.tac.formation')}>
        {Object.keys(FORMATIONS).map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <button type="button" className="btn-primary px-3 py-1.5 text-sm" onClick={create}>
        {t('fm.builder.new')}
      </button>
      {game && (
        <button type="button" className="btn-secondary px-3 py-1.5 text-sm" onClick={fromGame}>
          {t('fm.builder.fromGame')}
        </button>
      )}
      {files == null ? (
        <button type="button" className="btn-secondary px-3 py-1.5 text-sm" onClick={() => void openImport()} title={t('fm.builder.importHelp')}>
          {t('fm.builder.importOpen')}
        </button>
      ) : (
        files.length > 0 && (
          <>
            <select className="input w-auto max-w-xs py-1.5" value={fileName} onChange={(e) => setFileName(e.target.value)} aria-label={t('fm.builder.importPick')}>
              {files.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name.replace(/\.fmf$/i, '')}
                </option>
              ))}
            </select>
            <button type="button" className="btn-primary px-3 py-1.5 text-sm" onClick={() => void importFile()}>
              {t('fm.builder.importGo')}
            </button>
          </>
        )
      )}
      {importMsg && <p className={`w-full text-xs ${importMsg.ok ? 'text-brun' : 'text-corail'}`}>{importMsg.text}</p>}
    </div>
  );

  if (!cur || !analysis)
    return (
      <Panel title={t('fm.builder.title')}>
        <p className="mb-3 text-sm text-brun">{t('fm.builder.empty')}</p>
        {starters}
      </Panel>
    );

  const setSlot = (i: number, p: Partial<BuiltTactic['slots'][number]>) => {
    const slots = cur.slots.map((s, k) => (k === i ? { ...s, ...p } : s));
    // Poste changé : le rôle reste s'il existe au nouveau poste, sinon le premier rôle proposé.
    const fix = (ph: Phase) => {
      const list = rolesAt(engine, slots.map((s) => ({ pos: ph === 'ip' ? s.pos : s.posOOP })), i, ph);
      const code = slots[i]![ph];
      if (!list.some((r) => r.code === code)) slots[i] = { ...slots[i]!, [ph]: (list.find((r) => r.phase === 'both') ?? list[0])?.code ?? code };
    };
    if (p.pos) fix('ip');
    if (p.posOOP || p.pos) fix('oop');
    put({ ...cur, slots });
  };
  // Glisser-déposer : position du pointeur en % du terrain, poste de la zone visée au relâchement.
  const at = (e: ReactPointerEvent): [number, number] | null => {
    const r = pitchRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return [Math.max(4, Math.min(96, ((e.clientX - r.left) / r.width) * 100)), Math.max(3, Math.min(97, ((e.clientY - r.top) / r.height) * 100))];
  };
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, i: number) => {
    const p = at(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ i, x: p[0], y: p[1] });
  };
  const moveDrag = (e: ReactPointerEvent, i: number) => {
    if (drag?.i !== i) return;
    const p = at(e);
    if (p) setDrag({ i, x: p[0], y: p[1] });
  };
  const endDrag = (e: ReactPointerEvent, i: number) => {
    if (drag?.i !== i) return;
    const p = at(e) ?? [drag.x, drag.y];
    setDrag(null);
    const pos = dropPos(p[0], p[1]);
    if (!pos) return;
    const s = cur.slots[i]!;
    if (phase === 'oop') {
      if (pos !== s.posOOP) setSlot(i, { posOOP: pos });
    } else if (pos !== s.pos) {
      // Le poste sans ballon suit tant que le joueur ne l'avait pas changé lui-même.
      setSlot(i, s.posOOP === defaultOOPPos(s.pos) ? { pos, posOOP: defaultOOPPos(pos) } : { pos });
    }
  };
  const roleLabel = (code: string, ph: Phase) => {
    const r = engine.roles.get(code);
    return r ? `${names.role(r)}${ph === 'ip' && r.duty ? ` (${t(`fm.tac.duty.${r.duty}`)})` : ''}` : code;
  };
  const posOptions = (gk: boolean) => (gk ? (['GB'] as PosCode[]) : POS_ORDER.filter((p) => p !== 'GB'));
  const pts = spreadXY(analysis.xy[phase], 21, 12).map(([x, y]) => [Math.min(88, Math.max(12, x)), Math.min(91, Math.max(7, y))] as [number, number]);
  const sideName = (s: unknown) => t(`fm.builder.side.${String(s)}`);
  const text = (f: Finding) =>
    t(`fm.builder.f.${f.id}`, {
      ...f.params,
      side: f.params.side != null ? sideName(f.params.side) : undefined,
      phase: f.params.phase != null ? t(`fm.tac.phase.${String(f.params.phase)}`) : undefined,
      zone: f.params.zone != null ? t(`fm.builder.zone.${String(f.params.zone)}`) : undefined,
      names: Array.isArray(f.params.names) ? (f.params.names as string[]).join(', ') : undefined,
    });
  const pros = analysis.findings.filter((f) => f.tone === 'good');
  const cons = analysis.findings.filter((f) => f.tone !== 'good').sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1));
  const item = (f: Finding, k: number) => (
    <li
      key={`${f.id}-${k}`}
      className="flex gap-2 rounded-lg px-2 py-1 hover:bg-creme"
      onMouseEnter={() => setHover(f.slots ?? null)}
      onMouseLeave={() => setHover(null)}
    >
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[f.tone]}`} aria-hidden />
      <span>
        <span className="mr-1 text-xs font-bold uppercase text-canard/60">{t(`fm.builder.area.${f.area}`)}</span>
        {text(f)}
      </span>
    </li>
  );
  const gauge = (label: string, v: number, invert = false) => {
    const tone = invert ? (v >= 65 ? 'bg-corail' : v >= 40 ? 'bg-ambre' : 'bg-eau') : v >= 60 ? 'bg-eau' : v >= 35 ? 'bg-ambre' : 'bg-corail';
    return (
      <div>
        <div className="flex justify-between text-sm">
          <span className="font-bold">{label}</span>
          <span>{v}</span>
        </div>
        <div className="mt-1 h-2 rounded-full bg-canard/10">
          <div className={`h-2 rounded-full ${tone}`} style={{ width: `${v}%` }} />
        </div>
      </div>
    );
  };
  const stageDefs = (st: (typeof STAGES)[number]) => TEAM_INSTRUCTIONS_FM27.filter((d) => d.phase === st);
  const setTi = (id: number, o: number, def: number) => {
    const ti = { ...cur.ti };
    if (o === def) delete ti[id];
    else ti[id] = o;
    put({ ...cur, ti });
  };

  return (
    <div className="space-y-4">
      {/* Tactiques retenues, nom, nouvelle tactique. */}
      <section className="card flex flex-wrap items-center gap-3">
        <select className="input w-auto max-w-[16rem] py-1.5" value={cur.id} onChange={(e) => save(store.list, e.target.value)} aria-label={t('fm.builder.saved')}>
          {store.list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm font-bold">
          {t('fm.builder.name')}
          <input className="input w-auto max-w-[16rem] py-1.5 font-normal" value={cur.name} onChange={(e) => put({ ...cur, name: e.target.value })} maxLength={60} />
        </label>
        <span className="text-xs text-brun" title={t('fm.builder.savedHelp')}>
          ✓ {t('fm.builder.savedAuto')}
        </span>
        <button type="button" className="btn-secondary px-3 py-1.5 text-sm" onClick={() => put({ ...cur, id: newId(), name: t('fm.builder.copyName', { name: cur.name }) })}>
          {t('fm.builder.duplicate')}
        </button>
        <button
          type="button"
          className="px-2 py-1.5 text-sm font-bold text-corail hover:underline"
          onClick={() => {
            if (window.confirm(t('fm.builder.deleteConfirm', { name: cur.name }))) save(store.list.filter((x) => x.id !== cur.id));
          }}
        >
          {t('fm.builder.delete')}
        </button>
        <div className="ml-auto">{starters}</div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        {/* Terrain : forme avec ou sans ballon, rôles appliqués. */}
        <section className="card">
          <div ref={pitchRef} className="relative mx-auto aspect-[3/4] w-full max-w-[24rem] overflow-hidden rounded-2xl bg-eau-fonce/90">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
              <g fill="none" stroke="white" strokeOpacity="0.35" strokeWidth="0.4">
                <rect x="3" y="2" width="94" height="96" />
                <line x1="3" y1="50" x2="97" y2="50" />
                <circle cx="50" cy="50" r="9" />
                <rect x="25" y="2" width="50" height="15" />
                <rect x="25" y="83" width="50" height="15" />
              </g>
            </svg>
            {drag && (
              // Zones du jeu pendant un déplacement : la case visée prend le poste.
              <div className="pointer-events-none absolute inset-0" aria-hidden>
                {DROP_ZONES.map((z) => {
                  const on = dropPos(drag.x, drag.y) === z.pos && z.x0 <= drag.x && drag.x < z.x1 && z.y0 <= drag.y && drag.y < z.y1;
                  return (
                    <div
                      key={`${z.pos}${z.x0}${z.y0}`}
                      className={`absolute flex items-center justify-center border border-white/20 text-[0.65rem] font-bold ${on ? 'bg-ambre/40 text-white' : 'text-white/40'}`}
                      style={{ left: `${z.x0}%`, top: `${z.y0}%`, width: `${z.x1 - z.x0}%`, height: `${z.y1 - z.y0}%` }}
                    >
                      {POS_LABEL[z.pos]}
                    </div>
                  );
                })}
              </div>
            )}
            {cur.slots.map((s, i) => {
              const dragging = drag?.i === i;
              const [x, y] = dragging ? [drag.x, drag.y] : pts[i]!;
              const code = phase === 'ip' ? s.ip : s.oop;
              const pos = phase === 'ip' ? s.pos : s.posOOP;
              const lit = hover?.includes(i);
              const gk = s.pos === 'GB';
              return (
                <div
                  key={i}
                  className={`absolute flex w-[24%] -translate-x-1/2 -translate-y-1/2 select-none flex-col items-center ${dragging ? 'z-10' : 'transition-all duration-500'} ${gk ? '' : 'cursor-grab touch-none active:cursor-grabbing'}`}
                  style={{ left: `${x}%`, top: `${y}%` }}
                  title={gk ? undefined : t('fm.builder.dragHint')}
                  onPointerDown={gk ? undefined : (e) => startDrag(e, i)}
                  onPointerMove={gk ? undefined : (e) => moveDrag(e, i)}
                  onPointerUp={gk ? undefined : (e) => endDrag(e, i)}
                  onPointerCancel={() => setDrag(null)}
                >
                  <span className={`whitespace-nowrap rounded-full bg-white px-2 py-0.5 text-xs font-bold text-canard shadow ring-2 ${dragging ? 'ring-orange' : lit ? 'ring-ambre' : 'ring-white/0'}`}>
                    {dragging ? POS_LABEL[dropPos(drag.x, drag.y) ?? pos] : POS_LABEL[pos]}
                  </span>
                  <span className="mt-0.5 max-w-full truncate rounded bg-canard/85 px-1.5 text-[0.7rem] font-bold text-white">{engine.roles.get(code)?.code ?? code}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-2" role="tablist">
            {(['ip', 'oop'] as const).map((ph) => (
              <button key={ph} type="button" role="tab" aria-selected={phase === ph} onClick={() => setPhase(ph)} className={`chip ${phase === ph ? 'chip-on' : ''}`}>
                {t(`fm.tac.phase.${ph}`)} {analysis.shape[ph]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-center text-xs text-brun">{t(`fm.builder.dragHelp.${phase}`)}</p>
        </section>

        {/* L'analyse : jauges, risque, forces et faiblesses, duos. */}
        <Panel
          title={t('fm.builder.analysis')}
          className="min-w-0"
          action={
            <div className="flex flex-wrap items-center justify-end gap-3">
              <span className="text-sm">
                {t('fm.builder.quality')} <b className="text-base">{tacticQuality(analysis)}</b>
                <span className="text-brun"> / 100</span>
              </span>
              <button type="button" className="btn-primary px-3 py-1.5 text-sm" onClick={improve}>
                {t('fm.builder.improve')}
              </button>
            </div>
          }
        >
          {improved && (
            <p className="mb-3 rounded-lg bg-canard/5 px-3 py-2 text-sm">
              {improved.after > improved.before ? t('fm.builder.improved', improved) : t('fm.builder.notImproved')}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
            {gauge(t('fm.builder.score.penetration'), analysis.scores.penetration)}
            {gauge(t('fm.builder.score.support'), analysis.scores.support)}
            {gauge(t('fm.builder.score.solidity'), analysis.scores.solidity)}
            {gauge(t('fm.builder.score.risk'), analysis.risk, true)}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {AREAS.filter((a) => a !== 'squad' || analysis.squad).map((a) => (
              <span key={a} className="inline-flex items-center gap-1.5 rounded-md bg-creme px-2 py-0.5 text-sm">
                <span className={`h-2 w-2 rounded-full ${TONE_DOT[analysis.areas[a]]}`} aria-hidden />
                {t(`fm.builder.area.${a}`)}
              </span>
            ))}
          </div>
          <div className="mt-4 grid gap-4 2xl:grid-cols-2">
            <div>
              <h3 className="font-bold">{t('fm.builder.cons', { count: cons.length })}</h3>
              {cons.length ? <ul className="mt-1 space-y-0.5 text-sm">{cons.map(item)}</ul> : <p className="text-sm text-brun">{t('fm.builder.noCons')}</p>}
            </div>
            <div>
              <h3 className="font-bold">{t('fm.builder.pros', { count: pros.length })}</h3>
              {pros.length ? <ul className="mt-1 space-y-0.5 text-sm">{pros.map(item)}</ul> : <p className="text-sm text-brun">{t('fm.builder.noPros')}</p>}
            </div>
          </div>
          {analysis.partnerships.length > 0 && (
            <div className="mt-4">
              <h3 className="font-bold">{t('fm.builder.pairs')}</h3>
              <ul className="mt-1 flex flex-wrap gap-2 text-sm">
                {analysis.partnerships.map((p) => (
                  <li
                    key={p.zone}
                    className="inline-flex items-center gap-1.5 rounded-md bg-creme px-2 py-0.5"
                    onMouseEnter={() => setHover(p.slots)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <span className={`h-2 w-2 rounded-full ${p.status === 'balanced' ? 'bg-eau' : p.status === 'overloading' ? 'bg-ambre' : 'bg-corail'}`} aria-hidden />
                    {t(`fm.builder.zone.${p.zone}`)} · {t(`fm.builder.pairStatus.${p.status}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!analysis.squad && <p className="mt-3 text-sm text-brun">{t('fm.builder.noSquad')}</p>}
          <More>{t('fm.builder.help')}</More>
        </Panel>
      </div>

      {/* Les onze créneaux : poste et rôle avec ballon, puis sans ballon. */}
      <section className="card overflow-x-auto">
        <h2 className="text-lg font-semibold">{t('fm.builder.slots')}</h2>
        <p className="mb-2 text-sm text-brun">{t('fm.builder.slotsHelp')}</p>
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-canard/60">
              <th className="py-1">{t('fm.builder.posIp')}</th>
              <th>{t('fm.builder.roleIp')}</th>
              <th>{t('fm.builder.posOop')}</th>
              <th>{t('fm.builder.roleOop')}</th>
              <th>{t('fm.builder.pi')}</th>
              {analysis.squad && <th>{t('fm.builder.player')}</th>}
            </tr>
          </thead>
          <tbody>
            {cur.slots.map((s, i) => {
              const gk = s.pos === 'GB';
              const ipRoles = rolesAt(engine, cur.slots, i, 'ip');
              const oopRoles = rolesAt(engine, cur.slots.map((x) => ({ pos: x.posOOP })), i, 'oop');
              const sq = analysis.squad?.xi[i];
              const lit = hover?.includes(i);
              const pi = normalizePi(s.pi ?? []);
              const stale = piStale(engine, cur, i);
              const open = openPi === i;
              const opts = open ? piOptions(engine, cur, i) : null;
              return (
                <Fragment key={i}>
                <tr className={`border-t border-canard/10 ${lit ? 'bg-ambre/15' : ''}`}>
                  <td className="py-1 pr-2">
                    <select className="input py-1" value={s.pos} disabled={gk} onChange={(e) => setSlot(i, { pos: e.target.value as PosCode, posOOP: e.target.value === 'MOG' ? 'MG' : e.target.value === 'MOD' ? 'MD' : (e.target.value as PosCode) })}>
                      {posOptions(gk).map((p) => (
                        <option key={p} value={p}>
                          {POS_LABEL[p]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="pr-2">
                    <select className="input w-full py-1" value={s.ip} onChange={(e) => setSlot(i, { ip: e.target.value })}>
                      {!ipRoles.some((r) => r.code === s.ip) && <option value={s.ip}>{roleLabel(s.ip, 'ip')} ⚠</option>}
                      {ipRoles.map((r) => (
                        <option key={r.code} value={r.code}>
                          {roleLabel(r.code, 'ip')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="pr-2">
                    <select className="input py-1" value={s.posOOP} disabled={gk} onChange={(e) => setSlot(i, { posOOP: e.target.value as PosCode })}>
                      {posOptions(gk).map((p) => (
                        <option key={p} value={p}>
                          {POS_LABEL[p]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="pr-2">
                    <select className="input w-full py-1" value={s.oop} onChange={(e) => setSlot(i, { oop: e.target.value })}>
                      {!oopRoles.some((r) => r.code === s.oop) && <option value={s.oop}>{roleLabel(s.oop, 'oop')} ⚠</option>}
                      {oopRoles.map((r) => (
                        <option key={r.code} value={r.code}>
                          {roleLabel(r.code, 'oop')}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="pr-2">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setOpenPi(open ? null : i)}
                      className={`chip whitespace-nowrap ${open ? 'chip-on' : ''} ${stale.length ? 'ring-1 ring-ambre' : ''}`}
                    >
                      {t('fm.builder.piCount', { count: pi.length })} {open ? '▴' : '▾'}
                    </button>
                  </td>
                  {analysis.squad && (
                    <td className="whitespace-nowrap">
                      {sq?.player ? (
                        <span className="flex items-center gap-2">
                          <span className="max-w-[9rem] truncate">{sq.player.name}</span>
                          <Fit value={sq.fit} />
                        </span>
                      ) : (
                        <span className="text-corail">{t('fm.tac.nobody')}</span>
                      )}
                    </td>
                  )}
                </tr>
                {open && opts && (
                  <tr className="bg-creme/60">
                    <td colSpan={analysis.squad ? 6 : 5} className="px-2 py-2">
                      {(['ip', 'oop'] as const).map((ph) => (
                        <div key={ph} className="mb-2">
                          <div className="mb-1 text-xs font-bold uppercase text-canard/60">{t(`fm.tac.phase.${ph}`)}</div>
                          <div className="grid gap-x-3 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                            {opts[ph].map((g) => {
                              const title = en ? g.def.en : g.def.fr;
                              const lab = (fr: string) => (en ? g.def.options.find((o) => o.fr === fr)?.en ?? fr : fr);
                              const chosen = piChoice(pi, g.def.group);
                              const value = chosen && g.options.includes(chosen) ? chosen : '';
                              return (
                                <label key={g.def.group} className={`flex flex-col text-xs ${g.state === 'free' ? '' : 'opacity-60'}`}>
                                  <span className="mb-0.5 font-semibold text-canard">
                                    {g.state !== 'free' && '🔒 '}
                                    {title}
                                  </span>
                                  <select
                                    className={`input py-1 text-sm ${value ? 'ring-1 ring-orange' : ''}`}
                                    disabled={g.state !== 'free'}
                                    title={g.state === 'imposed' ? t('fm.builder.piImposed') : g.state === 'locked' ? t('fm.builder.piLocked') : undefined}
                                    value={g.state === 'imposed' ? g.imposed : value}
                                    onChange={(e) => setSlot(i, { pi: setPi(pi, g.def.group, e.target.value || null) })}
                                  >
                                    {g.state === 'imposed' ? (
                                      <option value={g.imposed}>{lab(g.imposed!)}</option>
                                    ) : (
                                      <>
                                        <option value="">{en ? g.def.neutral.en : g.def.neutral.fr}</option>
                                        {g.options.map((o) => (
                                          <option key={o} value={o}>
                                            {lab(o)}
                                          </option>
                                        ))}
                                      </>
                                    )}
                                  </select>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      {stale.length > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-brun">{t('fm.builder.piStaleHelp')}</span>
                          {stale.map((k) => {
                            const l = piLabel(k, en);
                            return (
                              <button key={k} type="button" onClick={() => setSlot(i, { pi: setPi(pi, piKeyGroup(k), null) })} className="chip line-through" title={t('fm.builder.piRemove')}>
                                {l.group} : {l.option} ✕
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <p className="mt-1 text-xs text-brun">{t('fm.builder.piHelp')}</p>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Le style : mentalité, consignes d'équipe comme à l'écran du jeu. */}
      <Panel title={t('fm.builder.styleTitle')}>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-bold">
            {t('fm.builder.mentality')}
            <select className="input py-1.5 font-normal" value={cur.mentality} onChange={(e) => put({ ...cur, mentality: e.target.value })}>
              {MENTALITIES_FM27.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm font-bold">
            {t('fm.builder.preset')}
            <select
              className="input py-1.5 font-normal"
              value=""
              onChange={(e) => {
                const st = engine.ref.styles.find((s) => s.id === e.target.value);
                if (!st) return;
                const x = styleInstructions(st);
                put({ ...cur, ti: x.ti, mentality: x.mentality ?? cur.mentality });
              }}
            >
              <option value="">{t('fm.builder.presetPick')}</option>
              {engine.ref.styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {names.style(s)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="text-sm font-bold text-orange-fonce hover:underline" onClick={() => put({ ...cur, ti: {} })}>
            {t('fm.builder.resetTi')}
          </button>
          <span className="text-sm text-brun">{t('fm.builder.tiCount', { count: analysis.instructions })}</span>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {STAGES.map((st) => (
            <div key={st}>
              <p className="text-xs font-bold uppercase text-canard/60">{t(`fm.builder.stage.${st}`)}</p>
              <ul className="mt-1 space-y-1 text-sm">
                {stageDefs(st).map((d) => {
                  const o = cur.ti[d.id] ?? defaultOption(d);
                  const set = cur.ti[d.id] != null && cur.ti[d.id] !== defaultOption(d);
                  return (
                    <li key={d.id} className="flex items-center justify-between gap-2">
                      <span className={set ? 'font-bold' : 'text-brun'}>{d.title}</span>
                      <select className={`input max-w-[12rem] py-0.5 text-sm ${set ? 'font-bold' : ''}`} value={o} onChange={(e) => setTi(d.id, Number(e.target.value), defaultOption(d))}>
                        {d.short.map((label, k) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </Panel>

      {!avail.length && players.length > 0 && <Empty>{t('fm.tac.noAttributes')}</Empty>}
    </div>
  );
}
