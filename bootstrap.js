/* SPDX-License-Identifier: MIT */
var controllers = new Map();
const HTML = 'http://www.w3.org/1999/xhtml';
const ZOOMS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
// PDF units are 1/72 inch; standard desktop 100% uses 96 CSS pixels per inch.
const PDF_TO_CSS = 96 / 72;
function unwrap(value) { return value?.wrappedJSObject || value; }
function realmObject(win, values) {
  // PDF.js runs in a different Firefox compartment. Give it objects from its own realm.
  let obj=new win.Object();for(let key of Object.keys(values))obj[key]=values[key];return obj;
}
function pageIndex(win,page) {
  let number=Number(page?.dataset?.pageNumber);
  if(Number.isInteger(number)&&number>0)return number-1;
  let pages=win.PDFViewerApplication.pdfViewer._pages || [];
  let index=Array.from(pages).findIndex(view=>view.div===page);
  if(index>=0)return index;
  return Array.from(win.document.querySelectorAll('#viewer .page')).indexOf(page);
}
function element(doc, tag, text) {
  let el = doc.createElementNS(HTML, tag);
  if (text) el.textContent = text;
  return el;
}
function pdfWindows(doc, result = [], depth = 0) {
  if (!doc || depth > 4) return result;
  try {
    let win = unwrap(doc.defaultView);
    if (win.PDFViewerApplication?.pdfViewer && doc.getElementById('viewerContainer')) result.push(win);
    for (let frame of doc.querySelectorAll('iframe')) pdfWindows(frame.contentDocument, result, depth + 1);
  } catch (error) { Zotero.debug('Magnifier: ' + error); }
  return result;
}
function cropRect(a, b, width, height) {
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  let x1 = clamp(a.x, width), y1 = clamp(a.y, height);
  let x2 = clamp(b.x, width), y2 = clamp(b.y, height);
  return {x:Math.min(x1,x2), y:Math.min(y1,y2), width:Math.abs(x2-x1), height:Math.abs(y2-y1)};
}
function control(doc, text, title, action) {
  let b = element(doc, 'button', text); b.type = 'button'; b.title = title;
  b.style.cssText = 'padding:4px 7px;min-width:26px;border:1px solid #8888;border-radius:4px;background:transparent;color:inherit;cursor:pointer;font:inherit';
  b.addEventListener('click', e => {e.preventDefault(); e.stopPropagation(); action();});
  // Zotero's reader forwards mouse events. Plain buttons avoid native select popups.
  for (let type of ['pointerdown','mousedown','dblclick']) b.addEventListener(type,e => e.stopPropagation());
  return b;
}
class Lens {
  constructor(win, owner) {
    this.win=win; this.doc=win.document; this.owner=owner; this.cleanups=[]; this.serial=0;
    this.shield=element(this.doc,'div');
    this.shield.style.cssText='position:fixed;z-index:2147483644;background:transparent;cursor:grab;touch-action:none;user-select:none;display:none';
    this.box=element(this.doc,'div');
    this.box.style.cssText='position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #4683d9;background:#4683d922;display:none;box-sizing:border-box';
    this.panel=element(this.doc,'section');
    this.panel.setAttribute('aria-label','选区放大预览');
    this.panel.style.cssText='position:fixed;z-index:2147483646;right:18px;top:18px;width:560px;max-width:calc(100vw - 36px);background:#fff;color:#222;border:1px solid #888;border-radius:8px;box-shadow:0 5px 24px #0006;display:none;overflow:hidden;font:13px sans-serif';
    this.bar=element(this.doc,'div');
    this.bar.style.cssText='display:flex;align-items:center;gap:6px;padding:7px;background:#f1f3f5;cursor:move;user-select:none;touch-action:none';
    this.title=element(this.doc,'span','选区放大'); this.title.style.cssText='flex:1';
    this.zoomLabel=element(this.doc,'span');
    this.bar.append(this.title,control(this.doc,'−','减小倍率',()=>owner.zoomBy(-1)),this.zoomLabel,
      control(this.doc,'＋','增大倍率',()=>owner.zoomBy(1)),control(this.doc,'重新框选','隐藏预览并重新框选',()=>this.hide()),
      control(this.doc,'×','关闭预览',()=>this.hide()));
    this.scroller=element(this.doc,'div');
    this.scroller.style.cssText='overflow:auto;max-height:calc(100vh - 130px);background:white';
    this.canvas=element(this.doc,'canvas'); this.canvas.style.cssText='display:block;max-width:none;';
    this.scroller.append(this.canvas); this.panel.append(this.bar,this.scroller);
    this.doc.body.append(this.shield,this.box,this.panel);
    for (let type of ['pointerdown','mousedown','mouseup','click','dblclick','contextmenu']) {
      this.listen(this.panel,type,e=>e.stopPropagation());
    }
    // Use mouse events end-to-end. Zotero's reader uses mouse events too, and some
    // embedded reader environments do not deliver the corresponding pointer events.
    this.listen(win,'mousedown',e=>this.down(e),true);
    this.listen(win,'mousemove',e=>this.move(e),true);
    this.listen(win,'mouseup',e=>this.up(e),true);
    this.listen(this.doc,'click',e=>{if(Date.now()<this.suppressUntil && !this.panel.contains(e.target))this.consume(e);},true);
    this.listen(this.doc,'selectstart',e=>{if(this.drag)this.consume(e);},true);
    this.listen(this.doc,'scroll',e=>{if(!this.panel.contains(e.target)){if(!this.drag)this.box.style.display='none';this.mode();}},true);
    this.listen(win,'blur',()=>{if(!this.doc.hasFocus())this.abort();});
    this.listen(win,'resize',()=>{this.abort();this.position();this.mode();});
    this.listen(this.doc,'keydown',e=>owner.key(e),true);
    this.listen(this.doc,'wheel',e=>{
      if(owner.enabled && e.altKey){this.consume(e);owner.zoomBy(e.deltaY<0?1:-1);}
      else if(owner.enabled && e.target===this.shield){
        if(e.ctrlKey||e.metaKey)return;
        this.consume(e);let container=this.doc.getElementById('viewerContainer');
        let unit=e.deltaMode===1?16:e.deltaMode===2?container.clientHeight:1;
        container.scrollTop+=e.deltaY*unit;container.scrollLeft+=e.deltaX*unit;
      }
    },{capture:true,passive:false});
    this.listen(this.bar,'mousedown',e=>{
      if(e.button!==0 || e.target.closest('button'))return;
      this.consume(e); let r=this.panel.getBoundingClientRect();
      this.panelDrag={x:e.clientX-r.left,y:e.clientY-r.top};
    });
    this.sync();this.mode();
  }
  listen(target,type,fn,opts){target.addEventListener(type,fn,opts);this.cleanups.push(()=>target.removeEventListener(type,fn,opts));}
  consume(e){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}
  mode(){
    let container=this.doc.getElementById('viewerContainer');
    if(!this.owner.enabled || !container){this.shield.style.display='none';return;}
    let r=container.getBoundingClientRect();
    Object.assign(this.shield.style,{display:'block',left:r.left+'px',top:r.top+'px',width:container.clientWidth+'px',height:container.clientHeight+'px'});
    this.win.getSelection()?.removeAllRanges();
  }
  cancel(){this.serial++;this.task?.cancel();this.task=null;}
  abort(){
    try{this.shield.releaseCapture?.();}catch(_){}
    this.drag=null;this.panelDrag=null;this.box.style.display='none';
    this.shield.style.cursor='grab';
  }
  hide(){this.cancel();this.abort();this.selection=null;this.panel.style.display='none';}
  point(e,rect){return{x:e.clientX-rect.left,y:e.clientY-rect.top};}
  down(e){
    if(!this.owner.enabled || e.button!==0 || this.panel.contains(e.target))return;
    // The shield intentionally hides text and canvas hit targets. Locate the PDF
    // canvas geometrically, rather than trying to hit-test through this shield.
    let page,source;
    for(let candidate of this.doc.querySelectorAll('#viewer .page')){
      let canvas=candidate.querySelector('.canvasWrapper canvas') || candidate.querySelector('canvas');
      if(!canvas)continue;
      let r=canvas.getBoundingClientRect();
      if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom){page=candidate;source=canvas;break;}
    }
    if(!source)return;
    let rect=source.getBoundingClientRect(),point=this.point(e,rect);
    if(point.x<0||point.y<0||point.x>rect.width||point.y>rect.height)return;
    this.consume(e);this.hide();this.owner.lenses.forEach(l=>{if(l!==this)l.hide();});
    this.drag={page,source,rect,start:point};this.shield.style.cursor='grabbing';
    this.win.getSelection()?.removeAllRanges();
    try{this.shield.setCapture?.(false);}catch(_){}
    this.move(e);
  }
  move(e){
    if(this.panelDrag){
      this.consume(e);this.panel.style.right='auto';
      let r=this.panel.getBoundingClientRect();
      this.panel.style.left=Math.max(0,Math.min(this.win.innerWidth-r.width,e.clientX-this.panelDrag.x))+'px';
      this.panel.style.top=Math.max(0,Math.min(this.win.innerHeight-45,e.clientY-this.panelDrag.y))+'px';return;
    }
    if(!this.drag)return;
    if(e.buttons===0){this.abort();return;}
    this.consume(e);let d=this.drag;
    d.rect=d.source.getBoundingClientRect();
    let c=cropRect(d.start,this.point(e,d.rect),d.rect.width,d.rect.height);
    this.box.style.display='block';this.box.style.left=d.rect.left+c.x+'px';this.box.style.top=d.rect.top+c.y+'px';
    this.box.style.width=c.width+'px';this.box.style.height=c.height+'px';
  }
  async up(e){
    if(this.panelDrag){this.panelDrag=null;return;}
    if(!this.drag)return;
    this.consume(e);this.suppressUntil=Date.now()+350;
    let d=this.drag,c=cropRect(d.start,this.point(e,d.rect),d.rect.width,d.rect.height);
    this.abort();
    if(c.width<5 || c.height<5)return;
    // Store page-relative coordinates so changing the main PDF zoom won't shift the crop.
    this.shield.style.cursor='grab';
    let token=++this.serial;
    try{
      let index=pageIndex(this.win,d.page),app=this.win.PDFViewerApplication;
      if(index<0)throw new Error('无法定位所选 PDF 页');
      let view=app.pdfViewer.getPageView(index);
      let pdf=view?.pdfPage || await app.pdfDocument.getPage(index+1);
      if(token!==this.serial || !this.owner.enabled)return;
      let rotation=view?.viewport?.rotation ?? pdf.rotate ?? 0;
      let natural=pdf.getViewport(realmObject(this.win,{scale:PDF_TO_CSS,rotation}));
      this.selection={page:d.page,source:d.source,pdf,rotation,x:c.x/d.rect.width,y:c.y/d.rect.height,w:c.width/d.rect.width,h:c.height/d.rect.height,naturalWidth:natural.width,naturalHeight:natural.height};
      this.panel.style.display='block';this.refresh();
    }catch(error){this.error(error);}
  }
  position(){
    this.panel.style.width=Math.min(this.owner.size,this.win.innerWidth-36)+'px';
    if(this.panel.style.left){let r=this.panel.getBoundingClientRect();this.panel.style.left=Math.max(0,Math.min(r.left,this.win.innerWidth-r.width))+'px';}
    if(this.panel.style.top){let r=this.panel.getBoundingClientRect();this.panel.style.top=Math.max(0,Math.min(r.top,this.win.innerHeight-45))+'px';}
  }
  sync(){this.zoomLabel.textContent=Math.round(this.owner.zoom*100)+'%';this.position();}
  refresh(){
    this.sync();if(!this.selection)return;
    this.cancel();let s=this.selection,zoom=this.owner.zoom;
    // Limit pixel allocation for very large selections without changing the displayed multiplier.
    let cssWidth=s.w*s.naturalWidth*zoom,cssHeight=s.h*s.naturalHeight*zoom;
    let dpr=Math.min(this.win.devicePixelRatio||1,2,4096/Math.max(cssWidth,cssHeight),Math.sqrt(16000000/(cssWidth*cssHeight)));
    this.canvas.width=Math.max(1,Math.round(cssWidth*dpr));this.canvas.height=Math.max(1,Math.round(cssHeight*dpr));
    this.canvas.style.width=cssWidth+'px';this.canvas.style.height=cssHeight+'px';
    let ctx=this.canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
    ctx.drawImage(s.source,s.x*s.source.width,s.y*s.source.height,s.w*s.source.width,s.h*s.source.height,0,0,this.canvas.width,this.canvas.height);
    this.title.textContent='选区放大 · 独立倍率';
    this.render(s,dpr,zoom,this.serial);
  }
  async render(s,dpr,zoom,token){
    try{
      let pdf=s.pdf;
      if(!pdf || token!==this.serial)return;
      let viewport=pdf.getViewport(realmObject(this.win,{scale:PDF_TO_CSS*zoom*dpr,rotation:s.rotation}));
      let temp=element(this.doc,'canvas');temp.width=this.canvas.width;temp.height=this.canvas.height;
      let transform=new this.win.Array(1,0,0,1,-s.x*viewport.width,-s.y*viewport.height);
      let task=pdf.render(realmObject(this.win,{canvasContext:temp.getContext('2d'),viewport,transform,background:'#ffffff'}));
      this.task=task;await task.promise;
      if(token===this.serial && this.owner.enabled)this.canvas.getContext('2d').drawImage(temp,0,0);
      if(this.task===task)this.task=null;
    }catch(error){if(error.name!=='RenderingCancelledException')this.error(error);}
  }
  error(error){Zotero.logError(error);this.win.alert('框选放大失败：'+(error.message||error)+'\n请将此错误文字反馈给开发者。');}
  destroy(){this.hide();this.cleanups.forEach(fn=>fn());this.panel.remove();this.box.remove();this.shield.remove();}
}
class Controller {
  constructor(reader,doc,append){
    this.reader=reader;this.doc=doc;this.enabled=false;this.lenses=new Map();
    let saved=Number(Zotero.Prefs.get('extensions.zoteroMagnifier.absoluteZoom',true));this.zoom=ZOOMS.includes(saved)?saved:2;
    this.size=560;
    this.root=element(doc,'div');this.root.style.cssText='display:flex;align-items:center;gap:4px;padding:0 5px;font:12px sans-serif';
    this.button=control(doc,'框选放大','开启后在 PDF 页面拖动框选（Alt+M，Esc 退出）',()=>this.toggle());
    this.button.setAttribute('aria-pressed','false');
    this.label=element(doc,'span');this.label.style.cssText='min-width:30px;text-align:center';
    this.sizeButton=control(doc,'窗口：中','切换预览窗口宽度：小 / 中 / 大',()=>{
      let values=[360,560,760];this.size=values[(values.indexOf(this.size)+1)%values.length];this.sync();
    });
    this.root.append(this.button,control(doc,'−','减小倍率',()=>this.zoomBy(-1)),this.label,
      control(doc,'＋','增大倍率',()=>this.zoomBy(1)),this.sizeButton);append(this.root);
    this.onKey=e=>this.key(e);doc.addEventListener('keydown',this.onKey,true);
    this.onUnload=()=>{this.destroy();controllers.delete(reader);};doc.defaultView.addEventListener('unload',this.onUnload,{once:true});
    this.observer=new doc.defaultView.MutationObserver(()=>this.scan());this.observer.observe(doc.body,{childList:true,subtree:true});
    this.sync();this.scan();
  }
  scan(){
    let current=new Set(pdfWindows(this.doc));
    for(let [win,lens]of this.lenses)if(!current.has(win)){lens.destroy();this.lenses.delete(win);}
    for(let win of current)if(!this.lenses.has(win))this.lenses.set(win,new Lens(win,this));
  }
  sync(){this.label.textContent=Math.round(this.zoom*100)+'%';this.label.title='预览独立缩放，不受主页面缩放影响';this.sizeButton.textContent='窗口：'+({360:'小',560:'中',760:'大'}[this.size]);this.lenses.forEach(l=>l.refresh());}
  hide(){this.lenses.forEach(l=>l.hide());}
  setHand(enabled){
    let internal=unwrap(this.reader._internalReader);
    if(!internal?.setTool)return;
    if(enabled){this.previousTool=internal.toolType || internal._state?.tool?.type || 'pointer';}
    let type=enabled?'hand':this.previousTool;
    if(!type)return;
    let win=unwrap(this.reader._iframeWindow || this.doc.defaultView);
    internal.setTool(realmObject(win,{type}));
    if(!enabled)this.previousTool=null;
  }
  toggle(){
    this.scan();if(!this.lenses.size){this.doc.defaultView.alert('PDF 尚未加载完成，请稍后再开启框选放大。');return;}
    this.enabled=!this.enabled;
    try{this.setHand(this.enabled);}catch(error){Zotero.logError(error);}
    this.button.setAttribute('aria-pressed',String(this.enabled));this.button.style.background=this.enabled?'#4683d933':'transparent';this.hide();this.lenses.forEach(l=>l.mode());
  }
  zoomBy(delta){let idx=ZOOMS.indexOf(this.zoom);this.zoom=ZOOMS[Math.max(0,Math.min(ZOOMS.length-1,idx+(delta>0?1:-1)))];Zotero.Prefs.set('extensions.zoteroMagnifier.absoluteZoom',this.zoom,true);this.sync();}
  key(e){
    if(e.target.closest?.('input,textarea,select,[contenteditable="true"]'))return;
    if((e.altKey&&!e.ctrlKey&&!e.metaKey&&e.code==='KeyM')||(e.key==='Escape'&&this.enabled)){e.preventDefault();e.stopPropagation();this.toggle();}
  }
  destroy(){if(this.enabled){try{this.setHand(false);}catch(error){Zotero.debug(String(error));}}this.observer.disconnect();this.lenses.forEach(l=>l.destroy());this.lenses.clear();this.doc.removeEventListener('keydown',this.onKey,true);this.doc.defaultView.removeEventListener('unload',this.onUnload);this.root.remove();}
}
function toolbar({reader,doc,append}){if(reader.type&&reader.type!=='pdf')return;controllers.get(reader)?.destroy();controllers.set(reader,new Controller(reader,doc,append));}
async function startup({id}){await Zotero.uiReadyPromise;Zotero.Reader.registerEventListener('renderToolbar',toolbar,id);}
function shutdown(){Zotero.Reader.unregisterEventListener('renderToolbar',toolbar);controllers.forEach(c=>c.destroy());controllers.clear();}
function install(){}
function uninstall(){}
