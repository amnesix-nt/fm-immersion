/**
 * Postes du jeu (« D (DGC) », « MO (C) », « DL/M (G) »…) convertis en codes internes.
 * Les libellés sont ceux de la version française du jeu.
 */
export const POS_ORDER = ['GB', 'DD', 'DC', 'DG', 'DLD', 'DLG', 'MDF', 'MD', 'MC', 'MG', 'MOD', 'MOC', 'MOG', 'BT'] as const;
export type PosCode = (typeof POS_ORDER)[number];

export const POS_LABEL: Record<PosCode, string> = {
  GB: 'GB', DD: 'D (D)', DC: 'D (C)', DG: 'D (G)', DLD: 'DL (D)', DLG: 'DL (G)', MDF: 'MD (C)',
  MD: 'M (D)', MC: 'M (C)', MG: 'M (G)', MOD: 'MO (D)', MOC: 'MO (C)', MOG: 'MO (G)', BT: 'BT',
};

export type Line = 'GB' | 'DEF' | 'MIL' | 'ATT';

export const lineOf = (p: PosCode): Line =>
  p === 'GB' ? 'GB' : p.startsWith('D') ? 'DEF' : ['MDF', 'MD', 'MC', 'MG'].includes(p) ? 'MIL' : 'ATT';

const isPos = (c: string): c is PosCode => (POS_ORDER as readonly string[]).includes(c);

function codeFor(base: string, side: string): PosCode | null {
  switch (base) {
    case 'GB':
    case 'BT':
      return base;
    case 'D':
      return ({ C: 'DC', G: 'DG', D: 'DD' } as const)[side as 'C'] ?? null;
    // « AL » (arrière latéral) dans FM27 en français, « DL » dans les versions précédentes : le même poste de piston.
    case 'DL':
    case 'AL':
      return ({ G: 'DLG', D: 'DLD' } as Record<string, PosCode>)[side] ?? null;
    case 'MD':
      return 'MDF';
    case 'M':
      return ({ C: 'MC', G: 'MG', D: 'MD' } as const)[side as 'C'] ?? null;
    case 'MO':
      return ({ C: 'MOC', G: 'MOG', D: 'MOD' } as const)[side as 'C'] ?? null;
    default:
      return isPos(base) ? base : null;
  }
}

export function parsePositions(raw: string | string[] | null | undefined): PosCode[] {
  const text = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
  const out = new Set<PosCode>();
  for (const chunk of text.split(/,(?![^()]*\))/)) {
    const c = chunk.trim();
    const m = c.match(/^([A-Z/]+)(?:\s*\(([GCD]+)\))?$/);
    if (!m) {
      if (isPos(c)) out.add(c);
      continue;
    }
    const bases = m[1]!.split('/');
    const sides = m[2] ?? 'C';
    for (const base of bases) for (const s of sides) {
      const code = codeFor(base, s);
      if (code) out.add(code);
    }
  }
  return [...out].sort((a, b) => POS_ORDER.indexOf(a) - POS_ORDER.indexOf(b));
}
