#!/usr/bin/env python3
"""
Parse Russ Rowlett's Lighthouse Directory (UNC Chapel Hill, ibiblio.org/lighthouse)
India pages into build/rowlett.json. Used to cross-check active/inactive status
(the directory is revised continuously) and to fill tower descriptions.
"""
import re,html,json,os
HERE=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW=os.path.join(HERE,'raw','rowlett')
PAGES={'ingjw':'Gujarat','ingje':'Gujarat','ingjs':'Gujarat','inmh':'Maharashtra','inga':'Goa','inka':'Karnataka','inkl':'Kerala','inld':'Lakshadweep','intn':'Tamil Nadu','inap':'Andhra Pradesh','inod':'Odisha','inwb':'West Bengal','inan':'Andaman and Nicobar Islands'}
def clean(x): return html.unescape(re.sub(r'\s+',' ',re.sub(r'<[^>]+>','',x))).strip()
out=[]
for p,st in PAGES.items():
    s=re.sub(r'<!--.*?-->','',open(os.path.join(RAW,p+'.htm'),errors='ignore').read(),flags=re.S)
    for m in re.finditer(r'<dt>((?:(?!<dt>).)*?)</dt>\s*<dd>(.*?)(?=<dt>|</dl>)',s,flags=re.S|re.I):
        dt,dd=m.group(1),m.group(2)
        # the entry name is the last bold/anchor chunk of the dt
        bs=re.findall(r'<b>(.*?)</b>',dt,flags=re.S|re.I) or [dt]
        name=clean(bs[-1]).replace('*','').strip()
        name=re.sub(r'\s*\(\d\)$','',name)
        text=clean(dd)
        sm=re.search(r'\b(Active|Inactive|Destroyed|Demolished|Deactivated|Discontinued)\b',text[:300])
        if not sm: continue
        g=lambda r: (re.search(r,text,flags=re.I) or [None,None])[1]
        rec=dict(src=p,state=st,name=name,status=sm.group(1),
          year=g(r'^(\d{4}|Date unknown)'),
          focal_m=g(r'focal plane (\d+(?:\.\d+)?) m'),
          light=g(r'focal plane [^;]*?;\s*([^.]+(?:\.\d[^.]*)?)\.'),
          tower=g(r'\.\s*(\d+(?:\.\d+)? m \([^)]*\)[^.]*)\.'),
          colors=g(r'((?:Lighthouse|Tower|Building|Lantern)[^.]*?(?:painted|unpainted|white|red|black|yellow)[^.]*)\.'),
          arlhs=g(r'ARLHS ([A-Z]{3}-\d+)'),adm=g(r'Admiralty ([A-Z]\s?\d+(?:\.\d+)?)'),nga=g(r'NGA (\d+(?:\.\d+)?)'),
          visit=g(r'(Site [^.]*\.)'),
          stars=clean(dt).count('*'),
          coords=(re.findall(r'[?&](?:ll|q)=(-?\d+\.\d+),\s*(-?\d+\.\d+)',dd) or re.findall(r'@(-?\d+\.\d+),(-?\d+\.\d+)',dd))[:1],
          photo=(re.findall(r'<a href="(https?://[^"]*(?:wikimedia|flickr|lightphotos)[^"]*)"',dd) or [None])[0],
          text=text)
        out.append(rec)
json.dump(out,open(os.path.join(HERE,'build','rowlett.json'),'w'),indent=1,ensure_ascii=False)
from collections import Counter
print(len(out),Counter(o['status'] for o in out))
print('inactive:',[o['name'] for o in out if o['status']!='Active'])
