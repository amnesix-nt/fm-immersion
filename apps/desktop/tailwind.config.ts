import type { Config } from 'tailwindcss';

/**
 * Palette FM Immersion : bleu nuit et ambre, les couleurs du maillot du logo (voir CLAUDE.md, « Identité visuelle »).
 * Les noms des jetons viennent de Simloom et sont gardés pour ne pas réécrire tous les écrans :
 * `canard` = bleu nuit (texte, fonds sombres), `orange` = ambre de marque (boutons, sélection ; `orange-fonce` = liens
 * et textes de marque sur fond clair),
 * `eau` = vert des états « bon / OK », `ambre` = alerte, `corail` = erreur, `creme` = fond, `brun` = texte secondaire.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canard: { DEFAULT: '#0F1B2D', dark: '#08101E' },
        orange: { DEFAULT: '#FFB547', fonce: '#8F5400', clair: '#FFEBC7' },
        eau: { DEFAULT: '#7FD3A0', soutenu: '#2E9E5B', fonce: '#1E7A45' },
        ambre: '#F5B700',
        corail: '#D93C3C',
        creme: '#F2F2F0',
        brun: '#56607A',
      },
      // Petit texte (aides, pastilles, en-têtes de tableaux) à 13 px au lieu de 12 : plus lisible sur un écran de PC.
      fontSize: {
        xs: ['0.8125rem', { lineHeight: '1.125rem' }],
      },
      fontFamily: {
        display: ['"Fraunces Variable"', 'Georgia', 'serif'],
        sans: ['"Nunito Variable"', 'system-ui', 'sans-serif'],
        // Titres « tableau de bord » (préparation du match) : la police du logo, condensée (OFL).
        cond: ['"Barlow Condensed"', '"Arial Narrow"', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
