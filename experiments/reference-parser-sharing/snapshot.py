from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parents[2]
sansa=root.parents[1]/'sansa/reference-path-only'
broader=root.parent/'reference-parser-sharing'
entries={}
for label,base in [('aeon',root/'implementations/typescript/packages'),('sansa',sansa/'src'),('broader',broader/'implementations/typescript/packages'),('broader-sansa',root.parents[1]/'sansa/reference-parser-sharing/src'),('baseline',Path(__file__).parent/'.baseline/packages')]:
 for p in sorted(base.rglob('*')):
  if p.is_file() and 'node_modules' not in p.relative_to(base).parts and p.suffix in ['.ts','.js','.json']:
   entries[label+'/'+str(p.relative_to(base))]=hashlib.sha256(p.read_bytes()).hexdigest()
Path(__file__).with_name(sys.argv[1]).write_text(json.dumps(entries,indent=2)+'\n')
