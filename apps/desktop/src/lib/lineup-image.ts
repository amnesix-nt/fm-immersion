import type { LineupCard } from '@fm-immersion/module-fm';
import type { TFunction } from 'i18next';
import { clubArt, drawCrest, type ClubArt } from './club-look';
import { wrap } from './gazette-une';

/**
 * Carte « compo d'avant-match » en paysage (1200 × 600, comme le tableau du direct) : à gauche le bandeau ambre
 * (match, schéma, coach), au centre le onze sur le terrain avec la photo de chaque joueur (pack de visages ou portrait
 * photoréaliste, initiales sinon), à droite le rapport du jeu sur l'adversaire. Dessinée à `scale` × pour rester
 * nette en plein écran dans FM27.
 */
const W = 1200;
const H = 600;
const C = {
  bg: '#0F1B2D',
  panel: '#1A2940',
  ink: '#FFFFFF',
  soft: '#B9BCC2',
  faint: '#7D8597',
  amber: '#FFB547',
  pitchA: '#17304F',
  pitchB: '#1A3658',
  line: 'rgba(255,255,255,0.22)',
  face: '#30343A',
  watch: '#E8652B',
};
const SERIF = '"Fraunces Variable", Georgia, serif';
const SANS = '"Nunito Variable", system-ui, sans-serif';
const font = (weight: number, size: number, family = SANS) => `${weight} ${size}px ${family}`;

export interface LineupImages {
  /** Photo de chaque titulaire, par identifiant FM. */
  faces: Map<string, CanvasImageSource | null>;
  coach: CanvasImageSource | null;
  club?: ClubArt | null;
  opponent?: ClubArt | null;
}

function spaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number) {
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${spacing}px`;
  ctx.fillText(text, x, y);
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
}

function photo(ctx: CanvasRenderingContext2D, img: CanvasImageSource | null | undefined, cx: number, cy: number, r: number, initials: string, ring: string) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = C.face;
  ctx.fill();
  ctx.clip();
  if (img) {
    const w = Number((img as { width?: number }).width) || 1;
    const h = Number((img as { height?: number }).height) || 1;
    const side = Math.min(w, h);
    ctx.drawImage(img, (w - side) / 2, 0, side, side, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = C.amber;
    ctx.font = font(900, Math.round(r * 0.75), SERIF);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, cx, cy + 1);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = ring;
  ctx.stroke();
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(-2)
    .join('')
    .toLocaleUpperCase();

/** Étiquette ambre sous la photo : numéro dans un carré bleu nuit, puis le nom. */
function tag(ctx: CanvasRenderingContext2D, cx: number, y: number, number: number | null, name: string) {
  ctx.font = font(900, 13);
  const num = number != null ? String(number) : '';
  const nw = num ? ctx.measureText(num).width + 8 : 0;
  ctx.font = font(900, 14);
  const tw = ctx.measureText(name).width;
  const w = tw + nw + (num ? 18 : 14);
  const x = cx - w / 2;
  ctx.fillStyle = C.amber;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 22, 6);
  ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  if (num) {
    ctx.fillStyle = C.bg;
    ctx.beginPath();
    ctx.roundRect(x + 5, y + 3, nw, 16, 4);
    ctx.fill();
    ctx.font = font(900, 13);
    ctx.fillStyle = C.amber;
    ctx.fillText(num, x + 9, y + 11.5);
  }
  ctx.font = font(900, 14);
  ctx.fillStyle = C.bg;
  ctx.fillText(name, x + (num ? nw + 11 : 7), y + 11.5);
  ctx.textBaseline = 'alphabetic';
}

function card(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string) {
  ctx.fillStyle = C.panel;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 14);
  ctx.fill();
  ctx.fillStyle = C.amber;
  ctx.font = font(900, 12);
  ctx.textAlign = 'left';
  spaced(ctx, title, x + 18, y + 28, 1.6);
}

export async function drawLineupCard(t: TFunction, c: LineupCard, images: LineupImages, opts: { scale?: number; lang?: string } = {}): Promise<HTMLCanvasElement> {
  const scale = opts.scale ?? 2;
  const [clubA, oppA] = await Promise.all([images.club !== undefined ? images.club : clubArt(c.club), images.opponent !== undefined ? images.opponent : clubArt(c.opponent)]);
  await Promise.all([font(800, 38, SERIF), font(800, 19, SERIF), font(900, 14), font(800, 15), font(700, 15)].map((f) => document.fonts.load(f).catch(() => undefined)));
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  // Liseré du haut aux couleurs des deux équipes (ambre si le jeu ne les donne pas).
  const color = (a: ClubArt | null, fallback: string) => a?.look?.colors?.[0] ?? fallback;
  ctx.fillStyle = color(clubA, C.amber);
  ctx.fillRect(0, 0, W / 2, 6);
  ctx.fillStyle = color(oppA, C.watch);
  ctx.fillRect(W / 2, 0, W / 2, 6);

  // ---- bandeau ambre : match, schéma, coach ----
  const LW = 300;
  ctx.fillStyle = C.amber;
  ctx.fillRect(0, 6, LW, H - 6);
  ctx.fillStyle = C.bg;
  ctx.textAlign = 'left';
  ctx.font = font(900, 12);
  spaced(ctx, t('live.lineupCard.kicker'), 28, 44, 1.2);
  ctx.font = font(800, 38, SERIF);
  t('live.lineupCard.title')
    .split('\n')
    .forEach((line, i) => ctx.fillText(line, 26, 88 + i * 40));
  let y = 128 + 40;
  if (clubA) drawCrest(ctx, clubA, 56, y + 6, 58, { ring: C.bg });
  ctx.font = font(800, 18, SERIF);
  ctx.textAlign = 'center';
  ctx.fillText(t('live.lineupCard.against'), 128, y + 12);
  if (oppA) drawCrest(ctx, oppA, 200, y + 6, 58, { ring: C.bg });
  ctx.textAlign = 'left';
  y += 60;
  ctx.font = font(800, 19, SERIF);
  const teams = wrap(ctx, `${c.club} – ${c.opponent}`, LW - 52, 3);
  teams.forEach((line, i) => ctx.fillText(line, 26, y + i * 23));
  y += teams.length * 23 + 2;
  ctx.font = font(800, 14);
  ctx.fillStyle = '#3A2A10';
  const date = new Intl.DateTimeFormat(opts.lang, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${c.gameDate}T00:00:00Z`));
  const meta = [c.competition, c.home == null ? null : t(c.home ? 'live.lineupCard.home' : 'live.lineupCard.away'), date].filter(Boolean).join(' · ');
  const metaLines = wrap(ctx, meta, LW - 52, 2);
  metaLines.forEach((line, i) => ctx.fillText(line, 26, y + i * 18));
  y += metaLines.length * 18 + 14;
  if (c.formation) {
    ctx.fillStyle = C.bg;
    ctx.beginPath();
    ctx.roundRect(24, y, LW - 48, 50, 10);
    ctx.fill();
    ctx.fillStyle = C.amber;
    ctx.font = font(800, 30, SERIF);
    ctx.fillText(c.formation, 38, y + 36);
    if (c.mentality) {
      ctx.fillStyle = C.ink;
      ctx.font = font(900, 12);
      ctx.textAlign = 'right';
      spaced(ctx, c.mentality.toLocaleUpperCase(), LW - 38, y + 32, 1.2);
      ctx.textAlign = 'left';
    }
  }
  if (c.coach) {
    ctx.strokeStyle = 'rgba(15,27,45,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(26, H - 92);
    ctx.lineTo(LW - 26, H - 92);
    ctx.stroke();
    photo(ctx, images.coach, 56, H - 50, 28, initialsOf(c.coach), C.bg);
    ctx.fillStyle = C.bg;
    ctx.font = font(900, 11);
    spaced(ctx, t('live.lineupCard.coach'), 96, H - 56, 1.3);
    ctx.font = font(800, 19, SERIF);
    ctx.fillText(wrap(ctx, c.coach, LW - 120, 1)[0]!, 96, H - 34);
  }

  // ---- terrain ----
  const PX = 322;
  const PY = 24;
  const PW = 540;
  const PH = 552;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(PX, PY, PW, PH, 14);
  ctx.clip();
  for (let i = 0; i * 46 < PH; i++) {
    ctx.fillStyle = i % 2 ? C.pitchB : C.pitchA;
    ctx.fillRect(PX, PY + i * 46, PW, 46);
  }
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  const m = 14;
  ctx.strokeRect(PX + m, PY + m, PW - 2 * m, PH - 2 * m);
  ctx.beginPath();
  ctx.moveTo(PX + m, PY + PH / 2);
  ctx.lineTo(PX + PW - m, PY + PH / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(PX + PW / 2, PY + PH / 2, 52, 0, Math.PI * 2);
  ctx.stroke();
  for (const top of [true, false]) {
    const by = top ? PY + m : PY + PH - m - 100;
    ctx.strokeRect(PX + 150, by, 240, 100);
    ctx.strokeRect(PX + 215, top ? PY + m : PY + PH - m - 38, 110, 38);
  }
  ctx.restore();
  const R = 30;
  for (const p of c.players) {
    const cx = PX + 40 + ((PW - 80) * p.x) / 100;
    const cy = PY + 40 + ((PH - 92) * p.y) / 100;
    photo(ctx, p.id ? images.faces.get(p.id) : null, cx, cy, R, initialsOf(p.name), C.amber);
    tag(ctx, cx, cy + R - 6, p.number, p.short);
  }

  // ---- rapport sur l'adversaire ----
  const RX = 884;
  const RW = 292;
  let ry = 24;
  if (c.opp) {
    const rows = (
      [
        ['position', c.opp.position],
        ['manager', c.opp.manager],
        ['formation', c.opp.formation],
        ['mentality', c.opp.mentality],
      ] as const
    ).filter(([, v]) => !!v);
    const h = 52 + rows.length * 30;
    card(ctx, RX, ry, RW, h, t('live.lineupCard.opponent'));
    rows.forEach(([k, v], i) => {
      const yy = ry + 64 + i * 30;
      ctx.font = font(700, 15);
      ctx.fillStyle = C.soft;
      ctx.textAlign = 'left';
      ctx.fillText(t(`live.lineupCard.${k}`), RX + 18, yy);
      ctx.font = font(900, 15);
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'right';
      ctx.fillText(wrap(ctx, v!, RW - 130, 1)[0]!, RX + RW - 18, yy);
      if (i < rows.length - 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(RX + 18, yy + 10, RW - 36, 1);
      }
    });
    ry += h + 14;
  }
  if (c.watch.length) {
    const h = 48 + c.watch.length * 34;
    card(ctx, RX, ry, RW, h, t('live.lineupCard.watch'));
    c.watch.forEach((name, i) => {
      const yy = ry + 62 + i * 34;
      ctx.fillStyle = C.watch;
      ctx.beginPath();
      ctx.arc(RX + 30, yy - 5, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111111';
      ctx.font = font(900, 12);
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), RX + 30, yy - 1);
      ctx.fillStyle = C.ink;
      ctx.font = font(800, 15);
      ctx.textAlign = 'left';
      ctx.fillText(wrap(ctx, name, RW - 70, 1)[0]!, RX + 52, yy);
    });
    ry += h + 14;
  }
  if (c.threat) {
    ctx.font = font(400, 15, SERIF);
    const lines = wrap(ctx, `« ${c.threat} »`, RW - 36, 4);
    const h = 48 + lines.length * 21;
    if (ry + h <= H - 60) {
      card(ctx, RX, ry, RW, h, t('live.lineupCard.assistant'));
      ctx.font = `italic ${font(400, 15, SERIF)}`;
      ctx.fillStyle = '#E6E3DA';
      ctx.textAlign = 'left';
      lines.forEach((line, i) => ctx.fillText(line, RX + 18, ry + 56 + i * 21));
    }
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = C.amber;
  ctx.font = font(800, 15, SERIF);
  ctx.fillText(t('live.lineupCard.brand'), RX + RW, H - 32);
  ctx.fillStyle = C.faint;
  ctx.font = font(700, 10);
  ctx.fillText(t('live.lineupCard.disclaimer'), RX + RW, H - 14);
  return canvas;
}
