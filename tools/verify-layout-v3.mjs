import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(project,'package.json'));
const {_electron}=require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp=require(process.env.CLARUNE_SHARP_MODULE || 'sharp');
const work=await mkdtemp(join(tmpdir(),'clarune-layout-v3-')),review=process.env.CLARUNE_REVIEW_DIR || join(project,'UI-review-v3/layout');
await mkdir(review,{recursive:true});
const fixture=join(work,'澄像 · 长文件名 示例图片 🧊 0123456789.png');
await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640"><defs><linearGradient id="g"><stop stop-color="#386bae"/><stop offset="1" stop-color="#8bdbcb"/></linearGradient></defs><rect width="960" height="640" fill="url(#g)"/><circle cx="680" cy="220" r="150" fill="#eaf9ff"/><rect x="90" y="420" width="650" height="100" rx="28" fill="#143254"/><text x="135" y="483" fill="white" font-size="40">CLARUNE - QA IMAGE</text></svg>')).png().toFile(fixture);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const exe=process.env.CLARUNE_PREVIEW_EXE||require('electron');
const app=await _electron.launch({executablePath:exe,args:[...(process.env.CLARUNE_PREVIEW_EXE?[]:[project]),`--user-data-dir=${join(work,'profile')}`],env});
const page=await app.firstWindow();page.setDefaultTimeout(15000);await page.emulateMedia({reducedMotion:'reduce'});
await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
const checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.getByTestId('nav-settings').waitFor();
 for(const lang of ['zh-CN','en-US'])for(const theme of ['light','dark']){
  await page.evaluate(({lang,theme})=>{localStorage.setItem('clarune.language',lang);localStorage.setItem('clarune.theme',theme);},{lang,theme});await page.reload();
  await page.getByTestId('original-file-input').setInputFiles(fixture);
  await page.getByTestId('nav-resize').click();await page.getByTestId('tool-file-input').setInputFiles([fixture,fixture,fixture]);
  await page.getByTestId('tool-preview-image').waitFor();
  for(const [width,height]of[[980,680],[1280,820],[1600,1000]]){
   await app.evaluate(({BrowserWindow},s)=>BrowserWindow.getAllWindows()[0].setContentSize(...s),[width,height]);
   for(const id of ['enhance','batch','resize','compress','crop','watermark','round','rotate','flip','pdf','history','models','settings']){
    await page.getByTestId('nav-'+id).click();
    if(id==='watermark'){await page.getByTestId('tool-watermark-text').fill('CLARUNE 澄像');await page.waitForTimeout(350);}
    const geom=await page.evaluate(()=>{
     const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
     const buttons=[...document.querySelectorAll('[data-testid="tool-export"],[data-testid="tool-batch-export"],[data-testid="pdf-export"]')].filter(visible);
     return {inner:[innerWidth,innerHeight],body:[document.body.scrollWidth,document.body.scrollHeight],buttons:buttons.map(e=>{const r=e.getBoundingClientRect();return{id:e.dataset.testid,right:r.right,bottom:r.bottom,x:r.x,y:r.y};}),main:document.querySelector('.main-stage').scrollWidth};
    });
    const label=`${lang}-${theme}-${width}-${id}`;checks.push({label,...geom});
    assert.ok(geom.body[0]<=geom.inner[0]+1&&geom.body[1]<=geom.inner[1]+3,label+' page overflow');
    for(const button of geom.buttons)assert.ok(button.right<=geom.inner[0]+1&&button.bottom<=geom.inner[1]+1&&button.x>=0&&button.y>=0,label+' clipped export '+button.id);
    if(width===980&&['batch','watermark','settings'].includes(id)||lang==='zh-CN'&&theme==='light'&&width===1280&&['enhance','crop','watermark','pdf'].includes(id))await page.screenshot({path:join(review,label+'.png')});
   }
  }
 }
 assert.equal(errors.length,0,errors.join('\n'));console.log(JSON.stringify({passed:checks.length,errors,work,exe}));
}catch(error){await page.screenshot({path:join(review,'failure.png')}).catch(()=>{});throw error;}
finally{await writeFile(join(review,'layout-regression.json'),JSON.stringify({date:new Date().toISOString(),exe,checks,errors},null,2));await app.close();}
