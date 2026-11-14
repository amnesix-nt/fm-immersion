import type { CareerSpell } from './career';

/**
 * Vie du coach hors terrain (« Ma carrière ») : salaire par club, foyer et journal de vie. Tout est saisi par le
 * joueur et reste dans l'appli : le plugin ne lit pas le contrat du manager et rien n'est écrit dans FM27.
 */
export interface CoachLife {
  /** Salaire hebdomadaire brut par club entraîné (nom du club → montant), saisi par le joueur. */
  wages?: Record<string, number>;
  /** Devise d'affichage (code ISO 4217), EUR par défaut. */
  currency?: string;
  /** Part prélevée (impôts et charges) en pourcentage, 30 par défaut. */
  taxRate?: number;
  /** Dépenses du foyer par mois (logement, voiture, vie courante), dans la devise choisie. */
  monthlyCosts?: number;
  partner?: { name: string; since?: string | null } | null;
  children?: { name: string; born: string }[];
  /** Photo de famille choisie par le joueur (image réduite, data URL). */
  familyPhoto?: string | null;
}

export const CURRENCIES = ['EUR', 'GBP', 'USD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'BRL'] as const;
export const DEFAULT_TAX = 30;

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / DAY) + 1);

export interface SpellPay {
  club: string;
  weekly: number | null;
  days: number;
  /** Brut gagné pendant le passage, null sans salaire saisi. */
  gross: number | null;
}

export interface LifeFinances {
  spells: SpellPay[];
  /** Brut gagné sur les passages dont le salaire est connu. */
  gross: number;
  net: number;
  /** Dépenses du foyer sur toute la carrière (mois de 30,44 jours). */
  costs: number;
  /** Net moins dépenses : ce qui reste de côté. */
  savings: number;
  /** Net par mois au club actuel, null sans salaire saisi ou sans club. */
  monthlyNet: number | null;
  /** Passages sans salaire saisi. */
  missing: number;
  taxRate: number;
}

/** Ce que la carrière a rapporté, d'après les salaires saisis et le nombre de jours passés dans chaque club. */
export function lifeFinances(spells: CareerSpell[], life: CoachLife | undefined): LifeFinances {
  const taxRate = Math.min(90, Math.max(0, life?.taxRate ?? DEFAULT_TAX));
  const rows: SpellPay[] = spells.map((s) => {
    const w = life?.wages?.[s.club];
    const weekly = typeof w === 'number' && w > 0 ? w : null;
    const d = days(s.start, s.end);
    return { club: s.club, weekly, days: d, gross: weekly != null ? Math.round((weekly * d) / 7) : null };
  });
  const gross = rows.reduce((a, r) => a + (r.gross ?? 0), 0);
  const net = Math.round(gross * (1 - taxRate / 100));
  const allDays = rows.reduce((a, r) => a + r.days, 0);
  const costs = Math.round(((life?.monthlyCosts ?? 0) * allDays) / 30.44);
  const now = spells.at(-1);
  const nowWeekly = now?.current ? rows.at(-1)?.weekly ?? null : null;
  return {
    spells: rows,
    gross,
    net,
    costs,
    savings: net - costs,
    monthlyNet: nowWeekly != null ? Math.round(((nowWeekly * 52) / 12) * (1 - taxRate / 100)) : null,
    missing: rows.filter((r) => r.weekly == null).length,
    taxRate,
  };
}

/** Âge en années pleines à une date (dates ISO, ou année seule pour la naissance). */
export function ageAt(born: string, date: string): number | null {
  const b = /^\d{4}$/.test(born) ? `${born}-01-01` : born.slice(0, 10);
  const by = Number(b.slice(0, 4));
  const dy = Number(date.slice(0, 4));
  if (!by || !dy) return null;
  const before = date.slice(5, 10) < b.slice(5, 10);
  return Math.max(0, dy - by - (before ? 1 : 0));
}

