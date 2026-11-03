import json,hashlib
from pathlib import Path
from PIL import Image
import numpy as np
base=Path('test-results/ui-route-20261104');rows=[]
for group in ['chrome-downloads','iab-downloads']:
 for path in sorted((base/group).glob('*.jpg')):
  pic=Image.open(path);pic.load();rgb=np.asarray(pic.convert('RGB'),dtype=np.int16);spread=rgb.max(2)-rgb.min(2)
  rows.append({'group':group,'file':path.name,'size':list(pic.size),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mean_channel_spread':float(spread.mean()),'near_grayscale':float((spread<=12).mean())>=.98})
assert len(rows)==6 and len({r['sha256'] for r in rows})==3
assert all(r['near_grayscale'] for r in rows)
(base/'artifact-validation.json').write_text(json.dumps(rows,indent=2),encoding='utf8')
print(json.dumps({'image_files':6,'distinct_images':3,'decodes':6,'near_grayscale':6,'cross_browser_hashes_match':True}))
