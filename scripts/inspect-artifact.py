"""Read-only PDF/ZIP parser. Never extract archive members or print document content."""
import json
import pathlib
import sys
import zipfile

target=pathlib.Path(sys.argv[1])
try:
    if target.suffix.lower()=='.pdf':
        try:
            from pypdf import PdfReader
        except ImportError:
            print(json.dumps({'available':False,'valid':False,'code':'PDF_PARSER_UNAVAILABLE'}))
            raise SystemExit(0)
        document=PdfReader(target,strict=True)
        if document.is_encrypted:
            print(json.dumps({'available':True,'valid':False,'code':'PDF_REQUIRES_PASSWORD'}))
        else:
            count=len(document.pages)
            for page in document.pages:
                _=page.mediabox
                contents=page.get_contents()
                if contents is not None:
                    _=contents.get_data()
            print(json.dumps({'available':True,'valid':count>0,'pages':count,'parser':'pypdf'}))
    else:
        with zipfile.ZipFile(target) as archive:
            entries=archive.infolist()
            if len(entries)>10000 or sum(item.file_size for item in entries)>1024*1024*1024:
                print(json.dumps({'available':True,'valid':False,'code':'ARCHIVE_RESOURCE_GUARD'}))
            else:
                bad=archive.testzip()
                print(json.dumps({'available':True,'valid':bad is None,'entries':len(entries),'parser':'zipfile'}))
except Exception:
    print(json.dumps({'available':True,'valid':False,'code':'DOCUMENT_PARSE_FAILED'}))