export type SchoolStage = 'baby' | 'nursery' | 'primary' | 'middle' | 'high' | 'adult';

/** Étape de la vie d'un enfant d'après son âge (repères généraux, sans dépendre du pays). */
export function schoolStage(age: number): SchoolStage {
  if (age < 3) return 'baby';
  if (age < 6) return 'nursery';
  if (age < 11) return 'primary';
  if (age < 15) return 'middle';
  if (age < 18) return 'high';
  return 'adult';
}

export type LifeEvent =
  | { kind: 'arrival'; date: string; club: string }
  | { kind: 'exit'; date: string; club: string; reason: CareerSpell['reason'] }
  | { kind: 'trophy'; date: string; club: string; season: string; competition: string | null }
  | { kind: 'partner'; date: string; name: string }
  | { kind: 'birth'; date: string; name: string };

/** Date approximative d'un titre : fin de la saison (« 2026/27 » → 30 juin 2027, « 2027 » → 31 décembre 2027). */
function seasonEnd(season: string, fallback: string): string {
  const two = /^(\d{4})\D+(\d{2,4})$/.exec(season);
  if (two) {
    const y = two[2]!.length === 2 ? `${two[1]!.slice(0, 2)}${two[2]}` : two[2]!;
    return `${y}-06-30`;
  }
  const one = /^(\d{4})$/.exec(season);
  return one ? `${one[1]}-12-31` : fallback.slice(0, 10);
}

/**
 * Journal de vie : arrivées, départs et titres tirés de la partie, plus les dates du foyer saisies par le joueur
 * (rencontre, naissances) quand elles tombent avant la date de jeu. Du plus récent au plus ancien.
 */
export function lifeEvents(spells: CareerSpell[], life: CoachLife | undefined, gameDate: string | null): LifeEvent[] {
  const out: LifeEvent[] = [];
  for (const s of spells) {
    out.push({ kind: 'arrival', date: s.start.slice(0, 10), club: s.club });
    for (const tr of s.trophies) {
      const d = seasonEnd(tr.season, s.end);
      out.push({ kind: 'trophy', date: d < s.end.slice(0, 10) ? d : s.end.slice(0, 10), club: s.club, season: tr.season, competition: tr.competition });
    }
    if (!s.current) out.push({ kind: 'exit', date: s.end.slice(0, 10), club: s.club, reason: s.reason });
  }
  const norm = (d: string) => (/^\d{4}$/.test(d) ? `${d}-01-01` : d.slice(0, 10));
  const start = spells[0]?.start.slice(0, 10) ?? null;
  const inRange = (d: string) => (!gameDate || d <= gameDate.slice(0, 10)) && (!start || d >= start);
  if (life?.partner?.name && life.partner.since && inRange(norm(life.partner.since))) out.push({ kind: 'partner', date: norm(life.partner.since), name: life.partner.name });
  for (const c of life?.children ?? []) if (c.name && c.born && inRange(norm(c.born))) out.push({ kind: 'birth', date: norm(c.born), name: c.name });
  const order: Record<LifeEvent['kind'], number> = { exit: 0, trophy: 1, partner: 2, birth: 3, arrival: 4 };
  return out.sort((a, b) => (a.date === b.date ? order[a.kind] - order[b.kind] : a.date < b.date ? 1 : -1));
}

/** Vitrine : titres regroupés par compétition (le championnat sous `null`), avec les saisons et clubs. */
export function trophyCabinet(spells: CareerSpell[]) {
  const map = new Map<string, { competition: string | null; wins: { season: string; club: string }[] }>();
  for (const s of spells)
    for (const tr of s.trophies) {
      const key = tr.competition ?? '';
      const e = map.get(key) ?? { competition: tr.competition, wins: [] };
      e.wins.push({ season: tr.season, club: s.club });
      map.set(key, e);
    }
  return [...map.values()].sort((a, b) => b.wins.length - a.wins.length || (a.competition === null ? -1 : b.competition === null ? 1 : 0));
}
