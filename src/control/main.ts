import {spawn} from 'node:child_process';
import {parseControlArgs,startControlPanel,browserLaunch} from './server.js';
const help=`Jev 本地控制面板\n\nUsage: npm run control -- [--runtime DIR] [--config FILE] [--port PORT] [--open]\n\n仅绑定 127.0.0.1；默认端口 47831（--port 0 自动分配）。\n默认使用现有运行目录；--config 仅固定传给 CLI 启动命令。\n打开输出的含 # 令牌网址。面板启动不会启动服务或执行目标。\n关闭面板不会停止服务；在面板中点击停止服务或使用 CLI 停止。\n实际网页、通用动作选择和已配置 MCP 主机能力以服务 health 为准。\n`;
async function main(){
 const options=parseControlArgs(process.argv.slice(2));if(options.help){process.stdout.write(help);return;}
 const panel=await startControlPanel(options);process.stdout.write(`Jev 本地控制面板：${panel.url}\n关闭面板不会停止协调服务。请妥善保管此本地访问链接。\n`);
 if(options.open){try{const command=browserLaunch(process.platform,panel.url);const child=spawn(command.file,command.args,{shell:false,stdio:'ignore'});child.once('error',()=>process.stderr.write('CONTROL_BROWSER_OPEN_FAILED\n'));child.once('exit',code=>{if(code!==0)process.stderr.write('CONTROL_BROWSER_OPEN_FAILED\n');});}catch{process.stderr.write('CONTROL_BROWSER_OPEN_UNSUPPORTED\n');}}
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void panel.close().catch(()=>{process.exitCode=1;});});
}
void main().catch(error=>{process.stderr.write(error instanceof Error&&error.message==='INVALID_ARGUMENTS'?'INVALID_ARGUMENTS\n':'CONTROL_START_FAILED\n');process.exitCode=1;});
