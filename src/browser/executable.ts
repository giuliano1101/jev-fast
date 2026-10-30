import {chromium} from 'playwright';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
/** Shared resolution for execution and read-only diagnostics. */
export function chromiumExecutable(explicit?:string):string {
 const cached=homedir()+'/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
 return explicit??process.env.JEV_CHROMIUM_PATH??(existsSync(chromium.executablePath())?chromium.executablePath():existsSync(cached)?cached:chromium.executablePath());
}
