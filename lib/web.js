// 网页版 / 桌面版 DSH 的管理页面。
// dsh-go 手机端用原生面板，Harness Web（含桌面端内嵌的同一套界面）没有面板，
// 所以在宿主自带的 webServer 上开一个同源页面：http://127.0.0.1:<web 端口>/modelscope-pool
// 页面只读同源 JSON，不跨域；只接受本机回环地址，避免局域网里被人看到令牌。

const PAGE_PATH = '/modelscope-pool'

const HTML = [
  '<!doctype html>',
  '<html lang="zh-CN"><head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<title>ModelScope key pool</title>',
  '<style>',
  ':root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14171d;--muted:#6b7280;--line:#e5e7eb;--accent:#0f766e;--accent-fg:#fff;--good:#15803d;--warn:#a16207;--bad:#b91c1c;--chip:#eef1f5}',
  '@media (prefers-color-scheme:dark){:root{--bg:#14161a;--card:#1c1f25;--fg:#e9ebef;--muted:#9aa1ad;--line:#2b3038;--accent:#2dd4bf;--accent-fg:#0b0d10;--good:#4ade80;--warn:#fbbf24;--bad:#f87171;--chip:#242932}}',
  '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,system-ui,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;padding:0 14px 40px}',
  '.wrap{max-width:760px;margin:0 auto}',
  'header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:14px 0 10px;background:linear-gradient(var(--bg) 78%,transparent)}',
  'header h1{margin:0;font-size:19px;font-weight:650;letter-spacing:.2px}',
  'header .sub{margin:2px 0 0;color:var(--muted);font-size:12px}',
  'header .grow{flex:1;min-width:0}',
  '.ghost{background:var(--chip);border:1px solid var(--line);color:var(--fg);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px}',
  '.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:6px 0 14px}',
  '.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 13px}',
  '.card b{display:block;font-size:24px;line-height:1.15;font-weight:680;font-variant-numeric:tabular-nums}',
  '.card span{display:block;margin-top:2px;color:var(--muted);font-size:12px}',
  '.card.ok b{color:var(--good)}.card.warn b{color:var(--warn)}.card.info b{color:var(--accent)}',
  '.magic{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 13px;margin-bottom:14px}',
  '.magic .row{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:var(--muted)}',
  '.magic .row b{color:var(--fg);font-weight:600;font-size:13px}',
  '.bar{height:9px;border-radius:99px;background:var(--chip);overflow:hidden;margin-top:9px}',
  '.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 55%,#fff));transition:width .35s ease}',
  '.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}',
  'button{font:inherit;border-radius:11px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:9px 14px;cursor:pointer}',
  'button:active{transform:scale(.985)}',
  'button.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}',
  '.tablewrap{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}',
  'table{width:100%;border-collapse:collapse;font-size:13.5px}',
  'thead th{position:sticky;top:0;background:var(--card);color:var(--muted);font-weight:500;font-size:12px;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}',
  'tbody td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}',
  'tbody tr:last-child td{border-bottom:0}',
  'tbody tr:nth-child(even){background:color-mix(in srgb,var(--chip) 45%,transparent)}',
  '.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}',
  '.ok{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}',
  'td.ops{text-align:right;white-space:nowrap}',
  'td.ops button{padding:5px 9px;font-size:12px;border-radius:8px;margin-left:5px;background:transparent}',
  'td.ops button:hover{background:var(--chip)}',
  'td.ops button.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}',
  '.pager{display:flex;align-items:center;justify-content:center;gap:12px;margin:12px 0 18px;color:var(--muted);font-size:13px}',
  '.pager button{padding:7px 14px}',
  '.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px;margin-bottom:14px}',
  '.panel h2{margin:0 0 9px;font-size:14px;font-weight:600}',
  'textarea,select{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:11px;padding:10px 12px;font:inherit;font-size:14px}',
  'textarea{min-height:86px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}',
  '.panel .foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:9px}',
  '.panel .foot span{color:var(--muted);font-size:12px}',
  '.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);background:var(--fg);color:var(--bg);padding:10px 18px;border-radius:999px;font-size:13px;opacity:0;transition:opacity .18s,transform .18s;pointer-events:none;max-width:90vw;z-index:20}',
  '.toast.on{opacity:.96;transform:translateX(-50%) translateY(0)}',
  '@media (max-width:430px){.cards{grid-template-columns:repeat(3,1fr);gap:8px}.card{padding:10px}.card b{font-size:20px}td.ops button{padding:5px 7px;margin-left:4px}}',
  '</style></head><body><div class="wrap">',
  '<header><div class="grow"><h1 id="title">魔搭 Key 池</h1><p class="sub" id="sub"></p></div>',
  '<button class="ghost" id="b-lang">English</button></header>',
  '<section class="cards">',
  '<div class="card ok"><b id="s-ok">–</b><span id="l-ok"></span></div>',
  '<div class="card warn"><b id="s-cool">–</b><span id="l-cool"></span></div>',
  '<div class="card info"><b id="s-magic">–</b><span id="l-magic"></span></div>',
  '</section>',
  '<section class="magic"><div class="row"><b id="magic-label"></b><span id="magic-cap"></span></div>',
  '<div class="bar"><i id="bar" style="width:0"></i></div></section>',
  '<div class="toolbar">',
  '<button class="pri" data-act="refresh" id="b-refresh"></button>',
  '<button data-act="test" id="b-test"></button>',
  '<button data-act="restoreAll" id="b-restore"></button>',
  '</div>',
  '<div class="tablewrap"><table><thead><tr id="head"></tr></thead><tbody id="rows"></tbody></table></div>',
  '<div class="pager"><button id="b-prev"></button><span id="page-info"></span><button id="b-next"></button></div>',
  '<section class="panel"><h2 id="add-sum"></h2>',
  '<textarea id="add-text" placeholder="ms-..."></textarea>',
  '<div class="foot"><span id="add-hint"></span><button class="pri" id="b-add"></button></div></section>',
  '<section class="panel"><h2 id="model-sum"></h2><select id="model-sel"></select></section>',
  '<div class="toast" id="toast"></div>',
  '</div>',
  '<script>',
  'var L=null,S=null,PAGE=0,PER=20,ARM="";',
  'var DICT={',
  ' zh:{title:"魔搭 Key 池",sub:"本页只在 127.0.0.1 上可用；Key 不会离开这台设备。",',
  ' ok:"可用",cool:"冷却",magic:"魔粒",left:"剩余",total:"共",refresh:"刷新额度",test:"测试全部",restoreAll:"全部恢复",',
  ' prev:"上一页",next:"下一页",add:"添加",addSum:"添加 Key（一行一个）",modelSum:"默认模型",',
  ' id:"Key",site:"站点",state:"状态",quota:"额度",ops:"操作",',
  ' disable:"禁用",stop:"停用",restore:"恢复",del:"删除",delAgain:"再点一次",',
  ' ai:"国际版",cn:"国内版",none:"—",empty:"还没有 Key",',
  ' copied:"已刷新",added:"已添加",saved:"已保存",failed:"操作失败",lang:"English"},',
  ' en:{title:"ModelScope keys",sub:"This page only answers on 127.0.0.1; keys never leave this device.",',
  ' ok:"Ready",cool:"Cooling",magic:"Magicubes",left:"left",total:"of",refresh:"Refresh quota",test:"Test all",restoreAll:"Restore all",',
  ' prev:"Prev",next:"Next",add:"Add",addSum:"Add keys (one per line)",modelSum:"Default model",',
  ' id:"Key",site:"Site",state:"State",quota:"Quota",ops:"Actions",',
  ' disable:"Disable",stop:"Pause",restore:"Restore",del:"Delete",delAgain:"Tap again",',
  ' ai:"International",cn:"China",none:"—",empty:"No keys yet",',
  ' copied:"Refreshed",added:"Added",saved:"Saved",failed:"Action failed",lang:"中文"}};',
  'var RSN={"额度不足":["额度不足","Out of quota"],"额度用尽":["额度用尽","Quota exhausted"],"令牌无效":["令牌无效","Invalid token"],"被限流":["被限流","Rate limited"],"模型名不可用":["模型名不可用","Model unavailable"],"上游超时":["上游超时","Upstream timeout"],"读取请求失败":["读取请求失败","Request failed"],"冷却中":["冷却中","Cooling down"],"手动禁用":["手动禁用","Disabled"],"手动停用":["手动停用","Paused"]};',
  'function rsn(r){if(!r)return "";var x=RSN[r];return x?(L===DICT.en?x[1]:x[0]):r}',
  'function t(k){return (L&&L[k])||k}',
  'function pickLang(){try{var s=localStorage.getItem("ms-lang");if(s==="zh"||s==="en")return s}catch(e){}',
  ' var n=(navigator.language||"zh").toLowerCase();return n.indexOf("zh")===0?"zh":"en"}',
  'function setLang(x){L=DICT[x];try{localStorage.setItem("ms-lang",x)}catch(e){}',
  ' document.documentElement.lang=x==="zh"?"zh-CN":"en";',
  ' document.querySelectorAll("[id^=b-lang]").forEach(function(b){b.textContent=L.lang});render()}',
  'function toast(m){var el=document.getElementById("toast");el.textContent=m;el.classList.add("on");',
  ' clearTimeout(window.__t);window.__t=setTimeout(function(){el.classList.remove("on")},2200)}',
  'function fmt(ms){if(!ms)return "";var d=new Date(ms);function p(n){return n<10?"0"+n:""+n}',
  ' return p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes())}',
  'function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}',
  'function render(){',
  ' if(!S||!L)return;',
  ' document.getElementById("title").textContent=L.title;',
  ' document.getElementById("sub").textContent=L.sub;',
  ' document.getElementById("s-ok").textContent=S.available;',
  ' document.getElementById("s-cool").textContent=S.cooling;',
  ' document.getElementById("s-magic").textContent=S.magic.left;',
  ' document.getElementById("l-ok").textContent=L.ok;',
  ' document.getElementById("l-cool").textContent=L.cool;',
  ' document.getElementById("l-magic").textContent=L.magic;',
  ' var pct=S.magic.total>0?Math.max(0,Math.min(100,S.magic.left/S.magic.total*100)):0;',
  ' document.getElementById("bar").style.width=pct.toFixed(1)+"%";',
  ' document.getElementById("magic-label").textContent=L.usage;',
  ' document.getElementById("magic-cap").textContent=L.left+" "+S.magic.left+" / "+L.total+" "+S.magic.total;',
  ' document.getElementById("add-hint").textContent=L.addHint;',
  ' document.getElementById("b-refresh").textContent=L.refresh;',
  ' document.getElementById("b-test").textContent=L.test;',
  ' document.getElementById("b-restore").textContent=L.restoreAll;',
  ' document.getElementById("b-prev").textContent=L.prev;',
  ' document.getElementById("b-next").textContent=L.next;',
  ' document.getElementById("b-add").textContent=L.add;',
  ' var pg=document.getElementById("page-info");',
  ' if(pg){var total=Math.max(1,Math.ceil(S.keys.length/PER));pg.textContent=L.page.replace("{p}",String(PAGE+1)).replace("{n}",String(total))}',
  ' document.getElementById("add-sum").textContent=L.addSum;',
  ' document.getElementById("model-sum").textContent=L.modelSum;',
  ' var head=document.getElementById("head");head.innerHTML="";',
  ' [L.id,L.site,L.state,L.quota,L.ops].forEach(function(h){head.appendChild(el("th",null,h))});',
  ' var body=document.getElementById("rows");body.innerHTML="";',
  ' var maxPage=Math.max(0,Math.ceil(S.keys.length/PER)-1);PAGE=Math.min(PAGE,maxPage);',
  ' var slice=S.keys.slice(PAGE*PER,PAGE*PER+PER);',
  ' if(!slice.length){var tr=el("tr");var td=el("td","muted",L.empty);td.colSpan=5;tr.appendChild(td);body.appendChild(tr)}',
  ' slice.forEach(function(k){',
  '  var tr=el("tr");',
  '  tr.appendChild(el("td","mono",k.id+" "+k.masked));',
  '  tr.appendChild(el("td",null,k.region==="ai"?L.ai:k.region==="cn"?L.cn:L.none));',
  '  var st=el("td",k.state==="ok"?"ok":k.manual?"bad":"warn");',
  '  st.textContent=k.state==="ok"?L.ok:(k.manual?L.disable:rsn(k.reason)||L.cool)+(k.untilAt?" "+fmt(k.untilAt):"");',
  '  tr.appendChild(st);',
  '  var q=el("td",null,k.quota&&k.quota.ok?(k.quota.available+" / "+k.quota.total):L.none);',
  '  tr.appendChild(q);',
  '  var ops=el("td","ops");',
  '  function mk(act,label,cls){var b=el("button",cls,label);b.onclick=function(){act(k.id,label)};ops.appendChild(b);return b}',
  '  if(k.state==="ok"||k.manual){mk(actDisable,L.disable)} else {mk(actRestore,L.restore)}',
  '  mk(actStop,L.stop);',
  '  var delBtn=mk(actDelete,ARM===k.id?L.delAgain:L.del);',
  '  tr.appendChild(ops);',
  '  body.appendChild(tr);',
  ' });',
  ' var sel=document.getElementById("model-sel");sel.innerHTML="";',
  ' S.models.slice(0,400).forEach(function(m){var o=el("option",null,m.name);o.value=m.id;if(m.id===S.model)o.selected=true;sel.appendChild(o)});',
  '}',
  'function post(action,payload){',
  ' var body=Object.assign({action:action},payload||{});',
  ' return fetch("' + PAGE_PATH + '/api/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})',
  '  .then(function(r){return r.json()}).then(function(j){if(j.message)toast(j.message);return load()})',
  '  .catch(function(){toast(L.failed)})',
  '}',
  'function actDisable(id){post("disable",{id:id})}',
  'function actStop(id){post("stop",{id:id})}',
  'function actRestore(id){post("restore",{id:id})}',
  'function actDelete(id){if(ARM!==id){ARM=id;render();return}ARM="";post("remove",{id:id})}',
  'function load(){',
  ' return fetch("' + PAGE_PATH + '/api/state").then(function(r){if(!r.ok)throw 0;return r.json()})',
  '  .then(function(j){S=j;render()}).catch(function(){})',
  '}',
  'document.addEventListener("click",function(e){',
  ' var a=e.target&&e.target.getAttribute&&e.target.getAttribute("data-act");',
  ' if(a){post(a);return}',
  ' if(e.target.id==="b-prev"){if(PAGE>0){PAGE--;render()}return}',
  ' if(e.target.id==="b-next"){if((PAGE+1)*PER<S.keys.length){PAGE++;render()}return}',
  ' if(e.target.id==="b-add"){var v=document.getElementById("add-text").value;',
  '  if(!v.trim())return;post("add",{value:v}).then(function(){document.getElementById("add-text").value=""});return}',
  ' if(e.target.id==="b-lang"){setLang(L===DICT.zh?"en":"zh");return}',
  '});',
  'document.addEventListener("change",function(e){',
  ' if(e.target.id==="model-sel")post("setModel",{value:e.target.value});',
  '});',
  'setLang(pickLang());load();setInterval(load,4000);',
  '</script></body></html>',
].join('\n')

