"""Persistent CLI adapter to the native broker; no MCP transport is imported."""
import sys,json,time,base64
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent/'src'))
from jev_desktop.client import BrokerClient
from jev_desktop.drivers.windows import win32
from PIL import Image,ImageDraw
import mss
sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
c=BrokerClient(pipe=r'\\.\pipe\JevOfficialWindowsBroker',autostart=False)
bound=None
def inspect():
 return c.call('inspect',{'app_ref':bound['app_ref'],'scope':{'window_refs':[bound['window_ref']],'max_elements':180,'max_depth':12},'screenshot':False})
def act(s,operation,element=None,**extra):
 a={'operation':operation,'snapshot_id':s['snapshot_id'],'window_ref':bound['window_ref'],**extra}
 if element:a['element_id']=element
 return c.call('act',{'access_token':s['access_token'],'action':a})
def dispatch(d):
 global bound
 if d['op']=='bind':
  discovery=c.call('inspect',{'query':d['title'],'screenshot':False})
  windows=[w for w in discovery['windows'] if w['title']==d['title']]
  if len(windows)!=1:raise ValueError('WINDOW_NOT_UNIQUE')
  bound=windows[0];s=inspect();focus=next((e for e in s['elements'] if 'FOCUS_WINDOW' in e['operations']),None)
  if focus:act(s,'FOCUS_WINDOW',focus['element_id'])
  return inspect()
 if d['op']=='ocr':
  from rapidocr_onnxruntime import RapidOCR
  global ocr
  if 'ocr' not in globals():ocr=RapidOCR(intra_op_num_threads=4,inter_op_num_threads=1)
  lines,_=ocr(d['path']);return [{'text':text,'box':box,'probability':float(p)} for box,text,p in lines or []]
 if not bound:raise ValueError('WINDOW_NOT_BOUND')
 if d['op']=='observe':return inspect()
 if d['op']=='fill_submit':
  result=act(d['snapshot'],'TYPE_TEXT',d['element_id'],text=d['text'])
  fresh=inspect()
  fields=[e for e in fresh['elements'] if e.get('editable') and e.get('value')==d['text']]
  if not fields:raise ValueError('TEXT_NOT_VERIFIED_NO_RETYPE')
  if d.get('submit'):act(fresh,'HOTKEY',hotkey=['enter'])
  return {'typed':True,'submitted':bool(d.get('submit'))}
 if d['op']=='click':return act(d['snapshot'],'CLICK',d['element_id'])
 if d['op']=='screenshot':
  s=inspect();window=next(w for w in s['windows'] if w['window_ref']==bound['window_ref'])
  rect=window['rect'];hwnd=win32.foreground_window()
  if win32.window_title(hwnd)!=bound['title']:raise ValueError('APP_NOT_FOREGROUND')
  region={'left':rect['left'],'top':rect['top'],'width':rect['right']-rect['left'],'height':rect['bottom']-rect['top']}
  with mss.mss() as capture:
   raw=capture.grab(region);image=Image.frombytes('RGB',raw.size,raw.rgb)
  # Mask the account/navigation header. Only public store content is used by image judgments.
  ImageDraw.Draw(image).rectangle((0,0,image.width,180),fill='#17202a')
  image.thumbnail((1568,1568));path=Path(d['path']);path.parent.mkdir(parents=True,exist_ok=True);image.save(path)
  return {'path':str(path),'width':image.width,'height':image.height}
 raise ValueError('UNSUPPORTED_OPERATION')
try:
 for line in sys.stdin:
  try:
   d=json.loads(line);result=dispatch(d);print(json.dumps({'id':d['id'],'result':result},ensure_ascii=False),flush=True)
  except Exception as e:print(json.dumps({'id':d.get('id'),'error':str(e)},ensure_ascii=True),flush=True)
finally:c.close()
