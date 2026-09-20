
import io, re
p = r'D:\Program\public-tunnel\.github\workflows\ci.yml'
s = io.open(p, encoding='utf-8').read()
lines = s.split('\n')
out = []
for l in lines:
    m = re.match(r'^(\s*- name: )(.*)$', l)
    if m:
        val = m.group(2)
        if ': ' in val or val.endswith(':'):
            val = "'" + val.replace("'", "''") + "'"
        out.append(m.group(1) + val)
    else:
        out.append(l)
s2 = '\n'.join(out)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s2)
import yaml
d = yaml.safe_load(s2)
print('yaml OK, jobs:', list(d['jobs'].keys()), 'steps:', len(d['jobs']['test']['steps']))
for st in d['jobs']['test']['steps']:
    if 'name' in st: print('  -', st['name'])
