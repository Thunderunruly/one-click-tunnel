
import io, re
p = r'D:\Program\public-tunnel\.github\workflows\fyne-poc.yml'
s = io.open(p, encoding='utf-8').read()
s = s.replace('gh release view poc-fyne', 'gh release view poc-fyne --repo "$GITHUB_REPOSITORY"')
s = s.replace('gh release create poc-fyne', 'gh release create poc-fyne --repo "$GITHUB_REPOSITORY"')
s = s.replace('gh release upload poc-fyne', 'gh release upload poc-fyne --repo "$GITHUB_REPOSITORY"')
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
for i, l in enumerate(s.splitlines(), 1):
    if 'gh release' in l:
        print(i, l.strip())
print('--- ci.yml on:')
c = io.open(r'D:\Program\public-tunnel\.github\workflows\ci.yml', encoding='utf-8').read()
print(c[:c.find('jobs:')])
