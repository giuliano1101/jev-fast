"""Official SDK transport adapter. No MCP server, environment key, or plaintext credential."""
import json,sys,os
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent/'src'))
from jev_desktop.broker import Broker,BrokerConfig

if __name__=='__main__':
 RUN_DIR=Path(sys.argv[1]).resolve()
 os.environ['JEV_DESKTOP_PIPE']=r'\\.\pipe\JevOfficialWindowsBroker'
 # Jev decisions happen in the persistent Node loop, through the budgeted official SDK.
 # This process exposes native observation/input only; it never receives an API key.
 config=BrokerConfig(home=RUN_DIR/'desktop-broker')
 Broker(config).serve_forever()
