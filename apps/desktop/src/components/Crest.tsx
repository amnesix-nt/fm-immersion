import { crestLetters, inkOn } from '@fm-immersion/module-fm';
import { useQuery } from '@tanstack/react-query';
import { clubLogoUrl, clubLook } from '../lib/club-look';

/** Écusson du club : son logo (pack de logos du joueur, lu sur son PC), sinon un rond à ses couleurs avec son sigle. */
export function Crest({ club, size = 40 }: { club: string; size?: number }) {
  const { data: logo } = useQuery({ queryKey: ['clubLogo', club], queryFn: () => clubLogoUrl(club), staleTime: Infinity });
  const look = clubLook(club);
  if (logo) return <img src={logo} alt="" width={size} height={size} className="shrink-0 object-contain" />;
  const bg = look?.colors[0] ?? '#0F1B2D';
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-extrabold ${crestLetters(club, look?.abbr).length > 3 ? 'text-[10px]' : 'text-xs'}`}
      style={{ width: size, height: size, background: bg, color: inkOn(bg), boxShadow: `inset 0 0 0 3px ${look?.colors[1] ?? '#FFB547'}` }}
      aria-hidden
    >
      {crestLetters(club, look?.abbr)}
    </span>
  );
}
