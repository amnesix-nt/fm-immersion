import { describe, expect, it } from 'vitest';
import { CLUB_PAGES, MAIN_TABS, moreTabs, TABS } from '../src/lib/club-nav';

describe('onglets des écrans du club', () => {
  it('garde au plus quatre onglets visibles et range chaque partie une seule fois', () => {
    for (const page of CLUB_PAGES) {
      const all = TABS[page].flat();
      const main = MAIN_TABS[page];
      const more = moreTabs(page);
      // Quatre pastilles au plus : les onglets visibles, plus « Plus » s'il y a d'autres parties.
      expect(main.length + (more.length ? 1 : 0)).toBeLessThanOrEqual(4);
      for (const v of main) expect(all).toContain(v);
      expect([...main, ...more].sort()).toEqual([...all].sort());
    }
  });
});
