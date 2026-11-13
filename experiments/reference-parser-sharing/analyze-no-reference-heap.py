# Diagnostic graph accounting; excludes prototype/metadata edges, not a retained-size oracle.
from pathlib import Path
import collections,json,sys
p=Path(__file__).resolve().parent/'.results'
for variant in ['baseline','candidate']:
 d=json.loads((p/f'no-reference-before-{variant}.heapsnapshot').read_text());meta=d['snapshot']['meta'];nf=meta['node_fields'];ef=meta['edge_fields'];w=len(nf);ew=len(ef);nodes=d['nodes'];edges=d['edges'];strings=d['strings'];types=meta['node_types'][0];etypes=meta['edge_types'][0];offsets={};offset=0;root=None
 for i in range(0,len(nodes),w):
  offsets[i]=offset
  for j in range(offset,offset+nodes[i+nf.index('edge_count')]*ew,ew):
   if etypes[edges[j]]=='property' and strings[edges[j+1]]=='retained':root=edges[j+2]
  offset+=nodes[i+nf.index('edge_count')]*ew
 assert root is not None
 todo=[root];seen=set();sizes=collections.Counter();counts=collections.Counter()
 while todo:
  i=todo.pop()
  if i in seen:continue
  seen.add(i);t=types[nodes[i]];name=strings[nodes[i+1]];k=(t,name if t!='string' else '(string)',nodes[i+nf.index('self_size')]);sizes[k]+=k[2];counts[k]+=1
  start=offsets[i]
  for j in range(start,start+nodes[i+nf.index('edge_count')]*ew,ew):
   typ=etypes[edges[j]];key=edges[j+1];dest=edges[j+2]
   if typ=='element' or typ=='property' and strings[key]!='__proto__' or typ=='internal' and strings[key]in['elements','properties','first','second','parent']:
    if types[nodes[dest]] in ['object','array','string','concatenated string','sliced string']:todo.append(dest)
 print(variant,'graph data self bytes',sum(sizes.values()),'nodes',len(seen))
 for k,v in sizes.most_common(12):print(counts[k],k,v)