const isLoopback = (req) => {
  const ip = String(req.socket?.remoteAddress ?? '')
  return ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.')
}

const send = (res, status, type, body, extra) => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

const sendJson = (res, status, value) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))

const readBody = (req) =>
  new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let value = null
      try {
        value = text ? JSON.parse(text) : null
      } catch {}
      resolve(value)
    })
    req.on('error', () => resolve(null))
  })

/**
 * 在宿主的 webServer 上挂一个同源管理页。
 * @param webServer 宿主注入的 webServer 服务
 * @param options.getState () => 状态对象
 * @param options.doAction (action, payload) => Promise<string> 返回一行提示
 */
export function registerWebAdmin(webServer, { getState, doAction, logger }) {
  const route = {
    kind: 'prefix',
    path: PAGE_PATH,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'loopback only' })
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
      const rest = url.pathname.slice(PAGE_PATH.length).replace(/\/+$/, '')

      if (rest === '' || rest === '/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        send(res, 200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : HTML, {
          'x-frame-options': 'SAMEORIGIN',
          'referrer-policy': 'no-referrer',
        })
        return
      }

      if (rest === '/api/state') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, getState())
        } catch (error) {
          logger?.warn?.(`modelscope-pool: 网页状态读取失败 ${String(error?.message ?? error)}`)
          sendJson(res, 500, { error: 'state failed' })
        }
        return
      }

      if (rest === '/api/action') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const body = await readBody(req)
        if (!body || typeof body.action !== 'string') {
          sendJson(res, 400, { error: 'bad request' })
          return
        }
        try {
          const message = await doAction(body.action, body)
          sendJson(res, 200, { ok: true, message: message ?? '' })
        } catch (error) {
          logger?.warn?.(`modelscope-pool: 网页操作失败 ${String(error?.message ?? error)}`)
          sendJson(res, 200, { ok: false, message: String(error?.message ?? error) })
        }
        return
      }

      sendJson(res, 404, { error: 'not found' })
    },
  }
  return webServer.register(route)
}

export const WEB_ADMIN_PATH = PAGE_PATH