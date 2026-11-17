# Outil de développement, lecture seule : cherche dans game_plugin.dll (chemin en argument) les motifs de
# fm_memory.rs et la vtable TRIAL_CONTRACT, pour ajouter une nouvelle version de FM27 à `Globals`.
# Usage : python scan-module.py "...\\fm_Data\\Plugins\\x86_64\\game_plugin.dll"
import re, struct, sys
path = sys.argv[1]
d = open(path, 'rb').read()
pe = struct.unpack_from('<I', d, 0x3C)[0]
n = struct.unpack_from('<H', d, pe + 6)[0]; opt = struct.unpack_from('<H', d, pe + 20)[0]
base = struct.unpack_from('<Q', d, pe + 24 + 24)[0]
secs = []
for i in range(n):
    s = pe + 24 + opt + i * 40
    name = d[s:s+8].rstrip(b'\0').decode(errors='replace'); va, rs, rp = struct.unpack_from('<III', d, s + 12)[0], *struct.unpack_from('<II', d, s + 16)
    secs.append((name, va, rs, rp))
print('taille', len(d), 'imagebase', hex(base), [(s[0], hex(s[1])) for s in secs])
def off2rva(o):
    for nm, va, rs, rp in secs:
        if rp <= o < rp + rs: return va + o - rp
def rva2off(r):
    for nm, va, rs, rp in secs:
        if va <= r < va + rs: return rp + r - va
def pat(p):
    return re.compile(b''.join(b'.' if t == '??' else re.escape(bytes([int(t, 16)])) for t in p.split()), re.S)
SIGS = {
 'base': ("48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ?? C7 44 24 5C 00 ?? 00 1B", 3, 0),
 'base_court': ("48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ?? C7 44 24 5C", 3, 0),
 'personnes': ("48 8B 05 ?? ?? ?? ?? 48 8B 80 80 00 00 00 48 8B 48 08 48 3B 08 0F 85 ?? ?? ?? ??", 3, 0x68),
 'personnes_court': ("48 8B 05 ?? ?? ?? ?? 48 8B 80 80 00 00 00 48 8B 48 08 48 3B 08", 3, 0x68),
 'managers': ("4C 8B 25 ?? ?? ?? ?? 49 8B 44 24 18 49 8B 54 24 20 48 39 C2", 3, 0),
 'managers_court': ("4C 8B 25 ?? ?? ?? ?? 49 8B 44 24 18 49 8B 54 24 20", 3, 0),
 'date': ("48 8D 15 ?? ?? ?? ?? 49 0F 42 D0 0F B7 42 02", 3, 0),
 'date_court': ("48 8D 15 ?? ?? ?? ?? 49 0F 42 D0", 3, 0),
}
for k, (p, disp, minus) in SIGS.items():
    hits = []
    for m in pat(p).finditer(d):
        o = m.start(); r = off2rva(o)
        if r is None: continue
        t = r + disp + 4 + struct.unpack_from('<i', d, o + disp)[0] - minus
        hits.append((hex(r), hex(t), d[o:o+28].hex(' ')))
    tg = sorted({h[1] for h in hits})
    print(f'{k}: {len(hits)} occurrence(s), cibles {tg[:12]}')
    for h in hits[:6]: print('   ', h)
# RTTI TRIAL_CONTRACT
name = b'.?AVTRIAL_CONTRACT@db@@\0'
i = d.find(name)
print('TRIAL_CONTRACT nom a', hex(i))
if i >= 0:
    td = off2rva(i - 16)
    cols = [m.start() for m in re.finditer(re.escape(struct.pack('<I', td)), d)]
    for c in cols:
        co = c - 12
        sig, offs = struct.unpack_from('<Ii', d, co)
        if sig != 1: continue
        col_rva = off2rva(co)
        for m in re.finditer(re.escape(struct.pack('<Q', base + col_rva)), d):
            print('   COL', hex(col_rva), 'decalage', offs, 'vtable RVA', hex(off2rva(m.start()) + 8))
