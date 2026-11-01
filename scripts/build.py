"""Rebuild the standalone installer and three-file release using Python stdlib."""
from pathlib import Path
import base64, hashlib, json, zipfile

ROOT=Path(__file__).resolve().parent.parent
template=(ROOT/'src'/'Install.template.ps1').read_text(encoding='utf-8')
for token,name in [('CORE','retry-core.cjs'),('PRELOAD','retry-preload.cjs'),('LAUNCHER','Start-Claude-Unlimited.ps1')]:
    template=template.replace('@@'+token+'_BASE64@@',base64.b64encode((ROOT/'src'/name).read_bytes()).decode('ascii'))
(ROOT/'Install.ps1').write_text(template,encoding='utf-8',newline='\n')
dist=ROOT/'dist';dist.mkdir(exist_ok=True)
archive=dist/'cc-unlimitconnect-v1.0.0.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as bundle:
    for name in ['Install.cmd','Install.ps1','README.md']:
        info=zipfile.ZipInfo('cc-unlimitconnect/'+name,(2026,11,1,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        info.external_attr=0o644 << 16
        bundle.writestr(info,(ROOT/name).read_bytes())
checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
(dist/'SHA256SUMS.txt').write_text(checksum+'  '+archive.name+'\n',encoding='ascii',newline='\n')
print(json.dumps({'archive':str(archive),'sha256':checksum,'files':3}))
