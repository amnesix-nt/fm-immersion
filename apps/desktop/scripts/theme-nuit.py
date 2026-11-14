import re, glob
SRC = __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', 'src')
files=[f for f in glob.glob(SRC+'/**/*.tsx',recursive=True)+glob.glob(SRC+'/**/*.ts',recursive=True)]
rx=re.compile(r'(?<![\w-])((?:(?:hover|focus|focus-visible|group-hover|active|disabled|odd|even|last|first|aria-selected|open|placeholder):)*)(bg|text|border|border-[ltrbxy]|ring|divide|accent|outline|fill|stroke|decoration|from|via|to|shadow)-(white|creme|canard|brun|orange-clair|orange-fonce)(?:/(\d+|\[[\d.]+\]))?(?![\w-])')
found=set()
for f in files:
  for m in rx.finditer(open(f).read()): found.add(m.group(0))
def alpha(a):
  if a is None: return None
  if a.startswith('['): return float(a[1:-1])
  return int(a)/100
def rgba(hexc,a):
  h=hexc.lstrip('#'); r,g,b=int(h[0:2],16),int(h[2:4],16),int(h[4:6],16)
  return f'rgb({r} {g} {b} / {a if a is not None else 1})'
SURF='#16263E'; PAGE='#0C1626'; INK='#E7EBF2'; DEEP='#070F1B'; MUTED='#A7B2C6'
def value(prop,color,a):
  base=prop.split('-')[0]
  if color=='white':
    if base=='bg' and (a is None or a>=0.5): return rgba(SURF,a)
    return None
  if color=='creme':
    if base=='bg': return rgba('#0F1C30',a)
    if base in('border','ring','divide'): return rgba('#FFFFFF',0.08)
    return None
  if color=='canard':
    if base in('text','fill','stroke','decoration','placeholder'): return rgba(INK,a)
    if base=='bg':
      if a is None or a>=0.6: return rgba(DEEP,a)
      return rgba('#FFFFFF',min(1,a*1.4))
    if base in('border','ring','divide','outline'):
      if a is None or a>=0.6: return rgba('#FFFFFF',0.35)
      return rgba('#FFFFFF',min(1,a*1.3))
    if base=='accent': return '#FFB547'
    return None
  if color=='brun':
    if base in('text','fill','stroke'): return rgba(MUTED,a)
    return None
  if color=='orange-clair':
    if base=='bg': return rgba('#3D2C10',a)
    if base in('border','ring'): return rgba('#6B4E1C',a)
    return None
  if color=='orange-fonce':
    if base in('text','fill','stroke','decoration'): return rgba('#FFC266',a)
    if base in('border','ring','outline'): return rgba('#FFB547',a)
    if base=='accent': return '#FFB547'
    return None
PROPS={'bg':'background-color','text':'color','border':'border-color','ring':'--tw-ring-color','divide':'border-color','accent':'accent-color','outline':'outline-color','fill':'fill','stroke':'stroke','decoration':'text-decoration-color','placeholder':'color'}
def esc(c): return re.sub(r'([:/\[\].])',r'\\\1',c)
out=[]
for cls in sorted(found):
  m=rx.fullmatch(cls)
  variants=[v for v in m.group(1).split(':') if v]
  prop=m.group(2); color=m.group(3); a=alpha(m.group(4))
  v=value(prop,color,a)
  if v is None: continue
  base=prop.split('-')[0]
  if base in('from','via','to','shadow'): continue
  css=PROPS[base] if not prop.startswith('border-') else 'border-color'
  sel='.theme-nuit .'+esc(cls)
  pseudo=''
  for vv in variants:
    if vv in('hover','focus','active','disabled','focus-visible'): pseudo+=':'+vv
    elif vv=='odd': pseudo+=':nth-child(odd)'
    elif vv=='even': pseudo+=':nth-child(even)'
    elif vv=='last': pseudo+=':last-child'
    elif vv=='first': pseudo+=':first-child'
    elif vv=='aria-selected': pseudo+='[aria-selected="true"]'
    elif vv=='placeholder': pseudo+='::placeholder'
    elif vv=='group-hover': sel='.theme-nuit .group:hover .'+esc(cls)
    elif vv=='open': pseudo+='[open]'
  if base=='divide': sel+=pseudo+' > :not([hidden]) ~ :not([hidden])'
  else: sel+=pseudo
  out.append(f'{sel}{{{css}:{v}}}')
open(SRC+'/theme-nuit.generated.css','w').write('/* Généré par apps/desktop/scripts/theme-nuit.py : ne pas modifier à la main. */\n'+'\n'.join(out)+'\n')
print(len(found),len(out))
