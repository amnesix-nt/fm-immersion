import { describe, expect, it } from 'vitest';
import { buildTrainingWeek, FM27_SESSION_CODE, fm27ScheduleDays, fm27ScheduleName, SESSIONS, type SessionId } from '../src';

const VALID = (c: number) => (c >= 0 && c <= 7) || (c >= 100 && c <= 108) || (c >= 200 && c <= 203) || (c >= 300 && c <= 304) || c === 400 || c === 401 || c === 500;

describe('programme d’équipe pour FM27', () => {
  it('chaque séance de l’appli a un code que FM27 affiche', () => {
    for (const s of Object.keys(SESSIONS) as SessionId[]) expect(VALID(FM27_SESSION_CODE[s]), s).toBe(true);
  });

  it('7 jours de 3 créneaux, match au milieu, repos pour les créneaux vides', () => {
    const w = buildTrainingWeek({ monday: '2026-10-05', phase: 'A', week: 1, matchDays: [5] });
    const days = fm27ScheduleDays(w);
    expect(days).toHaveLength(7);
    for (const d of days) expect(d).toHaveLength(3);
    expect(days[5]).toEqual([300, 500, 300]);
    expect(days.flat().every(VALID)).toBe(true);
    const mon = w.days.find((d) => d.weekday === 0)!;
    expect(days[0]).toEqual(mon.sessions.map((s) => (s ? FM27_SESSION_CODE[s] : 300)));
  });

  it('nom du programme : lundi de la semaine', () => {
    expect(fm27ScheduleName('2026-09-28')).toBe('FM Immersion - 28/09');
  });
});
